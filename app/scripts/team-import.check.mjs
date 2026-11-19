// CSV team import check: parser and plan unit asserts, then every row of the spec's I/O matrix in real Chrome against a
// mocked Supabase (fresh, re-import, update, bad rows, quoted, too many, offline, started). `npm run check:team-import`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'
import { parseCsv, planImport, summary } from '../src/domain/teamCsv.ts'

// --- Unit: the parser.
{
  const rows = parseCsv('\uFEFFa,b,c\r\n\r\n"Thapa, Jr.","say ""hi""",\n"two\nlines",x,y\n,,\n')
  assert.deepEqual(rows.map((r) => r.cells), [['a', 'b', 'c'], ['Thapa, Jr.', 'say "hi"', ''], ['two\nlines', 'x', 'y']])
  assert.deepEqual(rows.map((r) => r.line), [1, 3, 4])
}
// --- Unit: the plan.
{
  const H = 'player_name,TEAM_CODE,team_name,shirt_number,date_of_birth,kit_colour\n'
  const ok = planImport(`${H}A One,ab,Alpha,4,2001-02-03,#AABBCC\nB Two,AB,Alpha,5,2001-02-03,#aabbcc\n`, [], '2026-11-19', null)
  assert.deepEqual(ok.errors, [])
  assert.equal(summary(ok), 'Adds 1 Team and 2 Players.')
  assert.equal(ok.teams[0].kit, '#aabbcc')
  assert.match(planImport('team_name,team_code\n', [], '2026-11-19', null).errors[0], /missing the columns kit_colour, player_name, shirt_number, date_of_birth/)
  const bad = planImport(`${H}A One,A,Alpha,4,2001-02-03,red\nB Two,AB,Alpha,100,1939-12-31,\nC Three,AB,Alpha,5,2026-11-20,\nD,AB,Alpha,x,2001-02-30,\n`, [], '2026-11-19', null)
  assert.equal(bad.errors.length, 7, bad.errors.join('|'))
  const dup = planImport(`${H}A One,AB,Alpha,4,2001-02-03,\na one,AB,Alpha,5,2001-02-03,\nC,AB,Alpha,4,2001-02-03,\nD,AB,Beta,6,2001-02-03,#111111\n`, [], '2026-11-19', null)
  assert.deepEqual(dup.errors, ['Row 3: a one is already in Alpha in row 2.', 'Row 4: shirt number 4 is already used by A One.',
    'Row 5: team code AB has the name "Beta" here but "Alpha" in row 2.', 'Row 5: team code AB has the kit colour "#111111" here but "blank" in row 2.'])
  assert.deepEqual(planImport(`${H}A One,AB,Alpha,4,2001-02-03,\n"B Two,AB,Alpha,5,2001-02-03,\n`, [], '2026-11-19', null).errors, ['Row 3: a quote is never closed.'])
  const gone = [{ id: 't9', name: 'Alpha', code: 'AB', kitColour: null, version: 1, withdrawn: true, players: [] }]
  assert.deepEqual(planImport(`${H}A One,AB,Alpha,4,2001-02-03,\n`, gone, '2026-11-19', null).errors, ['Row 2: Team Alpha is withdrawn.'])
  const erased = [{ id: 't1', name: 'Alpha', code: 'AB', kitColour: null, version: 1, players: [{ id: 'p1', name: 'A One', shirtNumber: 4, dateOfBirth: '', version: 1 }] }]
  assert.equal(summary(planImport(`${H}A One,AB,Alpha,4,2001-02-03,\n`, erased, '2026-11-19', null)), 'Nothing to change.')
  const old = [{ id: 't1', name: 'Alpha', code: 'AB', kitColour: null, version: 1, players: [{ id: 'p1', name: 'Suman Thapa', shirtNumber: 4, dateOfBirth: '2000-01-01', version: 1 }] }]
  assert.deepEqual(planImport(`${H}New Guy,AB,Alpha,4,2001-02-03,\n`, old, '2026-11-19', null).errors, ['Row 2: shirt number 4 is already used by Suman Thapa.'])
  assert.match(planImport(`${H}New Guy,AB,Alpha,5,2001-02-03,\n`, old, '2026-11-19', 1).errors[0], /Row 2: Alpha would have 2 Players; the Season allows at most 1\./)
}

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const outDir = 'node_modules/.team-import-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4197 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email: 'org@example.com', exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'org@example.com', email_confirmed_at: '2026-11-08T00:00:00Z',
    app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}
const seasonRow = (o = {}) => ({
  id: S, number: 1, status: 'setup', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
  starts_on: '2026-11-07', ends_on: '2026-11-21', registration_deadline: '2026-11-03', ...o,
})
const teamRow = (id, name, code, links = []) => ({ id, name, code, kit_colour: null, status: 'invited', registration_link: links })

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/**
 * A signed-in Organiser. mock.teams: app.team rows and mock.squad: squad_entry rows (add_team / add_player change them as
 * the server would); mock.calls: every command body (cmd: its name); mock.down: Supabase unreachable; mock.limit: the
 * Season's starters + bench.
 */
