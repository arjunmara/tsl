// Story 2.2 Registration link check: a Team manager opens /register#<token> (Turnstile, anonymous sign-in under its own
// storage key, redeem), edits Team name, code and kit colour through the outbox, offline included; bad, dead and closed
// links; and an Organiser session in the same browser that never mixes with it. Every UI row of the spec's I/O matrix,
// in real Chrome with Supabase and Turnstile mocked by route interception. `npm run check:register`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'
import { formatDay } from '../src/domain/format.ts'

const SUPA = 'https://fake.supabase.co'
const ORG = '00000000-0000-4000-8000-000000000001'
const ANON = '00000000-0000-4000-8000-0000000000a1'
const TEAM = '55555555-0000-4000-8000-000000000001'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const OPEN_DAY = '2033-11-03'
const outDir = 'node_modules/.register-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4188 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session(id, anonymous) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const email = anonymous ? '' : 'org@example.com'
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, email, exp, role: 'authenticated', aud: 'authenticated', is_anonymous: anonymous })}.sig`
  const user = { id, aud: 'authenticated', role: 'authenticated', email, is_anonymous: anonymous, app_metadata: {}, user_metadata: {},
    identities: [], created_at: '2026-11-08T00:00:00Z', ...(anonymous ? {} : { email_confirmed_at: '2026-11-08T00:00:00Z' }) }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: `rt-${id}`, user }
}
/** The user id in a request's bearer token. */
const subOf = (req) => {
  const jwt = (req.headers().authorization ?? '').replace('Bearer ', '')
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub ?? null
  } catch {
    return null
  }
}

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/**
 * A context. mock.team: the granted Team (null: no grant); mock.form: the registration_form row; mock.dead: the link was
 * revoked (redeem and reads say so); mock.down: Supabase unreachable; mock.calls: every rpc body with cmd and sub (the
 * caller); mock.signups: anonymous sign-in bodies; mock.answers[cmd]: answers to give first. organiser: an Organiser is
 * signed in on this browser too.
 */
async function fresh({ deadline = OPEN_DAY, status = 'registration', organiser = false } = {}) {
  const mock = {
    team: { id: TEAM, name: 'Friends Sporting Wing', code: 'FSW', kit_colour: null, status: 'invited', version: 1 },
    form: { tournament_name: 'Gulmi Cup', season_number: 1, season_status: status, registration_deadline: deadline },
    dead: false, down: false, calls: [], signups: [], answers: {},
  }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  await context.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({
    contentType: 'text/javascript', body: `window.turnstile = { render(el, o) { setTimeout(() => o.callback('tok')); return 'w' }, remove() {} }`,
  }))
  const json = (route, data, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/auth/v1/signup') {
      mock.signups.push(JSON.parse(req.postData() ?? '{}'))
      return json(route, session(ANON, true))
    }
    return json(route, session(subOf(req) ?? ORG, subOf(req) === ANON))
  })
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    const sub = subOf(req)
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    // RLS: only the anonymous session's live grant reads the Team and the form; an Organiser reads its own lists.
    const granted = sub === ANON && !mock.dead
    if (path === '/rest/v1/team') return json(route, granted ? [mock.team] : [])
    if (path === '/rest/v1/rpc/registration_form') return json(route, granted ? [mock.form] : [])
    if (path === '/rest/v1/tournament') return json(route, [])
    // The Squad (Story 2.3): empty here; squad.check.mjs covers it.
    if (path === '/rest/v1/squad_entry' || path === '/rest/v1/staff' || path === '/rest/v1/rpc/registration_eligibility') return json(route, [])
    if (path === '/rest/v1/rpc/registration_rules') {
      return json(route, granted ? [{ consent_statement: 'Photos may be used.', starters: 5, max_bench: 9, staff_roles: ['manager'] }] : [])
    }
    const a = JSON.parse(req.postData() ?? '{}')
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd, sub })
    const given = mock.answers[cmd]?.shift()
    if (given) return json(route, given)
    if (cmd === 'redeem_registration_link') {
      return json(route, mock.dead || a.token !== TOKEN ? { ok: false, code: 'link_dead', message: 'No.' } : { ok: true, code: null, team_id: TEAM })
    }
    if (cmd === 'edit_team') {
      if (sub !== ANON || mock.dead) return json(route, { ok: false, code: 'not_authorized', message: 'No.' })
      for (const k of ['name', 'code', 'kit_colour']) if (a[k] != null) mock.team[k] = a[k]
      mock.team.version += 1
      return json(route, { ok: true, code: null, message: 'Team updated.', version: mock.team.version })
    }
    return json(route, { ok: true, code: null, message: 'Done.' })
  })
  if (organiser) await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session(ORG, false)))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, mock, page }
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
const text = (page, t) => page.getByText(t, { exact: true })
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const noScroll = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
const open = (page, token = TOKEN) => page.goto(`${base}/register#${token}`)
const edit = async (page, label, value) => {
  await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByLabel(label, { exact: true }).blur()
}
/** Sets the native colour picker as a person would: input while choosing, change when it closes. */
const pickColour = (page, value) => page.getByLabel('Kit colour', { exact: true }).evaluate((el, v) => {
  // Through the prototype setter, so React sees an input as from a person (its value tracker isn't updated).
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}, value)
const stored = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => /auth/.test(k)).sort())
const outbox = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('tsl-outbox')
  r.onsuccess = () => {
    const q = r.result.transaction('entries').objectStore('entries').getAll()
    q.onsuccess = () => res(q.result.map((e) => ({ name: e.name, state: e.state, actor: e.actor })))
  }
}))
const openBanner = `Open until ${formatDay(OPEN_DAY)}.`

