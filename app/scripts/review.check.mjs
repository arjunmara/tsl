// Story 2.8 review check: an Organiser approves a submitted Team (gold Approved pill; Line-up refusal in words), returns it
// with a note (note required), and withdraws it through a Confirm sheet naming the Team (form then read-only, no review
// buttons); the Team list shows each status. The Team manager's link shows the note at the top of an editable form when
// returned, and a read-only form when approved or withdrawn. Every UI row of the spec's I/O matrix, in real Chrome with
// Supabase and Turnstile mocked by route interception. `npm run check:review`. Needs Google Chrome.
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
const outDir = 'node_modules/.review-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4194 } })
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

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/**
 * One context. manager: the Team manager's anonymous session on the Registration link; else a signed-in Organiser of T.
 * mock.team: the Team row (status, return_note); mock.calls: every command body with cmd; mock.answers[cmd]: answers first.
 */
async function fresh({ manager = false, status = 'submitted', note = null } = {}) {
  const season = { id: S, number: 1, status: 'registration', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
    starts_on: '2033-11-07', ends_on: '2033-11-21', registration_deadline: '2033-11-03', starters: 2, max_bench: 1, staff_roles: ['manager'] }
  const mock = {
    team: { id: TEAM, tournament_id: T, name: 'Paper Sheet FC', code: 'PSF', kit_colour: null, status, return_note: note, version: 1, registration_link: [] },
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
      return json(route, [{ tournament_name: 'Gulmi Cup', season_number: 1, season_status: 'registration', registration_deadline: '2033-11-03' }])
    }
    if (path === '/rest/v1/rpc/registration_rules') return json(route, [{ consent_statement: 'Photos may be posted.', starters: 2, max_bench: 1, staff_roles: ['manager'] }])
    if (['/rest/v1/squad_entry', '/rest/v1/staff', '/rest/v1/eligibility_record', '/rest/v1/sponsor', '/rest/v1/rpc/registration_eligibility'].includes(path)) {
      return json(route, [])
    }
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    const a = JSON.parse(req.postData() ?? '{}')
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    const given = mock.answers[cmd]?.shift()
    if (given) return json(route, given)
    if (cmd === 'redeem_registration_link') return json(route, { ok: true, code: null, team_id: TEAM })
    if (cmd === 'approve_team') mock.team.status = 'approved'
    if (cmd === 'return_team') Object.assign(mock.team, { status: 'returned', return_note: a.note })
    if (cmd === 'withdraw_team') mock.team.status = 'withdrawn'
    return json(route, { ok: true, code: null, message: 'Done.' })
  })
  await context.addInitScript((v) => localStorage.setItem(v[0], v[1]), [manager ? 'tsl-register-auth' : 'sb-fake-auth-token', JSON.stringify(me)])
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, mock, page }
}

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const text = (scope, t) => scope.getByText(t, { exact: true })
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const review = (page) => page.locator('section.card', { has: page.getByRole('heading', { name: 'Review', exact: true }) }).first()
const openTeam = async (page) => {
  await page.goto(`${base}/t/${T}/teams/${TEAM}`)
  await review(page).waitFor()
}
const pill = (page) => page.locator('.team-name .ui-pill')

