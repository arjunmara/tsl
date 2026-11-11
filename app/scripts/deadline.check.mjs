// Story 2.9 deadline check: the Team manager's banner counts down from 30 minutes before the close (announced politely),
// the open form turns read-only by itself at the close, every command carries x-entered-at, a late change's refusal is
// said in words, and a reopened link shows the reason and new closing date. The Organiser sees the closed link on the Team
// page and reopens it with a required reason and a new closing date. Every UI row of the spec's I/O matrix, in real Chrome
// with Supabase and Turnstile mocked by route interception; the clock is moved through the mocked app.server_now.
// `npm run check:deadline`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ORG = '00000000-0000-4000-8000-000000000001'
const ANON = '00000000-0000-4000-8000-0000000000a1'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const TEAM = '55555555-0000-4000-8000-000000000001'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const outDir = 'node_modules/.deadline-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4195 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session(id, anonymous) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const email = anonymous ? '' : 'org@example.com'
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, email, exp, role: 'authenticated', aud: 'authenticated', is_anonymous: anonymous })}.sig`
  const user = { id, aud: 'authenticated', role: 'authenticated', email, is_anonymous: anonymous, app_metadata: {}, user_metadata: {},
    identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z', ...(anonymous ? {} : { email_confirmed_at: '2026-11-08T00:00:00Z' }) }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: `rt-${id}`, user }
}

// Days in Asia/Kathmandu: today, and n days from it; the link closes at the end of a day (+05:45).
const ktm = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date(ms))
const today = ktm(Date.now())
const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const closeOf = (d) => Date.parse(`${d}T00:00:00+05:45`) + 86_400_000

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/**
 * One context. manager: the Team manager's anonymous session on the Registration link; else a signed-in Organiser of T.
 * deadline: the Season's; at: the server clock as ms (moves with real time); team: fields laid over the Team row.
 * mock.calls: every command body with cmd and its x-entered-at header; mock.answers[cmd]: answers first.
 */
async function fresh({ manager = false, deadline = today, at = Date.now(), team = {} } = {}) {
  const shift = at - Date.now()
  const season = { id: S, number: 1, status: 'registration', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
    starts_on: day(20), ends_on: day(30), registration_deadline: deadline, starters: 2, max_bench: 1, staff_roles: ['manager'] }
  const mock = {
    team: { id: TEAM, tournament_id: T, name: 'Paper Sheet FC', code: 'PSF', kit_colour: null, status: 'invited', return_note: null,
      reopened_until: null, reopen_reason: null, version: 1, registration_link: [], ...team },
    calls: [], answers: {},
  }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  await context.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({
    contentType: 'text/javascript', body: `window.turnstile = { render(el, o) { setTimeout(() => o.callback('tok')); return 'w' }, remove() {} }`,
  }))
  const json = (route, data, s = 200) => route.fulfill({ status: s, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  const me = manager ? session(ANON, true) : session(ORG, false)
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, me))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    }
    if (path === '/rest/v1/team') return json(route, [{ ...mock.team, tournament: { name: 'Gulmi Cup' }, season }])
    if (path === '/rest/v1/rpc/registration_form') {
      return json(route, [{ tournament_name: 'Gulmi Cup', season_number: 1, season_status: 'registration', registration_deadline: deadline }])
    }
    if (path === '/rest/v1/rpc/registration_rules') return json(route, [{ consent_statement: 'Photos may be posted.', starters: 2, max_bench: 1, staff_roles: ['manager'] }])
    if (['/rest/v1/squad_entry', '/rest/v1/staff', '/rest/v1/eligibility_record', '/rest/v1/sponsor', '/rest/v1/rpc/registration_eligibility'].includes(path)) {
      return json(route, [])
    }
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date(Date.now() + shift).toISOString())
    const a = JSON.parse(req.postData() ?? '{}')
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd, enteredAt: req.headers()['x-entered-at'] })
    const given = mock.answers[cmd]?.shift()
    if (given) return json(route, given)
    if (cmd === 'redeem_registration_link') return json(route, { ok: true, code: null, team_id: TEAM })
    if (cmd === 'reopen_registration_link') Object.assign(mock.team, { reopened_until: a.until, reopen_reason: a.reason })
    return json(route, { ok: true, code: null, message: 'Done.', version: 2 })
  })
  await context.addInitScript((v) => localStorage.setItem(v[0], v[1]), [manager ? 'tsl-register-auth' : 'sb-fake-auth-token', JSON.stringify(me)])
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, mock, page, shift }
}

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const text = (scope, t) => scope.getByText(t, { exact: true })
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(100)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const banner = (page) => page.locator('section.deadline-banner[aria-live="polite"]')
const BSAD = /^.+ \d{1,2}, \d{4} BS \(\d{1,2} \w{3} \d{4}\)$/

try {
  // --- Closing soon: "Closes in 30 minutes" in the polite banner; a change carries x-entered-at (server-corrected); a
  // refused late change is said in words.
  {
    const { context, mock, page, shift } = await fresh({ manager: true, at: closeOf(today) - 29.5 * 60_000 })
    await page.goto(`${base}/register#${TOKEN}`)
    await text(banner(page), 'Closes in 30 minutes').waitFor()
    mock.answers.edit_team = [{ ok: false, code: 'registration_closed', message: 'Not allowed.' }]
    const name = page.getByLabel('Team name', { exact: true })
    await name.fill('Late FC')
    await name.blur()
    await text(page, "Registration has closed, so this change wasn't saved. To change anything now, ask the organiser.").waitFor()
    const sent = Date.parse(calls(mock, 'edit_team')[0].enteredAt)
    assert.ok(Math.abs(sent - (Date.now() + shift)) < 60_000, `x-entered-at ${calls(mock, 'edit_team')[0].enteredAt}`)
    await context.close()
  }

  // --- Closes by itself: open 10 s before the close; within a tick the form is read-only with the closed banner, no
  // inputs and no Save status.
  {
    const { context, page } = await fresh({ manager: true, at: closeOf(today) - 10_000 })
    await page.goto(`${base}/register#${TOKEN}`)
    await page.getByLabel('Team name', { exact: true }).waitFor()
    await text(banner(page), 'Closes in 1 minute').waitFor()
    await until(page, async () => (await page.locator('input, textarea, select').count()) === 0, 'read-only form', 20_000)
    const closed = await banner(page).locator('.body-strong').textContent()
    assert.match(closed, /^Registration closed on .+ BS \(\d{1,2} \w{3} \d{4}\)\.$/)
    await text(banner(page), 'To change anything now, ask the organiser.').waitFor()
    assert.equal(await page.locator('.save-bar').count(), 0)
    await context.close()
  }

  // --- Reopened: the deadline passed yesterday, the link reopened through day+2 for a reason: editable, the banner
  // shows the reason and the new closing date in BS and AD.
  {
    const { context, page } = await fresh({ manager: true, deadline: day(-1), team: { reopened_until: day(2), reopen_reason: 'Injury replacement' } })
    await page.goto(`${base}/register#${TOKEN}`)
    await text(banner(page), 'The organiser reopened this form: Injury replacement').waitFor()
    const open = await banner(page).locator('.body-strong').textContent()
    assert.match(open, /^Open until /)
    assert.match(open.replace(/^Open until /, '').replace(/\.$/, ''), BSAD)
    assert.ok(open.includes(new Date(`${day(2)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })))
    await page.getByLabel('Team name', { exact: true }).waitFor()
    await context.close()
  }

  // --- Organiser: closed link on the Team page; "Reopen link" needs a reason; it sends reopen_registration_link with the
  // reason and date, then shows the reopened state.
  {
    const { context, mock, page } = await fresh({ deadline: day(-1) })
    await page.goto(`${base}/t/${T}/teams/${TEAM}`)
    const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Registration deadline', exact: true }) })
    const words = await card.locator('p.body').first().textContent()
    assert.match(words, /^The link closed on .+ BS \(.+\)\. The Team manager can only read it\.$/)
    await button(card, 'Reopen link').click()
    const reason = card.getByLabel('Reason for reopening', { exact: true })
    assert.ok(await reason.evaluate((e) => e === document.activeElement))
    await button(card, "Reopen this Team's link").click()
    await text(card, 'Write a reason of 1 to 200 characters.').waitFor()
    assert.equal(await reason.getAttribute('aria-invalid'), 'true')
    assert.equal(calls(mock, 'reopen_registration_link').length, 0)
    await reason.fill('  Injury replacement ')
    await card.getByLabel('New closing date', { exact: true }).fill(day(2))
    await button(card, "Reopen this Team's link").click()
    await until(page, async () => calls(mock, 'reopen_registration_link').length === 1, 'reopen sent')
    const c = calls(mock, 'reopen_registration_link')[0]
    assert.deepEqual([c.team_id, c.reason, c.until], [TEAM, 'Injury replacement', day(2)])
    await until(page, async () => /^Reopened until .+: Injury replacement$/.test(await card.locator('p.body').first().textContent()), 'reopened words')
    await card.locator('p[role="status"]', { hasText: "Paper Sheet FC's link is open until" }).waitFor()
    await context.close()
  }

  // --- Before the deadline the Organiser sees no Reopen card.
  {
    const { context, page } = await fresh({ deadline: day(3) })
    await page.goto(`${base}/t/${T}/teams/${TEAM}`)
    await page.locator('.team-pane').getByLabel('Team name', { exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: 'Registration deadline', exact: true }).count(), 0)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