try {
  assert.equal(formatDay('2026-11-03'), 'Kartik 17, 2083 BS (3 Nov 2026)')

  // --- Open: Turnstile, anonymous sign-in under its own key, redeem, then only this Team's form. Sealed: no link, tab,
  // App bar or Settings anywhere on the page.
  {
    const { context, mock, page } = await fresh()
    await open(page)
    await text(page, openBanner).waitFor()
    await text(page, 'After that this form can only be read.').waitFor()
    await text(page, 'Gulmi Cup · Season 1').waitFor()
    assert.equal(mock.signups.length, 1)
    assert.equal(mock.signups[0].gotrue_meta_security?.captcha_token, 'tok', 'anonymous sign-in without the Turnstile token')
    const [r] = calls(mock, 'redeem_registration_link')
    assert.deepEqual([r.token, r.sub], [TOKEN, ANON])
    assert.equal(await page.getByLabel('Team name', { exact: true }).inputValue(), 'Friends Sporting Wing')
    assert.equal(await page.getByLabel('Team code', { exact: true }).inputValue(), 'FSW')
    assert.equal(await page.locator('.ui-kit-dot').count(), 1)
    assert.deepEqual(await stored(page), ['tsl-register-auth'], 'session not under the link route key')
    assert.equal(await page.locator('a, [role="tab"], nav').count(), 0, 'a link, tab or navigation on the sealed page')
    // Only the Squad's own buttons (Story 2.3); none leads anywhere else.
    const squad = ['Add this Player', 'Add this Staff member', 'Send this Team for review']
    for (const b of await page.getByRole('button').allTextContents()) assert.ok(squad.includes(b), `button on the open form: ${b}`)
    const banner = await page.locator('.deadline-banner').evaluate((el) => getComputedStyle(el).borderTopWidth)
    assert.equal(banner, '2px')
    await noScroll(page)

    // Edits: each field saves on leaving it, through the outbox (scope and base version: the Team), as the anonymous user.
    await edit(page, 'Team name', 'Friends Sporting Wing FC')
    await until(page, async () => calls(mock, 'edit_team').length === 1, 'name not sent')
    await edit(page, 'Team code', 'fsw1')
    await until(page, async () => calls(mock, 'edit_team').length === 2, 'code not sent')
    await page.getByLabel('Kit colour', { exact: true }).focus()
    await page.getByLabel('Kit colour', { exact: true }).blur()
    await page.waitForTimeout(300)
    assert.equal(calls(mock, 'edit_team').length, 2, 'untouched picker saved a colour')
    await pickColour(page, '#ffd700')
    await until(page, async () => calls(mock, 'edit_team').length >= 3, 'kit colour not sent')
    const [n, c, k] = calls(mock, 'edit_team')
    assert.deepEqual([n.team_id, n.name, n.expected_version, n.sub], [TEAM, 'Friends Sporting Wing FC', 1, ANON])
    assert.deepEqual([c.code, c.expected_version], ['FSW1', 2])
    assert.deepEqual([k.kit_colour, k.expected_version], ['#ffd700', 3])
    assert.equal(await page.locator('.register-kit .ui-kit-dot').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 215, 0)')
    assert.equal(await page.locator('.register-kit .ui-kit-dot').evaluate((el) => getComputedStyle(el).borderTopWidth), '2px')
    await until(page, async () => (await page.getByLabel('Team code', { exact: true }).inputValue()) === 'FSW1', 'code not shown upper-case')

    // A code another Team uses: said beside the field, and the change is dropped (nothing waits).
    mock.answers.edit_team = [{ ok: false, code: 'team_code_taken', message: 'No.' }]
    await edit(page, 'Team code', 'YET')
    await text(page, 'That Team code is already used in this Season. Choose another code.').waitFor()
    await until(page, async () => (await outbox(page)).length === 0, 'refused change kept')
    await until(page, async () => (await page.getByLabel('Team code', { exact: true }).inputValue()) === 'FSW1', 'refused code still shown')

    // A form check stops a bad code before sending.
    const sent = calls(mock, 'edit_team').length
    await edit(page, 'Team code', 'X')
    await text(page, 'A Team code is 2 to 5 letters or digits.').waitFor()
    assert.equal(calls(mock, 'edit_team').length, sent)

    // Reopening on the same phone keeps the session: no second sign-in, the token is redeemed again.
    await open(page)
    await page.reload()
    await text(page, openBanner).waitFor()
    assert.equal(mock.signups.length, 1, 'signed in again')
    assert.equal(calls(mock, 'redeem_registration_link').length, 2)

    // Offline: the change waits (Save status says so) and shows after a reload from what this phone kept; it sends later.
    mock.down = true
    await edit(page, 'Team name', 'Offline Name')
    await page.getByText(/1 change waiting to send/).first().waitFor()
    await page.reload()
    await until(page, async () => (await page.getByLabel('Team name', { exact: true }).count()) === 1
      && (await page.getByLabel('Team name', { exact: true }).inputValue()) === 'Offline Name', 'offline reload lost the change')
    mock.down = false
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await until(page, async () => mock.team.name === 'Offline Name', 'queued change not sent')

    // The server no longer accepts the stored session: sign in anonymously again, then the form.
    mock.answers.redeem_registration_link = [{ ok: false, code: 'not_signed_in', message: 'No.' }]
    await page.reload()
    await text(page, openBanner).waitFor()
    assert.equal(mock.signups.length, 2, 'no new anonymous sign-in after the session was refused')

    // Another link opened offline never shows the Team kept for this one.
    mock.down = true
    await open(page, TOKEN.replace('A', 'C'))
    await text(page, "Can't reach the server. Check your signal and try again.").waitFor()
    assert.equal(await page.locator('input').count(), 0, "another link's Team shown offline")
    mock.down = false
    await open(page)
    await text(page, openBanner).waitFor()

    // Revoked: the next open says so, with no form.
    mock.dead = true
    await page.reload()
    await text(page, 'This link no longer works. Ask the organiser for a new one.').waitFor()
    assert.equal(await page.locator('input').count(), 0)
    await context.close()
  }

  // --- Bad link: no sign-in, no redeem.
  {
    const { context, mock, page } = await fresh()
    await open(page, 'short')
    await text(page, "This link isn't complete. Open it again from the message the organiser sent you.").waitFor()
    assert.equal(mock.signups.length + mock.calls.length, 0)
    await context.close()
  }

  // --- Unknown or replaced link: sign-in, then the dead-link words.
  {
    const { context, page } = await fresh()
    await open(page, TOKEN.replace('A', 'B'))
    await text(page, 'This link no longer works. Ask the organiser for a new one.').waitFor()
    await context.close()
  }

  // --- Offline on the first open: words and a way to try again, which then opens the form.
  {
    const { context, mock, page } = await fresh()
    mock.down = true
    await open(page)
    await text(page, "Can't reach the server. Check your signal and try again.").waitFor()
    mock.down = false
    await button(page, 'Try the link again').click()
    await text(page, openBanner).waitFor()
    await context.close()
  }

  // --- The deadline day itself (Asia/Kathmandu) is still open.
  {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date())
    const { context, page } = await fresh({ deadline: today })
    await open(page)
    await text(page, `Open until ${formatDay(today)}.`).waitFor()
    assert.equal(await page.getByLabel('Team name', { exact: true }).count(), 1)
    await context.close()
  }

  // --- Closed: after the deadline the form is read-only, with no inputs and no Save status.
  {
    const { context, page } = await fresh({ deadline: '2026-11-03' })
    await open(page)
    await text(page, 'Registration closed on Kartik 17, 2083 BS (3 Nov 2026).').waitFor()
    await text(page, 'To change anything now, ask the organiser.').waitFor()
    await text(page, 'Friends Sporting Wing').waitFor()
    await text(page, 'Team code FSW').waitFor()
    assert.equal(await page.locator('input, textarea, select, button').count(), 0, 'inputs or buttons on a closed form')
    assert.equal(await page.locator('.save-bar').count(), 0, 'Save status on a closed form')
    await context.close()
  }
  {
    const { context, page } = await fresh({ status: 'started' })
    await open(page)
    await text(page, `Registration closed on ${formatDay(OPEN_DAY)}.`).waitFor()
    assert.equal(await page.locator('input').count(), 0)
    await context.close()
  }

  // --- Same browser: an Organiser's session and the Team manager's never mix. Each tab sends as its own user, the
  // Organiser's stored session is untouched, and the Team manager's queued change neither shows nor replays there.
  {
    const { context, mock, page } = await fresh({ organiser: true })
    await open(page)
    await text(page, openBanner).waitFor()
    assert.deepEqual(await stored(page), ['sb-fake-auth-token', 'tsl-register-auth'])
    const org = JSON.parse(await page.evaluate(() => localStorage.getItem('sb-fake-auth-token')))
    assert.equal(org.user.id, ORG, 'Organiser session replaced')
    assert.ok(calls(mock, 'redeem_registration_link').every((c) => c.sub === ANON), 'redeemed as the Organiser')
    mock.down = true
    await edit(page, 'Team name', 'Queued By Manager')
    await page.getByText(/1 change waiting to send/).first().waitFor()
    const orgPage = await context.newPage()
    mock.down = false
    await orgPage.goto(base + '/')
    await orgPage.getByRole('heading', { name: 'My tournaments' }).waitFor()
    await orgPage.waitForTimeout(1500)
    assert.equal(await orgPage.getByText(/change waiting/).count(), 0, "Team manager's change shows for the Organiser")
    assert.equal(calls(mock, 'edit_team').length, 0, "Organiser's page replayed the Team manager's change")
    assert.deepEqual((await outbox(orgPage)).map((e) => [e.name, e.state, e.actor]), [['edit_team', 'pending', ANON]])
    // Back on the link page the change sends as the Team manager.
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await until(page, async () => calls(mock, 'edit_team').length === 1, 'queued change not sent')
    assert.equal(calls(mock, 'edit_team')[0].sub, ANON)
    assert.equal(mock.team.name, 'Queued By Manager')
    await context.close()
  }

  console.log('ok')
} finally {
  await browser.close()
  server.httpServer.close()
}
