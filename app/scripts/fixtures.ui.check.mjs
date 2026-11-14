// Story 3.2 fixtures UI check: the Suggest fixtures action (disabled until the Draw is complete), Match cards, replace confirm,
// offline, server refusal, League, knockout with byes, started Season. Real Chrome, Supabase mocked by route interception.
// `npm run check:fixtures`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const outDir = 'node_modules/.fixtures-dist'
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
const tid = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`
const CODES = ['RTM', 'TUF', 'GFC', 'BYC', 'HFC', 'NSC', 'PUN', 'AFC']
const teamRow = (id, name, code, status) => ({ id, name, code, kit_colour: '#1d4ed8', status, registration_link: [] })
const approvedTeams = () => CODES.map((c, i) => teamRow(tid(i + 1), `${c} United`, c, 'approved'))
const extra = () => [teamRow(tid(20), 'Sent FC', 'SNT', 'submitted'), teamRow(tid(21), 'Back FC', 'RET', 'returned'), teamRow(tid(22), 'Gone FC', 'WDR', 'withdrawn')]

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/** mock.slots: draw_slot rows; mock.calls: every command body; mock.answers[cmd]: answers to give first; mock.down: unreachable. */
async function fresh({ structure = 'groups_knockout', status = 'registration', teams = [...approvedTeams(), ...extra()], slots = [], matches = [] } = {}) {
  const season = { id: S, number: 1, status, setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
    starts_on: '2033-11-07', ends_on: '2033-11-21', registration_deadline: '2033-11-03', structure, group_count: 2, teams_per_group: 4, qualifiers_per_group: 2 }
  const mock = { teams, slots, matches, calls: [] }
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
    if (path === '/rest/v1/team') return json(route, mock.teams.map((t) => ({ ...t, version: 1 })))
    if (path === '/rest/v1/draw_slot') return json(route, mock.slots)
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/match') return json(route, mock.matches)
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    if (cmd === 'suggest_fixtures') {
      mock.matches = a.fixtures.map((f) => ({ ...f, home_team_id: f.home_team, away_team_id: f.away_team, kick_off: null }))
    }
    return json(route, { ok: true, code: null, message: 'Fixtures suggested.' })
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${base}/t/${T}`)
  await page.getByRole('tab', { name: 'Matches' }).click()
  return { context, mock, page }
}

const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
const text = (page, t) => page.getByText(t, { exact: true })
const full = (n) => Array.from({ length: n }, (_, i) => ({ id: `66666666-0000-4000-8000-${String(i).padStart(12, '0')}`, grp: Math.floor(i / 4) + 1, pos: (i % 4) + 1, team_id: tid(i + 1) }))
const card = (page, meta) => page.locator('.match-card', { hasText: new RegExp(`^${meta}`) })

