// Story 2.3 Players and Staff check: on /register#<token> a Team manager adds, edits and removes Players (shirt number,
// date of birth in BS and AD, Photo consent with a parent or guardian's name for a minor) and Staff (only the roles the
// Line-up rules allow), sees Line-up rule refusals in words, sends the Team for review, works offline, and reads the
// Squad as text once closed. Every UI row of the spec's I/O matrix, in real Chrome with Supabase and Turnstile mocked by
// route interception. `npm run check:squad`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'
import { formatDay } from '../src/domain/format.ts'

const SUPA = 'https://fake.supabase.co'
const ANON = '00000000-0000-4000-8000-0000000000a1'
const TEAM = '55555555-0000-4000-8000-000000000001'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const OPEN_DAY = '2033-11-03'
const outDir = 'node_modules/.squad-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4189 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

// Kathmandu's today, the last day of being 17 (a minor) and the 18th birthday (an adult).
const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date()).split('-').map(Number)
const iso = (t) => new Date(t).toISOString().slice(0, 10)
// On 29 Feb the 18th birthday falls on 1 Mar of a common year, as the server counts it.
const ADULT = m === 2 && d === 29 ? `${y - 18}-03-01` : iso(Date.UTC(y - 18, m - 1, d))
const MINOR = iso(Date.parse(ADULT) + 86_400_000)
const KID = '2012-05-01'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session(id) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, exp, role: 'authenticated', aud: 'authenticated', is_anonymous: true })}.sig`
  const user = { id, aud: 'authenticated', role: 'authenticated', email: '', is_anonymous: true, app_metadata: {}, user_metadata: {},
    identities: [], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: `rt-${id}`, user }
}

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const player = (id, name, shirt, dob, consent = false, givenBy = null) => ({ id, name, shirt, dob, consent, givenBy, version: 1 })

/**
 * A context with the Team manager's grant. mock.players / mock.staff: the Squad on the server; mock.rules: the Line-up
 * rules; mock.down: Supabase unreachable; mock.calls: every command body with cmd; mock.answers[cmd]: answers to give first.
 */
async function fresh({ deadline = OPEN_DAY, players = [], staff = [], roles = ['manager', 'coach'] } = {}) {
  const mock = {
    team: { id: TEAM, name: 'Friends Sporting Wing', code: 'FSW', kit_colour: null, status: 'invited', version: 1 },
    form: { tournament_name: 'Gulmi Cup', season_number: 1, season_status: 'registration', registration_deadline: deadline },
    rules: { consent_statement: "Photos can be used on the Gulmi Cup's posts and stream.", starters: 2, max_bench: 1, staff_roles: roles },
    players, staff, down: false, calls: [], answers: {},
  }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  await context.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({
    contentType: 'text/javascript', body: `window.turnstile = { render(el, o) { setTimeout(() => o.callback('tok')); return 'w' }, remove() {} }`,
  }))
  const json = (route, data, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    return json(route, session(ANON))
  })
  const ok = (extra = {}) => ({ ok: true, code: null, message: 'Done.', ...extra })
  const no = (code, message = 'No.') => ({ ok: false, code, message })
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/team') return json(route, [mock.team])
    if (path === '/rest/v1/rpc/registration_form') return json(route, [mock.form])
    if (path === '/rest/v1/rpc/registration_rules') return json(route, [mock.rules])
    if (path === '/rest/v1/squad_entry') {
      return json(route, mock.players.map((p) => ({ team_id: TEAM, shirt_number: p.shirt, player: { id: p.id, name: p.name, date_of_birth: p.dob, version: p.version,
        photo_consent: [{ consent_given: p.consent, given_by: p.givenBy }] } })))
    }
    if (path === '/rest/v1/staff') return json(route, mock.staff.map((x) => ({ ...x, team_id: TEAM })))
    if (path === '/rest/v1/rpc/registration_eligibility') return json(route, [])
    const a = JSON.parse(req.postData() ?? '{}')
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    const given = mock.answers[cmd]?.shift()
    if (given) return json(route, given)
    const max = mock.rules.starters + mock.rules.max_bench
    const p = mock.players.find((x) => x.id === a.player_id)
    const s = mock.staff.find((x) => x.id === a.staff_id)
    if (cmd === 'redeem_registration_link') return json(route, ok({ team_id: TEAM }))
    if (cmd === 'add_player') {
      if (mock.players.length + 1 > max) {
        return json(route, no('lineup_violation', `Squad can have at most ${max} Players. You have ${mock.players.length + 1}.`))
      }
      mock.players.push(player(a.player_id, a.name, a.shirt_number, a.date_of_birth, a.consent, a.consent ? a.given_by : null))
      return json(route, ok())
    }
    if (cmd === 'edit_player') {
      if (!p) return json(route, no('player_missing'))
      if (a.shirt_number != null && mock.players.some((x) => x !== p && x.shirt === a.shirt_number)) return json(route, no('shirt_taken'))
      Object.assign(p, Object.fromEntries(Object.entries({ name: a.name, shirt: a.shirt_number, dob: a.date_of_birth, consent: a.consent, givenBy: a.given_by })
        .filter(([, v]) => v != null)))
      if (!p.consent) p.givenBy = null
      p.version += 1
      return json(route, ok({ version: p.version }))
    }
    if (cmd === 'remove_player') {
      mock.players = mock.players.filter((x) => x.id !== a.player_id)
      return json(route, ok())
    }
    if (cmd === 'add_staff') {
      if (!mock.rules.staff_roles.includes(a.role)) return json(route, no('lineup_violation', `${a.role} isn't an allowed Staff role.`))
      mock.staff.push({ id: a.staff_id, name: a.name, role: a.role, version: 1 })
      return json(route, ok())
    }
    if (cmd === 'edit_staff') {
      Object.assign(s, Object.fromEntries(Object.entries({ name: a.name, role: a.role }).filter(([, v]) => v != null)))
      s.version += 1
      return json(route, ok({ version: s.version }))
    }
    if (cmd === 'remove_staff') {
      mock.staff = mock.staff.filter((x) => x.id !== a.staff_id)
      return json(route, ok())
    }
    if (cmd === 'submit_team') {
      if (mock.players.length < mock.rules.starters) {
        return json(route, no('lineup_violation', `Squad needs at least ${mock.rules.starters} Players. You have ${mock.players.length}.`))
      }
      mock.team.status = 'submitted'
      return json(route, ok())
    }
    return json(route, ok())
  })
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${base}/register#${TOKEN}`)
  await page.getByText(deadline === OPEN_DAY ? `Open until ${formatDay(OPEN_DAY)}.` : 'To change anything now, ask the organiser.', { exact: true }).waitFor()
  return { context, mock, page }
}

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const text = (scope, t) => scope.getByText(t, { exact: true })
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const addForm = (page) => page.locator('form.squad-add', { hasText: 'Add player' })
const staffForm = (page) => page.locator('form.squad-add', { hasText: 'Add staff' })
const card = (page, name) => page.locator('details.squad-card', { hasText: name })
const fill = async (scope, label, value) => {
  await scope.getByLabel(label, { exact: true }).fill(value)
  await scope.getByLabel(label, { exact: true }).blur()
}
const outbox = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('tsl-outbox')
  r.onsuccess = () => {
    const q = r.result.transaction('entries').objectStore('entries').getAll()
    q.onsuccess = () => res(q.result.map((e) => ({ name: e.name, state: e.state })))
  }
}))
const noScroll = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')

