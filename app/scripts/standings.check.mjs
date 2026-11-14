// Story 3.4 standings check: group tables and the bracket from the database functions, "Shootout needed" and the record sheet, the order
// flipping, the frozen-slot refusal, resolved sides on cards, offline keeps the last read. Real Chrome, Supabase mocked by route interception.
// `npm run check:standings`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const outDir = 'node_modules/.standings-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4199 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email: 'org@example.com', exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'org@example.com', email_confirmed_at: '2026-11-08T00:00:00Z',
    app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}
const tid = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`
const mid = (n) => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`
const CODES = ['RTM', 'TUF', 'GFC', 'BYC', 'HFC', 'NSC', 'PUN', 'AFC']
const teams = CODES.map((c, i) => ({ id: tid(i + 1), name: `${c} United`, code: c, kit_colour: '#1d4ed8', status: 'approved', registration_link: [], version: 1 }))
const slots = CODES.map((_, i) => ({ id: `66666666-0000-4000-8000-${String(i).padStart(12, '0')}`, grp: Math.floor(i / 4) + 1, pos: (i % 4) + 1, team_id: tid(i + 1) }))
// Group A: RTM and TUF level (shootout needed); Group B settled. Semi-finals A1 v B2 and B1 v A2, then the Final.
const row = (grp, pos, t, pts, extra = {}) => ({ grp, pos, team_id: tid(t), p: 3, w: pts / 3, d: 0, l: 3 - pts / 3, gf: pts, ga: 3, gd: pts - 3, pts, group_done: true,
  provisional: false, shootout_with: null, ...extra })
const standingsBefore = () => [row(1, 1, 1, 6, { provisional: true, shootout_with: tid(2) }), row(1, 2, 2, 6, { provisional: true, shootout_with: tid(1) }),
  row(1, 3, 3, 3), row(1, 4, 4, 0), row(2, 1, 5, 9), row(2, 2, 6, 6), row(2, 3, 7, 3), row(2, 4, 8, 0)]
const standingsAfter = () => [row(1, 1, 2, 6), row(1, 2, 1, 6), row(1, 3, 3, 3), row(1, 4, 4, 0), row(2, 1, 5, 9), row(2, 2, 6, 6), row(2, 3, 7, 3), row(2, 4, 8, 0)]
const matchRows = [
  { id: mid(1), stage: 'knockout', round: 'SF', label: 'SF1', ord: 1, home_team_id: null, away_team_id: null, home_src: 'A1', away_src: 'B2', kick_off: null, version: 1 },
  { id: mid(2), stage: 'knockout', round: 'SF', label: 'SF2', ord: 2, home_team_id: null, away_team_id: null, home_src: 'B1', away_src: 'A2', kick_off: null, version: 1 },
  { id: mid(3), stage: 'knockout', round: 'Final', label: 'Final', ord: 3, home_team_id: null, away_team_id: null, home_src: 'Winner SF1', away_src: 'Winner SF2', kick_off: null, version: 1 },
]
const sidesBefore = () => [{ match_id: mid(1), home_team_id: tid(1), away_team_id: tid(6) }, { match_id: mid(2), home_team_id: tid(5), away_team_id: tid(2) },
  { match_id: mid(3), home_team_id: null, away_team_id: null }]