try {
  // --- Approve: approve_team with only the Team's id; the pill turns a gold "Approved" (highlight token); Approve goes.
  {
    const { context, mock, page } = await fresh()
    await openTeam(page)
    assert.equal(await pill(page).textContent(), 'Submitted')
    await button(review(page), 'Approve team').click()
    await until(page, async () => (await pill(page).textContent()) === 'Approved', 'Approved pill')
    assert.deepEqual(Object.keys(calls(mock, 'approve_team')[0]).sort(), ['cmd', 'command_id', 'team_id'])
    assert.ok(await pill(page).evaluate((e) => e.classList.contains('ui-pill-done')))
    const [bg, gold] = await pill(page).evaluate((e) => [getComputedStyle(e).backgroundColor,
      (() => { const d = document.createElement('i'); d.style.color = 'var(--highlight)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c })()])
    assert.equal(bg, gold)
    await text(page, 'Paper Sheet FC is approved').waitFor()
    assert.equal(await button(review(page), 'Approve team').count(), 0)
    // Still returnable once approved.
    await button(review(page), 'Return with note').waitFor()
    // The Team list shows the status too.
    await page.goto(`${base}/t/${T}`)
    await page.getByRole('tab', { name: 'Teams' }).click()
    await page.locator('.ui-pill', { hasText: 'Approved' }).waitFor()
    await context.close()
  }

  // --- Approve refused by the Line-up rules: the server's reasons in words; status stays Submitted.
  {
    const { context, mock, page } = await fresh()
    mock.answers.approve_team = [{ ok: false, code: 'lineup_violation', message: 'Squad needs at least 2 Players. You have 1.' }]
    await openTeam(page)
    await button(review(page), 'Approve team').click()
    await text(page, "Can't approve: Squad needs at least 2 Players. You have 1.").waitFor()
    assert.equal(await pill(page).textContent(), 'Submitted')
    await context.close()
  }

  // --- Return with note: an empty note is refused in words; a note sends return_team (trimmed) and shows Returned.
  {
    const { context, mock, page } = await fresh()
    await openTeam(page)
    await button(review(page), 'Return with note').click()
    const box = page.getByLabel('Note for the Team manager', { exact: true })
    assert.ok(await box.evaluate((e) => e === document.activeElement))
    await button(review(page), 'Send note and return team').click()
    await text(page, 'Write a note of 1 to 500 characters for the Team manager.').waitFor()
    assert.equal(await box.getAttribute('aria-invalid'), 'true')
    assert.equal(calls(mock, 'return_team').length, 0)
    await box.fill('  Add the coach’s name.  ')
    await button(review(page), 'Send note and return team').click()
    await until(page, async () => (await pill(page).textContent()) === 'Returned', 'Returned pill')
    assert.equal(calls(mock, 'return_team')[0].note, 'Add the coach’s name.')
    await text(page, 'Returned to the Team manager. They can change it and send it again.').waitFor()
    assert.equal(await button(review(page), 'Return with note').count(), 0)
    await context.close()
  }

  // --- Withdraw: Confirm sheet naming the Team, opening on Cancel; Cancel sends nothing; confirming withdraws, the form
  // turns to text and only the withdrawn words remain.
  {
    const { context, mock, page } = await fresh()
    await openTeam(page)
    await page.locator('.team-pane').getByLabel('Team name', { exact: true }).waitFor()
    await button(review(page), 'Withdraw team').click()
    const sheet = page.getByRole('dialog', { name: 'Withdraw Paper Sheet FC?' })
    await sheet.waitFor()
    assert.ok(await button(sheet, 'Cancel').evaluate((e) => e === document.activeElement))
    await button(sheet, 'Cancel').click()
    assert.equal(calls(mock, 'withdraw_team').length, 0)
    await button(review(page), 'Withdraw team').click()
    await button(sheet, 'Withdraw Paper Sheet FC').click()
    await until(page, async () => (await pill(page).textContent()) === 'Withdrawn', 'Withdrawn pill')
    await text(page, 'This Team is withdrawn. It stays out of the Draw and its link can only be read.').waitFor()
    for (const b of ['Approve team', 'Return with note', 'Withdraw team']) assert.equal(await button(page, b).count(), 0, b)
    await until(page, async () => (await page.locator('.team-pane').getByLabel('Team name', { exact: true }).count()) === 0, 'read-only form')
    await text(page, 'Team code PSF').first().waitFor()
    await context.close()
  }

  // --- A refused review (another Organiser withdrew it first) is said in words.
  {
    const { context, mock, page } = await fresh()
    mock.answers.approve_team = [{ ok: false, code: 'team_withdrawn', message: 'No.' }]
    await openTeam(page)
    await button(review(page), 'Approve team').click()
    await text(page, 'The organiser withdrew this Team, so it can no longer change.').waitFor()
    await context.close()
  }

  // --- Team manager, returned: the note at the top, above an editable form with "Send this Team for review".
  {
    const { context, page } = await fresh({ manager: true, status: 'returned', note: 'Add the coach’s name.' })
    await page.goto(`${base}/register#${TOKEN}`)
    await text(page, 'The organiser returned this Team with a note:').waitFor()
    await text(page, 'Add the coach’s name.').waitFor()
    const [noteY, nameY] = await Promise.all([text(page, 'Add the coach’s name.').boundingBox(), page.getByLabel('Team name', { exact: true }).boundingBox()])
    assert.ok(noteY.y < nameY.y, 'note above the form')
    await button(page, 'Send this Team for review').waitFor()
    await context.close()
  }

  // --- Team manager, approved or withdrawn: read-only, no inputs or Save status, the reason in words.
  for (const [status, words] of [['approved', 'The organiser approved this Team.'], ['withdrawn', 'The organiser withdrew this Team.']]) {
    const { context, page } = await fresh({ manager: true, status })
    await page.goto(`${base}/register#${TOKEN}`)
    await text(page, words).waitFor()
    await text(page, 'Team code PSF').waitFor()
    assert.equal(await page.locator('input, textarea, select').count(), 0, status)
    assert.equal(await page.getByText('The organiser returned this Team with a note:').count(), 0)
    assert.equal(await button(page, 'Send this Team for review').count(), 0)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