try {
  // --- Add player: form checks in words first; then one add_player with every field, listed, Save status visible.
  {
    const { context, mock, page } = await fresh()
    await text(page, 'Players · 0').waitFor()
    await text(page, 'From 2 to 3 Players: 2 starters and up to 1 on the bench.').waitFor()
    const f = addForm(page)
    await button(f, 'Add this Player').click()
    await text(f, "Add the Player's name.").waitFor()
    await text(f, 'Add a shirt number from 1 to 99.').waitFor()
    await text(f, 'Add the date of birth.').waitFor()
    assert.equal(calls(mock, 'add_player').length, 0)
    await fill(f, "Player's name", 'Sita KC')
    await fill(f, 'Shirt number', '7')
    await fill(f, 'Date of birth', ADULT)
    await text(f, formatDay(ADULT)).waitFor() // BS and AD under the field
    await text(f, "Photos can be used on the Gulmi Cup's posts and stream.").waitFor()
    await f.getByLabel('Photo consent given').check()
    // Exactly 18 today: an adult names whoever gives consent.
    await button(f, 'Add this Player').click()
    await text(f, 'Add the name of the person giving consent.').waitFor()
    assert.equal(calls(mock, 'add_player').length, 0)
    await fill(f, 'Name of the person giving consent', 'Sita KC')
    await button(f, 'Add this Player').click()
    await until(page, async () => calls(mock, 'add_player').length === 1, 'add_player not sent')
    const [a] = calls(mock, 'add_player')
    assert.deepEqual([a.team_id, a.name, a.shirt_number, a.date_of_birth, a.consent, a.given_by], [TEAM, 'Sita KC', 7, ADULT, true, 'Sita KC'])
    assert.match(a.player_id, /^[0-9a-f-]{36}$/)
    await text(page, 'Sita KC added.').waitFor()
    await card(page, 'Sita KC').getByText('photo consent: Sita KC').waitFor()
    await text(page, 'Players · 1').waitFor()
    assert.equal(await page.locator('.save-bar').count(), 1, 'no Save status')
    assert.equal(await f.getByLabel("Player's name", { exact: true }).inputValue(), '', 'form not emptied')
    // Shirt numbers are unique in the Team, said before sending.
    await fill(f, 'Shirt number', '7')
    await text(f, 'Shirt number 7 is already used by Sita KC. Choose another number.').waitFor()

    // Minor (the day before the 18th birthday): the name field asks for a parent or guardian; nothing sent without it.
    await fill(f, "Player's name", 'Bisho Basnet')
    await fill(f, 'Shirt number', '9')
    await fill(f, 'Date of birth', MINOR)
    await f.getByLabel('Photo consent given').check()
    await button(f, 'Add this Player').click()
    await text(f, "Add the parent or guardian's name.").waitFor()
    assert.equal(calls(mock, 'add_player').length, 1)
    await fill(f, "Parent or guardian's name", 'Mina Basnet')
    await button(f, 'Add this Player').click()
    await card(page, 'Bisho Basnet').getByText('photo consent: Mina Basnet').waitFor()
    assert.equal(calls(mock, 'add_player')[1].given_by, 'Mina Basnet')

    // Edit: each field saves on leaving it, versioned by the Player.
    const c = card(page, 'Bisho Basnet')
    await c.locator('summary').click()
    await fill(c, "Player's name", 'Bisho B')
    await until(page, async () => calls(mock, 'edit_player').length === 1, 'name edit not sent')
    const [e] = calls(mock, 'edit_player')
    assert.deepEqual([e.player_id, e.name, e.expected_version, e.team_id], [mock.players[1].id, 'Bisho B', 1, TEAM])
    await fill(card(page, 'Bisho B'), 'Shirt number', '7')
    await text(card(page, 'Bisho B'), 'Shirt number 7 is already used by Sita KC. Choose another number.').waitFor()
    // The server refusing a shirt number: words in the card, nothing left waiting.
    mock.answers.edit_player = [{ ok: false, code: 'shirt_taken', message: 'No.' }]
    await fill(card(page, 'Bisho B'), 'Shirt number', '10')
    await text(card(page, 'Bisho B'), 'That shirt number is already used in this Team. Choose another number.').waitFor()
    await until(page, async () => (await outbox(page)).length === 0, 'refused change kept')
    // Withdraw consent, then give it again: a minor needs the guardian's name again.
    await card(page, 'Bisho B').getByLabel('Photo consent given').uncheck()
    await until(page, async () => calls(mock, 'edit_player').some((x) => x.consent === false), 'consent not withdrawn')
    await card(page, 'Bisho B').getByText('no photo consent').waitFor()
    const before = calls(mock, 'edit_player').length
    await card(page, 'Bisho B').getByLabel('Photo consent given').check()
    await text(card(page, 'Bisho B'), "Add the parent or guardian's name.").waitFor()
    assert.equal(calls(mock, 'edit_player').length, before, 'consent sent without a name')
    await fill(card(page, 'Bisho B'), "Parent or guardian's name", 'Hari Basnet')
    await until(page, async () => calls(mock, 'edit_player').some((x) => x.consent === true && x.given_by === 'Hari Basnet'), 'consent not sent')
    await card(page, 'Bisho B').getByText('photo consent: Hari Basnet').waitFor()

    // A consenting adult whose date of birth makes them a minor: the guardian's name is asked for, and both go in one change.
    const sita = card(page, 'Sita KC')
    await sita.locator('summary').click()
    const sent = calls(mock, 'edit_player').length
    await fill(sita, 'Date of birth', KID)
    await text(sita, "Add the parent or guardian's name.").waitFor()
    assert.equal(calls(mock, 'edit_player').length, sent, 'date of birth sent without the guardian')
    await fill(sita, "Parent or guardian's name", 'Gita KC')
    await until(page, async () => calls(mock, 'edit_player').length === sent + 1, 'date of birth and guardian not sent')
    const flip = calls(mock, 'edit_player').at(-1)
    assert.deepEqual([flip.date_of_birth, flip.consent, flip.given_by], [KID, true, 'Gita KC'])
    await sita.locator('summary').click()

    // Squad full: the server's reasons in words; nothing waits.
    await fill(f, "Player's name", 'Yugal KC')
    await fill(f, 'Shirt number', '11')
    await fill(f, 'Date of birth', KID)
    await button(f, 'Add this Player').click()
    await card(page, 'Yugal KC').waitFor()
    await fill(f, "Player's name", 'Extra')
    await fill(f, 'Shirt number', '12')
    await fill(f, 'Date of birth', KID)
    await button(f, 'Add this Player').click()
    await text(f, 'Squad can have at most 3 Players. You have 4.').waitFor()
    await until(page, async () => (await outbox(page)).length === 0, 'refused add kept')
    assert.equal(await card(page, 'Extra').count(), 0)

    // Remove through a Confirm sheet naming the Player.
    await card(page, 'Yugal KC').locator('summary').click()
    await page.getByRole('button', { name: 'Remove Yugal KC from the Squad' }).click()
    await button(page, 'Remove Yugal KC').click()
    await until(page, async () => calls(mock, 'remove_player').length === 1, 'remove not sent')
    assert.equal(calls(mock, 'remove_player')[0].expected_version, 1)
    await until(page, async () => (await card(page, 'Yugal KC').count()) === 0, 'removed Player still shown')
    await noScroll(page)
    await context.close()
  }

  // --- Staff: only the allowed roles are offered; add, change role, remove. No roles allowed: words, no form.
  {
    const { context, mock, page } = await fresh()
    const f = staffForm(page)
    assert.deepEqual(await f.getByLabel('Role').locator('option').allTextContents(), ['Manager', 'Coach'])
    await button(f, 'Add this Staff member').click()
    await text(f, "Add the Staff member's name.").waitFor()
    await fill(f, "Staff member's name", 'Ram Thapa')
    await f.getByLabel('Role').selectOption('coach')
    await button(f, 'Add this Staff member').click()
    await until(page, async () => calls(mock, 'add_staff').length === 1, 'add_staff not sent')
    assert.deepEqual([calls(mock, 'add_staff')[0].name, calls(mock, 'add_staff')[0].role], ['Ram Thapa', 'coach'])
    await text(page, 'Ram Thapa added as Coach.').waitFor()
    const c = card(page, 'Ram Thapa')
    await c.locator('summary').click()
    await c.getByLabel('Role').selectOption('manager')
    await until(page, async () => calls(mock, 'edit_staff').length === 1, 'role change not sent')
    assert.deepEqual([calls(mock, 'edit_staff')[0].role, calls(mock, 'edit_staff')[0].expected_version], ['manager', 1])
    await page.getByRole('button', { name: 'Remove Ram Thapa from the Staff' }).click()
    await button(page, 'Remove Ram Thapa').click()
    await until(page, async () => calls(mock, 'remove_staff').length === 1, 'remove_staff not sent')
    await context.close()
  }
  {
    const { context, page } = await fresh({ roles: [] })
    await text(page, 'The Line-up rules allow no Staff for this Season.').waitFor()
    assert.equal(await staffForm(page).count(), 0)
    await context.close()
  }

  // --- Send for review: too few Players is refused in words; with enough, Submitted.
  {
    const { context, mock, page } = await fresh({ players: [player('91111111-0000-4000-8000-000000000001', 'Sita KC', 7, ADULT)] })
    await button(page, 'Send this Team for review').click()
    await page.getByRole('alert').filter({ hasText: 'Squad needs at least 2 Players. You have 1.' }).waitFor()
    assert.equal(mock.team.status, 'invited')
    mock.players.push(player('91111111-0000-4000-8000-000000000002', 'Anup Karki', 8, KID))
    await page.reload()
    await button(page, 'Send this Team for review').click()
    await text(page, 'Submitted').waitFor()
    await text(page, 'Sent for review. You can still change the Squad until the deadline.').waitFor()
    assert.equal(calls(mock, 'submit_team').length, 1, 'too few Players sent anyway')
    assert.equal(await button(page, 'Send this Team for review').count(), 0)
    await context.close()
  }

  // --- Offline: an added Player shows at once and after a reload, then sends; a Line-up refusal on replay comes back
  // in the hand-back sheet with the reasons in words.
  {
    const { context, mock, page } = await fresh({ players: [player('91111111-0000-4000-8000-000000000001', 'Sita KC', 7, ADULT)] })
    mock.down = true
    const f = addForm(page)
    await fill(f, "Player's name", 'Offline Player')
    await fill(f, 'Shirt number', '5')
    await fill(f, 'Date of birth', KID)
    await button(f, 'Add this Player').click()
    await card(page, 'Offline Player').waitFor()
    await page.getByText(/1 change waiting to send/).first().waitFor()
    await page.reload()
    await card(page, 'Offline Player').waitFor()
    mock.down = false
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await until(page, async () => mock.players.some((p) => p.name === 'Offline Player'), 'queued add not sent')
    mock.down = true
    await fill(f, "Player's name", 'Too Many')
    await fill(f, 'Shirt number', '6')
    await fill(f, 'Date of birth', KID)
    await button(f, 'Add this Player').click()
    await card(page, 'Too Many').waitFor()
    mock.rules.max_bench = 0
    mock.down = false
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await button(page, 'Review this change').click()
    await text(page, 'Squad can have at most 2 Players. You have 3.').waitFor()
    await context.close()
  }

  // --- Offline: renames, consent withdrawn, removals, Staff changes and Send for review show at once and after a reload,
  // while they wait.
  {
    const P = (n) => `91111111-0000-4000-8000-00000000000${n}`
    const { context, mock, page } = await fresh({ players: [player(P(1), 'Sita KC', 7, ADULT, true, 'Sita KC'), player(P(2), 'Anup Karki', 8, KID),
      player(P(3), 'Yugal KC', 9, KID)], staff: [{ id: 'a1', name: 'Ram Thapa', role: 'coach', version: 1 }] })
    mock.down = true
    await card(page, 'Sita KC').locator('summary').click()
    await fill(card(page, 'Sita KC'), "Player's name", 'Sita K')
    await card(page, 'Sita K').getByLabel('Photo consent given').uncheck()
    await card(page, 'Yugal KC').locator('summary').click()
    await page.getByRole('button', { name: 'Remove Yugal KC from the Squad' }).click()
    await button(page, 'Remove Yugal KC').click()
    await card(page, 'Ram Thapa').locator('summary').click()
    await card(page, 'Ram Thapa').getByLabel('Role').selectOption('manager')
    await fill(staffForm(page), "Staff member's name", 'Hari Pun')
    await button(staffForm(page), 'Add this Staff member').click()
    await button(page, 'Send this Team for review').click()
    await page.getByText(/6 changes waiting to send/).first().waitFor()
    await page.reload()
    await card(page, 'Sita K').getByText('no photo consent').waitFor()
    assert.equal(await card(page, 'Yugal KC').count(), 0, 'removed Player shown')
    await until(page, async () => (await card(page, 'Ram Thapa').locator('summary').textContent()).includes('Manager'), `role not shown: ${await card(page, 'Ram Thapa').locator('summary').textContent()}`)
    await card(page, 'Hari Pun').waitFor()
    await text(page, 'Submitted').waitFor()
    mock.down = false
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await until(page, async () => mock.team.status === 'submitted' && mock.players.length === 2 && mock.staff.length === 2, 'queued changes not sent')
    await context.close()
  }

  // --- Closed: Players and Staff as text with the consent's name, no date of birth, no inputs or buttons.
  {
    const { context, page } = await fresh({ deadline: '2026-11-03', players: [player('91111111-0000-4000-8000-000000000001', 'Bisho Basnet', 7, KID, true, 'Mina Basnet'),
      player('91111111-0000-4000-8000-000000000002', 'Dinesh Shrees', 8, ADULT)], staff: [{ id: 'a1', name: 'Ram Thapa', role: 'coach', version: 1 }] })
    await text(page, 'Bisho Basnet · #7 · no document · photo consent: Mina Basnet').waitFor()
    await text(page, 'Dinesh Shrees · #8 · no document · no photo consent').waitFor()
    await text(page, 'Ram Thapa · Coach').waitFor()
    assert.equal(await page.locator('input, textarea, select, button').count(), 0, 'inputs or buttons on a closed form')
    assert.equal(await page.getByText(/2012|Baisakh 1[89], 2069/).count(), 0, 'date of birth shown on a closed form')
    await context.close()
  }

  console.log('ok')
} finally {
  await browser.close()
  server.httpServer.close()
}