const sidesAfter = () => [{ match_id: mid(1), home_team_id: tid(2), away_team_id: tid(6) }, { match_id: mid(2), home_team_id: tid(5), away_team_id: tid(1) },
  { match_id: mid(3), home_team_id: null, away_team_id: null }]

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/** mock.standings / mock.sides: what the functions answer; mock.refuse: the code the next shootout command is refused with; mock.down: unreachable. */
async function fresh({ structure = 'groups_knockout', standings = standingsBefore(), sides = sidesBefore() } = {}) {
  const season = { id: S, number: 1, status: 'started', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
    starts_on: '2033-11-07', ends_on: '2033-11-21', registration_deadline: '2033-11-03', structure, group_count: 2, teams_per_group: 4, qualifiers_per_group: 2 }
  const mock = { standings, sides, calls: [], refuse: null }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    }
    if (path === '/rest/v1/team') return json(route, teams)
    if (path === '/rest/v1/draw_slot') return json(route, slots)
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/rpc/standings') return json(route, mock.standings)
    if (path === '/rest/v1/rpc/match_sides') return json(route, mock.sides)
    if (path === '/rest/v1/match') return json(route, matchRows)
    if (path === '/rest/v1/season') return json(route, [{ fixtures_published_at: '2026-11-12T00:00:00Z' }])
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    if (cmd === 'record_tiebreak_shootout') {
      if (mock.refuse) return json(route, { ok: false, code: mock.refuse, message: 'x' })
      mock.standings = standingsAfter()
      mock.sides = sidesAfter()
    }
    return json(route, { ok: true, code: null, message: 'ok' })
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${base}/t/${T}`)
  await page.getByRole('tab', { name: 'Matches' }).click()
  return { context, mock, page }
}

const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const button = (page, name) => page.getByRole('button', { name, exact: true })
const text = (page, t) => page.getByText(t, { exact: true })
const rowsOf = (page, caption) => page.locator('.standings', { has: page.locator('caption', { hasText: caption }) }).locator('tbody tr')
const firstTeam = async (page, caption) => (await rowsOf(page, caption).first().locator('th').innerText()).replace(/\s*\*$/, '')
const cardText = (page, meta) => page.locator('.match-card', { hasText: new RegExp(`^${meta}`) }).innerText()

try {
  // --- Tables and bracket from the functions; the tie says a shootout is needed; slots resolve on the cards.
  {
    const { context, page } = await fresh()
    await rowsOf(page, 'Group A').first().waitFor()
    assert.equal(await rowsOf(page, 'Group A').count(), 4)
    assert.equal(await rowsOf(page, 'Group B').count(), 4)
    assert.deepEqual(await page.locator('.standings').first().locator('thead th').allInnerTexts(), ['Team', 'P', 'W', 'D', 'L', 'GF', 'GA', 'GD', 'Pts'])
    assert.equal(await firstTeam(page, 'Group B'), 'HFC')
    assert.equal((await rowsOf(page, 'Group B').first().innerText()).replace(/\s+/g, ' '), 'HFC 3 3 0 0 9 3 6 9')
    await text(page, 'Shootout needed: RTM v TUF').waitFor()
    assert.equal(await page.getByText(/Shootout needed/).count(), 1)
    assert.match(await cardText(page, 'SF · SF1'), /RTM\s+v\s+NSC/)
    assert.match(await cardText(page, 'Final'), /Winner SF1\s+v\s+Winner SF2/)
    const bracket = page.getByRole('region', { name: 'Knockout bracket' })
    assert.match(await bracket.innerText(), /Winner SF1\s+v\s+Winner SF2/)
    assert.match(await bracket.innerText(), /SF1\s+RTM\s+v\s+NSC/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
    // Record the shootout: choose the winner; the order flips, the slots follow, the notice is polite.
    assert.equal(await firstTeam(page, 'Group A'), 'RTM')
    await button(page, 'Record the shootout').click()
    await page.getByRole('dialog', { name: 'Who won the shootout?' }).waitFor()
    await button(page, 'Record TUF as the winner').click()
    await text(page, 'Shootout recorded').waitFor()
    await until(page, async () => (await firstTeam(page, 'Group A')) === 'TUF', 'order flips')
    assert.equal(await page.getByText(/Shootout needed/).count(), 0)
    assert.equal(await button(page, 'Record the shootout').count(), 0)
    await until(page, async () => /TUF\s+v\s+NSC/.test(await cardText(page, 'SF · SF1')), 'cards use resolved sides')
    await context.close()
  }
  // --- The command carries both Teams; a refusal for a frozen slot is said in words and changes nothing.
  {
    const { context, mock, page } = await fresh()
    mock.refuse = 'downstream_started'
    await button(page, 'Record the shootout').click()
    await button(page, 'Record RTM as the winner').click()
    await text(page, "The next Match has started, so this result can't change who plays in it.").waitFor()
    const c = mock.calls.filter((x) => x.cmd === 'record_tiebreak_shootout')
    assert.equal(c.length, 1)
    assert.deepEqual([c[0].winner_team_id, c[0].loser_team_id, c[0].season_id], [tid(1), tid(2), S])
    assert.equal(await firstTeam(page, 'Group A'), 'RTM')
    await text(page, 'Shootout needed: RTM v TUF').waitFor()
    mock.refuse = 'shootout_not_needed'
    await button(page, 'Record the shootout').click()
    await button(page, 'Record TUF as the winner').click()
    await page.getByText(/no shootout is needed/).waitFor()
    await context.close()
  }
  // --- Unreachable: the last read stays; the shootout action says it needs a signal.
  {
    const { context, mock, page } = await fresh()
    await text(page, 'Shootout needed: RTM v TUF').waitFor()
    mock.down = true
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(500)
    await rowsOf(page, 'Group A').first().waitFor()
    assert.equal(await rowsOf(page, 'Group B').count(), 4)
    await text(page, 'Shootout needed: RTM v TUF').waitFor()
    await context.close()
  }
  // --- A League: one table, no bracket.
  {
    const { context, page } = await fresh({ structure: 'league', standings: standingsBefore().filter((r) => r.grp === 2).map((r) => ({ ...r, grp: 0 })), sides: [] })
    await rowsOf(page, 'League table').first().waitFor()
    assert.equal(await rowsOf(page, 'League table').count(), 4)
    await context.close()
  }
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