async function fresh({ season = {}, limit = null } = {}) {
  const mock = { season: seasonRow(season), teams: [], squad: [], calls: [], down: false, limit }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [mock.season] }])
    }
    if (path === '/rest/v1/team') return json(route, mock.teams.map((t) => ({ ...t, version: 1 })))
    if (path === '/rest/v1/squad_entry') return json(route, mock.squad)
    if (path === '/rest/v1/season') return json(route, mock.limit === null ? [] : [{ starters: mock.limit, max_bench: 0 }])
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (req.method() === 'GET') return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    if (cmd === 'add_team') mock.teams.push(teamRow(a.team_id, a.name, a.code, [{ id: a.link_id, revoked_at: null }]))
    if (cmd === 'edit_team' && a.kit_colour) mock.teams.find((t) => t.id === a.team_id).kit_colour = a.kit_colour
    if (cmd === 'add_player') mock.squad.push({ team_id: a.team_id, shirt_number: a.shirt_number, player: { id: a.player_id, name: a.name, date_of_birth: a.date_of_birth, version: 1 } })
    if (cmd === 'edit_player') {
      const e = mock.squad.find((x) => x.player.id === a.player_id)
      if (a.shirt_number) e.shirt_number = a.shirt_number
      if (a.date_of_birth) e.player.date_of_birth = a.date_of_birth
    }
    return json(route, { ok: true, code: null, message: 'Done.', version: 2 })
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, mock, page }
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
const text = (page, t) => page.getByText(t, { exact: true })
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 15000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const noScroll = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
const outboxCount = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('tsl-outbox')
  r.onsuccess = () => {
    const q = r.result.transaction('entries').objectStore('entries').count()
    q.onsuccess = () => res(q.result)
  }
}))
const teamsTab = async (page) => {
  await page.goto(base + `/t/${T}`)
  await page.getByRole('tab', { name: 'Teams' }).click()
}
const choose = async (page, csv) => {
  await page.locator('input[type=file]').setInputFiles({ name: 'teams.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
}
const SAMPLE = readFileSync(new URL('./fixtures/teams-sample.csv', import.meta.url), 'utf8')
const HEAD = 'team_name,team_code,kit_colour,player_name,shirt_number,date_of_birth\r\n'

try {
  // --- Fresh, then re-import, then update.
  {
    const { context, mock, page } = await fresh()
    await teamsTab(page)
    const template = await page.getByRole('link', { name: 'Download the CSV template' }).getAttribute('href')
    assert.equal(decodeURIComponent(template.split(',')[1]), HEAD)
    await choose(page, SAMPLE)
    await text(page, 'Adds 8 Teams and 80 Players.').waitFor()
    await page.getByText('Tamghas Tigers (TGT): new Team, adds 10 Players').waitFor()
    await noScroll(page)
    await button(page, 'Import 8 teams and 80 players').click()
    await until(page, async () => calls(mock, 'add_player').length === 80, 'players not sent')
    assert.equal(calls(mock, 'add_team').length, 8)
    assert.equal(calls(mock, 'edit_team').length, 8)
    assert.ok(calls(mock, 'add_player').every((c) => c.consent === false))
    assert.deepEqual(mock.calls.slice(0, 4).map((c) => c.cmd), ['open_registration', 'add_team', 'edit_team', 'add_player'])
    await page.locator('.team-row').nth(7).waitFor()
    assert.equal(await page.locator('.team-row').count(), 8)
    await page.locator('.team-row', { hasText: 'Tamghas Tigers' }).locator('.ui-kit-dot').waitFor()

    // Re-import: nothing to change.
    const before = mock.calls.length
    await choose(page, SAMPLE)
    await text(page, 'Nothing to change.').waitFor()
    assert.equal(await page.getByRole('button', { name: /^Import \d/ }).count(), 0)
    await button(page, 'Choose another file').waitFor()
    assert.equal(mock.calls.length, before)

    // Update: one shirt and one kit.
    const lines = SAMPLE.split(/\r?\n/)
    const [, code, , pname] = lines[1].split(',')
    const changed = lines.map((l, i) => (i === 0 || !l ? l : l.split(',')[1] === code
      ? l.replace(/^([^,]*,[^,]*,)#[0-9a-f]{6}/, '$1#123456').replace(new RegExp(`(${pname},)\\d+`), '$199') : l)).join('\r\n')
    await choose(page, changed)
    await text(page, 'Updates 1 Team and 1 Player.').waitFor()
    await button(page, 'Import 1 team and 1 player').click()
    await until(page, async () => calls(mock, 'edit_player').length === 1, 'edit_player not sent')
    await until(page, async () => calls(mock, 'edit_team').length === 9, 'edit_team not sent')
    assert.equal(calls(mock, 'edit_player')[0].shirt_number, 99)
    assert.equal(calls(mock, 'add_player').length, 80)
    await context.close()
  }

  // --- Bad rows and a missing column: each listed by row, the import disabled.
  {
    const { context, mock, page } = await fresh()
    await teamsTab(page)
    await choose(page, `${HEAD}Alpha,A,,A One,4,2001-01-01\r\nAlpha,AL,red,B Two,4,2001-01-01\r\nAlpha,AL,,C Three,5,2001-13-01\r\nAlpha,AL,,D Four,5,2001-01-01\r\n`)
    await text(page, 'Row 2: team code "A" must be 2 to 5 letters or digits.').waitFor()
    await text(page, 'Row 3: kit colour "red" must be a hash and six hex digits, or be blank.').waitFor()
    await page.getByText(/^Row 4: date of birth "2001-13-01"/).waitFor()
    assert.ok(await button(page, 'Import teams and players').isDisabled())
    await noScroll(page)
    await choose(page, 'team_name,team_code,kit_colour,player_name,shirt_number\r\nAlpha,AL,,A One,4\r\n')
    await text(page, 'The header row is missing the column date_of_birth.').waitFor()
    assert.ok(await button(page, 'Import teams and players').isDisabled())
    assert.equal(mock.calls.length, 0)
    await context.close()
  }

  // --- Quoted field and CRLF; a Squad over the limit.
  {
    const { context, mock, page } = await fresh()
    await teamsTab(page)
    await choose(page, `${HEAD}"Thapa, FC",TFC,#d71920,"Ram ""Rocky"" Thapa, Jr.",7,2002-02-02\r\n`)
    await text(page, 'Adds 1 Team and 1 Player.').waitFor()
    await button(page, 'Import 1 team and 1 player').click()
    await until(page, async () => calls(mock, 'add_player').length === 1, 'player not sent')
    assert.equal(calls(mock, 'add_team')[0].name, 'Thapa, FC')
    assert.equal(calls(mock, 'add_player')[0].name, 'Ram "Rocky" Thapa, Jr.')
    await context.close()
  }
  {
    const { context, mock, page } = await fresh({ limit: 2 })
    await teamsTab(page)
    await choose(page, `${HEAD}Alpha,AL,,A One,4,2001-01-01\nAlpha,AL,,B Two,5,2001-01-01\nAlpha,AL,,C Three,6,2001-01-01\n`)
    await text(page, 'Row 2: Alpha would have 3 Players; the Season allows at most 2.').waitFor()
    assert.ok(await button(page, 'Import teams and players').isDisabled())
    assert.equal(mock.calls.length, 0)
    await context.close()
  }

  // --- Offline: queued in order, counted by the Save status, sent on return.
  {
    const { context, mock, page } = await fresh()
    await teamsTab(page)
    await choose(page, `${HEAD}Alpha,AL,#d71920,A One,4,2001-01-01\n${'Alpha,AL,#d71920,B Two,5,2001-01-01'}\n`)
    await text(page, 'Adds 1 Team and 2 Players.').waitFor()
    mock.down = true
    await context.setOffline(true)
    await button(page, 'Import 1 team and 2 players').click()
    await page.getByText(/The import will be sent when the signal is back\./).waitFor()
    assert.equal(await outboxCount(page), 5)
    assert.equal(mock.calls.length, 0)
    await page.getByText(/5 changes/).first().waitFor()
    mock.down = false
    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await until(page, async () => calls(mock, 'add_player').length === 2, 'queued commands not sent')
    assert.deepEqual(mock.calls.map((c) => c.cmd), ['open_registration', 'add_team', 'edit_team', 'add_player', 'add_player'])
    await context.close()
  }

  // --- A file that is not UTF-8 (an Excel ANSI export) is refused, not read with replacement characters.
  {
    const { context, mock, page } = await fresh()
    await teamsTab(page)
    await page.locator('input[type=file]').setInputFiles({ name: 'teams.csv', mimeType: 'text/csv', buffer: Buffer.concat([Buffer.from(HEAD + 'Caf'), Buffer.from([0xe9]), Buffer.from(',CF,,A One,4,2001-01-01\n')]) })
    await text(page, "Couldn't read that file. Choose a CSV file saved as UTF-8.").waitFor()
    assert.equal(mock.calls.length, 0)
    await context.close()
  }

  // --- Started Season: the control is hidden.
  {
    const { context, page } = await fresh({ season: { status: 'started' } })
    await teamsTab(page)
    await text(page, "Teams can't be added once the Season has started.").waitFor()
    assert.equal(await page.locator('input[type=file]').count(), 0)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