try {
  // --- Draw incomplete: the action is disabled and says why.
  {
    const { context, page } = await fresh({ slots: full(5) })
    await text(page, 'Record the whole draw first.').waitFor()
    assert.equal(await button(page, 'Suggest fixtures').isDisabled(), true)
    await context.close()
  }
  // --- 2 groups of 4: Suggest sends 15 Fixtures in one command; cards show the path; offline says so; again asks first.
  {
    const { context, mock, page } = await fresh({ slots: full(8) })
    await button(page, 'Suggest fixtures').click()
    await card(page, 'SF · SF1').waitFor()
    const sent = calls(mock, 'suggest_fixtures')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].fixtures.length, 15)
    assert.equal(sent[0].replace, false)
    assert.equal(sent[0].fixtures.slice(0, 12).filter((f, i, all) => i && [f.home_team, f.away_team].some((t) => [all[i - 1].home_team, all[i - 1].away_team].includes(t))).length, 0)
    assert.equal(await page.locator('.match-card').count(), 15)
    assert.match(await card(page, 'SF · SF1').innerText(), /SF · SF1\s+A1\s+v\s+B2\s+Kick-off not set/)
    assert.match(await card(page, 'SF · SF2').innerText(), /B1\s+v\s+A2/)
    assert.match(await card(page, 'Final').innerText(), /Winner SF1\s+v\s+Winner SF2/)
    assert.match(await page.locator('.match-card').first().innerText(), /Group [AB]\s+[A-Z]{3}\s+v\s+[A-Z]{3}/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
    assert.equal(await button(page, 'Suggest fixtures').count(), 0)

    await button(page, 'Suggest fixtures again').click()
    await page.getByRole('dialog', { name: 'Replace the 15 suggested Fixtures?' }).waitFor()
    await button(page, 'Cancel').click()
    assert.equal(calls(mock, 'suggest_fixtures').length, 1)
    await button(page, 'Suggest fixtures again').click()
    await button(page, 'Replace the Fixtures').click()
    await until(page, async () => calls(mock, 'suggest_fixtures').length === 2, 'second send')
    assert.equal(calls(mock, 'suggest_fixtures')[1].replace, true)

    await context.setOffline(true)
    await text(page, 'Suggesting fixtures needs a signal.').waitFor()
    assert.equal(await button(page, 'Suggest fixtures again').count(), 0)
    await context.setOffline(false)

    // Tap a card: the minimal Match detail.
    await card(page, 'SF · SF1').click()
    await page.getByRole('heading', { name: 'Match' }).waitFor()
    await text(page, 'SF · SF1').waitFor()
    await text(page, 'Kick-off not set').waitFor()
    await context.close()
  }
  // --- A server refusal is said in words.
  {
    const { context, mock, page } = await fresh({ slots: full(8) })
    await context.route(`${SUPA}/rest/v1/rpc/suggest_fixtures`, (route) => route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'draw_incomplete', message: 'x' }) }))
    await button(page, 'Suggest fixtures').click()
    await text(page, 'Record the whole Draw first, then suggest the Fixtures.').waitFor()
    assert.equal(await page.locator('.match-card').count(), 0)
    await context.close()
  }
  // --- League: every pair once, no knockout.
  {
    const six = approvedTeams().slice(0, 6)
    const { context, mock, page } = await fresh({ structure: 'league', teams: six })
    await button(page, 'Suggest fixtures').click()
    await until(page, async () => (await page.locator('.match-card').count()) === 15, '15 league cards')
    const fx = calls(mock, 'suggest_fixtures')[0].fixtures
    assert.ok(fx.every((f) => f.stage === 'league'))
    assert.equal(new Set(fx.map((f) => [f.home_team, f.away_team].sort().join())).size, 15)
    assert.equal(await page.locator('.draw').count(), 0)
    await context.close()
  }
  // --- Knockout 6: slots 1 and 2 get a bye; the card shows a set kick-off in BS and AD.
  {
    const slots = Array.from({ length: 6 }, (_, i) => ({ id: `66666666-0000-4000-8000-${String(i).padStart(12, '0')}`, grp: 0, pos: i + 1, team_id: tid(i + 1) }))
    const { context, mock, page } = await fresh({ structure: 'knockout', teams: approvedTeams().slice(0, 6), slots })
    await button(page, 'Suggest fixtures').click()
    await card(page, 'QF · QF2').waitFor()
    assert.equal(await page.locator('.match-card').count(), 5)
    assert.match(await card(page, 'SF · SF1').innerText(), /RTM \(Bye\)\s+v\s+Winner QF1/)
    assert.equal(calls(mock, 'suggest_fixtures')[0].fixtures.filter((f) => f.home_src === 'Bye').length, 2)
    await context.close()
  }
  // --- Started: cards only, no suggest action, no Draw board; a kick-off shows BS and AD.
  {
    const m = [{ id: '77777777-0000-4000-8000-000000000001', stage: 'knockout', round: 'Final', label: 'Final', ord: 1, home_team_id: tid(1), away_team_id: tid(2),
      home_src: null, away_src: null, kick_off: '2026-10-31T10:00:00Z' }]
    const { context, page } = await fresh({ status: 'started', slots: full(8), matches: m })
    await card(page, 'Final').waitFor()
    assert.match(await card(page, 'Final').innerText(), /Saturday · Kartik 14, 2083 BS \(31 Oct 2026\) · 15:45/)
    assert.equal(await page.getByRole('button', { name: /^Suggest fixtures/ }).count(), 0)
    assert.equal(await page.locator('.draw').count(), 0)
    await context.close()
  }
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
