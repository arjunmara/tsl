// Story 2.6 paper-sheet check: an Organiser opens a Team inside the Tournament home (App bar and tabs, Teams selected)
// and fills its Team details, Players and Staff with the Team manager's form sections and commands, sends it for review,
// sees the Line-up and Photo consent checks, gets the hand-back sheet on a conflict, sees the Team list beside the Team on
// a laptop, reads the Squad as text once the Season has started, and is told in words when the Team can't load. Every UI
// row of the spec's I/O matrix, in real Chrome with Supabase mocked by route interception. `npm run check:paper`.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const TEAM = '55555555-0000-4000-8000-000000000001'
const OTHER = '55555555-0000-4000-8000-000000000002'
const outDir = 'node_modules/.paper-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4192 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email: 'org@example.com', exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'org@example.com', email_confirmed_at: '2026-11-08T00:00:00Z',
    app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/**
 * A signed-in Organiser of T. mock.players / mock.staff: TEAM's Squad on the server; mock.calls: every command body
 * (cmd: its name); mock.answers[cmd]: answers to give first; mock.formFail: Squad reads answering 500.
 */
async function fresh({ status = 'registration', width = 390 } = {}) {
  const season = { id: S, number: 1, status, setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
    starts_on: '2026-11-07', ends_on: '2026-11-21', registration_deadline: '2026-11-03', starters: 2, max_bench: 1, staff_roles: ['manager', 'coach'] }
  const mock = {
    teams: [
      { id: TEAM, name: 'Paper Sheet FC', code: 'PSF', kit_colour: null, status: 'invited', version: 1, registration_link: [] },
      { id: OTHER, name: 'Friends Sporting Wing', code: 'FSW', kit_colour: null, status: 'invited', version: 1, registration_link: [] },
    ],
    players: [], staff: [], calls: [], answers: {}, formFail: 0,
  }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data, s = 200) => route.fulfill({ status: s, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const url = new URL(req.url())
    const path = url.pathname
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    }
    if (path === '/rest/v1/team') {
      const id = url.searchParams.get('id')?.replace('eq.', '')
      return json(route, mock.teams.filter((t) => !id || t.id === id).map((t) => ({ ...t, tournament: { name: 'Gulmi Cup' }, season })))
    }
    if (path === '/rest/v1/squad_entry') {
      if (mock.formFail) return (mock.formFail--, json(route, { message: 'boom' }, 500))
      // Only the open Team's Squad is asked for; OTHER has none.
      if (url.searchParams.get('team_id') !== `eq.${TEAM}`) return json(route, [])
      return json(route, mock.players.map((p) => ({ team_id: TEAM, shirt_number: p.shirt, player: { id: p.id, name: p.name, date_of_birth: p.dob,
        version: p.version, photo_path: null, is_cutout: null,
        photo_consent: [{ season_id: S, consent_given: p.consent, given_by: p.givenBy }, { season_id: 'other', consent_given: true, given_by: 'Old Season' }] } })))
    }
    if (path === '/rest/v1/staff') return json(route, url.searchParams.get('team_id') !== `eq.${TEAM}` ? [] : mock.staff.map((x) => ({ ...x, team_id: TEAM, photo_path: null, is_cutout: null })))
    if (path === '/rest/v1/eligibility_record') return json(route, [])
    if (path === '/rest/v1/sponsor') return json(route, [])
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    const a = JSON.parse(req.postData() ?? '{}')
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    const given = mock.answers[cmd]?.shift()
    if (given) return json(route, given)
    const ok = (extra = {}) => json(route, { ok: true, code: null, message: 'Done.', ...extra })
    const no = (code, message) => json(route, { ok: false, code, message })
    const p = mock.players.find((x) => x.id === a.player_id)
    if (cmd === 'add_player') {
      if (mock.players.length + 1 > 3) return no('lineup_violation', `Squad can have at most 3 Players. You have ${mock.players.length + 1}.`)
      mock.players.push({ id: a.player_id, name: a.name, shirt: a.shirt_number, dob: a.date_of_birth, consent: a.consent, givenBy: a.consent ? a.given_by : null, version: 1 })
    }
    if (cmd === 'edit_player' && p) {
      if (a.name) p.name = a.name
      return ok({ version: ++p.version })
    }
    if (cmd === 'add_staff') mock.staff.push({ id: a.staff_id, name: a.name, role: a.role, version: 1 })
    if (cmd === 'edit_team') {
      const t = mock.teams[0]
      Object.assign(t, Object.fromEntries(Object.entries({ name: a.name, code: a.code, kit_colour: a.kit_colour }).filter(([, v]) => v != null)))
      return ok({ version: ++t.version })
    }
    if (cmd === 'submit_team') {
      if (mock.players.length < 2) return no('lineup_violation', `Squad needs at least 2 Players. You have ${mock.players.length}.`)
      mock.teams[0].status = 'submitted'
    }
    return ok()
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
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
const addForm = (page) => page.locator('form.squad-add', { hasText: 'Add player' })
const staffForm = (page) => page.locator('form.squad-add', { hasText: 'Add staff' })
const card = (page, name) => page.locator('details.squad-card', { hasText: name })
const fill = async (scope, label, value) => {
  await scope.getByLabel(label, { exact: true }).fill(value)
  await scope.getByLabel(label, { exact: true }).blur()
}
const openTeam = async (page, players = 0) => {
  await page.goto(`${base}/t/${T}`)
  await page.getByRole('tab', { name: 'Teams' }).click()
  await button(page, 'Open Paper Sheet FC').click()
  await page.waitForURL((u) => u.pathname === `/t/${T}/teams/${TEAM}`)
  await text(page, `Players · ${players}`).waitFor()
}

try {
  // --- Open a Team: inside the App bar and tabs (Teams selected), the link card and every form section; on a phone the
  // list is hidden. Then the paper sheet: Team details, Players (Photo consent and Line-up checks), Staff, send for review.
  {
    const { context, mock, page } = await fresh()
    await openTeam(page)
    await page.getByRole('heading', { name: 'Gulmi Cup', level: 1 }).waitFor()
    assert.equal(await page.getByRole('tab', { name: 'Teams' }).getAttribute('aria-selected'), 'true')
    await page.getByRole('heading', { name: 'Paper Sheet FC', level: 2 }).waitFor()
    await page.getByRole('heading', { name: 'Registration link' }).waitFor()
    assert.equal(await button(page, 'Open Friends Sporting Wing').count(), 0, 'Team list shown beside the Team on a phone')
    assert.equal(await page.locator('.save-bar').count(), 1, 'Save status not once, in the App bar')
    // Team details through edit_team, versioned by the Team.
    await fill(page.locator('.team-pane'), 'Team name', 'Paper Sheet United')
    await until(page, async () => calls(mock, 'edit_team').length === 1, 'edit_team not sent')
    assert.deepEqual([calls(mock, 'edit_team')[0].team_id, calls(mock, 'edit_team')[0].name, calls(mock, 'edit_team')[0].expected_version], [TEAM, 'Paper Sheet United', 1])
    // A minor's consent needs a guardian's name: nothing sent without it.
    const f = addForm(page)
    await fill(f, "Player's name", 'Sita Rana')
    await fill(f, 'Shirt number', '4')
    await fill(f, 'Date of birth', '2012-05-01')
    await f.getByLabel('Photo consent given').check()
    await button(f, 'Add this Player').click()
    await text(f, "Add the parent or guardian's name.").waitFor()
    assert.equal(calls(mock, 'add_player').length, 0)
    await fill(f, "Parent or guardian's name", 'Gita Rana')
    await button(f, 'Add this Player').click()
    await card(page, 'Sita Rana').getByText('photo consent: Gita Rana').waitFor()
    // Send for review with too few Players: the Line-up rules in words.
    await button(page, 'Send this Team for review').click()
    await page.getByRole('alert').filter({ hasText: 'Squad needs at least 2 Players. You have 1.' }).waitFor()
    for (const [name, shirt] of [['Rita Rana', '5'], ['Mina Rana', '6'], ['Too Many', '7']]) {
      await fill(f, "Player's name", name)
      await fill(f, 'Shirt number', shirt)
      await fill(f, 'Date of birth', '1990-01-01')
      await button(f, 'Add this Player').click()
      if (name !== 'Too Many') await card(page, name).waitFor()
    }
    await page.getByRole('alert').filter({ hasText: 'Squad can have at most 3 Players. You have 4.' }).waitFor()
    // Staff, then Submitted.
    const sf = staffForm(page)
    await fill(sf, "Staff member's name", 'Hari Rana')
    await sf.getByLabel('Role').selectOption('manager')
    await button(sf, 'Add this Staff member').click()
    await text(page, 'Hari Rana added as Manager.').waitFor()
    await button(page, 'Send this Team for review').click()
    await until(page, async () => mock.teams[0].status === 'submitted', 'submit_team not accepted')
    await page.locator('.team-pane').getByText('Sent for review.', { exact: false }).waitFor()
    // Every command went to TEAM through the Organiser's session, one Squad for one Team.
    for (const c of mock.calls.filter((x) => x.cmd !== 'server_now')) assert.equal(c.team_id, TEAM, `${c.cmd} not for the Team`)
    assert.deepEqual(mock.players.map((p) => p.name), ['Sita Rana', 'Rita Rana', 'Mina Rana'])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
    // Back to Teams: the list, Teams still selected.
    await button(page, 'Back to Teams').click()
    await page.waitForURL((u) => u.pathname === `/t/${T}`)
    await button(page, 'Open Friends Sporting Wing').waitFor()
    await context.close()
  }

  // --- Laptop: the list and the open Team side by side; another row opens that Team in place.
  {
    const { context, page } = await fresh({ width: 1280 })
    await openTeam(page)
    const list = await page.locator('.teams-side').boundingBox()
    const team = await page.locator('.team-pane').boundingBox()
    assert.ok(list && team && list.x + list.width <= team.x && Math.abs(list.y - team.y) < 40, `not side by side: ${JSON.stringify([list, team])}`)
    assert.equal(await button(page, 'Open Paper Sheet FC').getAttribute('aria-current'), 'true')
    await button(page, 'Open Friends Sporting Wing').click()
    await page.getByRole('heading', { name: 'Friends Sporting Wing', level: 2 }).waitFor()
    await context.close()
  }

  // --- Conflict: the manager changed the Player first; the hand-back sheet offers their version or mine, nothing overwritten.
  {
    const { context, mock, page } = await fresh()
    mock.players.push({ id: '91111111-0000-4000-8000-000000000011', name: 'Rita Rana', shirt: 5, dob: '1990-01-01', consent: false, givenBy: null, version: 1 })
    await openTeam(page, 1)
    await card(page, 'Rita Rana').waitFor()
    mock.answers.edit_player = [{ ok: false, code: 'version_conflict', message: 'Someone else changed this first.',
      conflict: { current_version: 2, current: { name: 'Rita K. Rana' }, changed_by: 'Team manager', changed_at: '2026-11-10T04:15:00Z' } }]
    const c = card(page, 'Rita Rana')
    await c.locator('summary').click()
    await fill(c, "Player's name", 'Rita Organiser')
    await button(page, 'Review this change').click()
    const sheet = page.getByRole('dialog')
    await sheet.getByText('Changed by Team manager', { exact: false }).waitFor()
    await button(sheet, 'Keep their version').waitFor()
    await button(sheet, 'Send my version').click()
    await until(page, async () => calls(mock, 'edit_player').length === 2, 'mine not sent again')
    assert.equal(calls(mock, 'edit_player')[1].expected_version, 2)
    await context.close()
  }

  // --- Season started: the Team and Squad as text, no inputs; a failed load says so and loads again.
  {
    const { context, mock, page } = await fresh({ status: 'started' })
    mock.players.push({ id: '91111111-0000-4000-8000-000000000011', name: 'Rita Rana', shirt: 5, dob: '1990-01-01', consent: true, givenBy: 'Rita Rana', version: 1 })
    mock.formFail = 1
    await page.goto(`${base}/t/${T}/teams/${TEAM}`)
    await text(page, "Couldn't load this Team's Players and Staff. Try loading the Team again.").waitFor()
    await button(page, 'Try loading the Team again').click()
    await page.getByText('Rita Rana').first().waitFor()
    assert.equal(await page.locator('.team-pane').getByLabel('Team name').count(), 0, 'inputs once the Season has started')
    assert.equal(await page.getByText('Old Season').count(), 0, "another Season's consent shown")
    await context.close()
  }

  // --- A Team not in this Season: words, no form.
  {
    const { context, page } = await fresh()
    await page.goto(`${base}/t/${T}/teams/55555555-0000-4000-8000-000000000009`)
    await text(page, 'That Team no longer exists in this Season. Reload the page.').waitFor()
    assert.equal(await page.locator('.team-pane').getByLabel('Team name').count(), 0)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
