// Story 4.2 console check: "Score this match" on the Matches tab and on an approved Scorer phone, the full-screen console (no Tab bar), the
// Pre-match step (tick lists, counters, reasons, swap, kit clash), Confirm line-ups, Show on stream, Leave console, a Match held by another
// phone. Real Chrome, Supabase mocked by route interception. `npm run check:console`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ORG = '00000000-0000-4000-8000-000000000001'
const ANON = '00000000-0000-4000-8000-0000000000a1'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const DEVICE = '33333333-0000-4000-8000-000000000001'
const outDir = 'node_modules/.console-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4198 } })
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
const tid = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`
const mid = (n) => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`
const pid = (t, n) => `88888888-0000-4000-8000-${String(t).padStart(6, '0')}${String(n).padStart(6, '0')}`
const TEAMS = [{ id: tid(1), name: 'Red Tigers', code: 'RTM', kit: '#ff0000', n: 16 }, { id: tid(2), name: 'Eight Eagles', code: 'RE8', kit: '#0000ff', n: 10 },
  { id: tid(3), name: 'Green FC', code: 'GFC', kit: '#00aa00', n: 10 }]
const byId = (id) => TEAMS.find((t) => t.id === id)
const squad = (t) => Array.from({ length: t.n }, (_, i) => ({ player_id: pid(TEAMS.indexOf(t) + 1, i + 1), name: `${t.code} Player ${i + 1}`, shirt: i + 1 }))

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

// M1 and M2 scheduled, M3 live. holders: who holds each Match ('org', 'phone', 'other'); lineups: confirmed per Match.
const mock = { calls: [], holders: {}, lineups: {}, onAir: null }
const matches = [
  { id: mid(1), stage: 'group', round: 'Group A', label: null, ord: 1, home_team_id: tid(1), away_team_id: tid(2), status: 'scheduled', kick_off: '2026-10-31T10:00:00Z' },
  { id: mid(2), stage: 'group', round: 'Group A', label: null, ord: 2, home_team_id: tid(1), away_team_id: tid(3), status: 'scheduled', kick_off: null },
  { id: mid(3), stage: 'group', round: 'Group A', label: null, ord: 3, home_team_id: tid(2), away_team_id: tid(3), status: 'live', kick_off: null },
].map((m) => ({ home_src: null, away_src: null, version: 1, ...m }))

function consoleFor(who, id) {
  const m = matches.find((x) => x.id === id)
  if (!m) return null
  const lu = mock.lineups[id]
  const ids = lu ? lu.map((l) => l.team_id) : [m.home_team_id, m.away_team_id]
  const teams = ids.map((t, i) => ({ team_id: t, name: byId(t).name, code: byId(t).code, registered_kit: byId(t).kit, side: i === 0 ? 'home' : 'away', squad: squad(byId(t)),
    lineup: lu ? { starters: lu[i].starters, bench: lu[i].bench, kit_colour: lu[i].kit_colour, version: 1 } : null }))
  return { match: { id, season_id: S, tournament_id: T, stage: m.stage, round: m.round, label: m.label, kick_off: m.kick_off, status: m.status, season_status: 'started' },
    rules: { starters: 5, max_bench: 9 }, holder: mock.holders[id] === who, held: !!mock.holders[id], on_air: mock.onAir === id, teams }
}

async function ctx(who) {
  const organiser = who === 'org'
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session(organiser ? ORG : ANON, !organiser)))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1,
        season: [{ id: S, number: 1, status: 'started', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'x', starts_on: '2026-10-01', ends_on: '2026-12-21',
          registration_deadline: '2026-09-20', structure: 'groups_knockout', group_count: 2, teams_per_group: 4, qualifiers_per_group: 2 }] }])
    }
    if (path === '/rest/v1/team') return json(route, TEAMS.map((t) => ({ id: t.id, name: t.name, code: t.code, kit_colour: t.kit, status: 'approved', version: 1, registration_link: [] })))
    if (path === '/rest/v1/match') return json(route, matches)
    if (path === '/rest/v1/season') return json(route, [{ fixtures_published_at: '2026-09-25T00:00:00Z' }])
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd, who })
    if (cmd === 'scorer_status') return json(route, [{ id: DEVICE, season_id: S, label: "Bikash's phone", expires_at: new Date(Date.now() + 600_000).toISOString(), status: 'approved' }])
    if (cmd === 'scorer_matches') {
      return json(route, [matches[0], matches[2]].map((m) => ({ match_id: m.id, ord: m.ord, round: m.round, label: m.label, kick_off: m.kick_off, status: m.status,
        home_code: byId(m.home_team_id).code, away_code: byId(m.away_team_id).code, held: !!mock.holders[m.id], mine: mock.holders[m.id] === who })))
    }
    if (cmd === 'console_match') return json(route, consoleFor(who, a.p_match_id))
    if (cmd === 'take_scoring') {
      const h = mock.holders[a.match_id]
      if (h && h !== who) return json(route, { ok: false, code: 'scoring_elsewhere', message: 'Another phone is scoring this match.' })
      mock.holders[a.match_id] = who
      return json(route, { ok: true, code: null, message: 'ok' })
    }
    if (cmd === 'confirm_lineups') return (mock.lineups[a.match_id] = [a.home, a.away], json(route, { ok: true, code: null, message: 'ok' }))
    if (cmd === 'show_on_stream') return (mock.onAir = a.match_id, json(route, { ok: true, code: null, message: 'ok' }))
    return json(route, { ok: true, code: null, message: 'ok' })
  })
  await context.addInitScript(([k, v]) => localStorage.setItem(k, v), organiser ? ['sb-fake-auth-token', JSON.stringify(session(ORG, false))] : ['tsl-score-auth', JSON.stringify(session(ANON, true))])
  if (!organiser) await context.addInitScript(([k, v]) => localStorage.setItem(k, v), [`tsl-scorer-device:${TOKEN}`, DEVICE])
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, page }
}
const text = (page, t) => page.getByText(t, { exact: true })
const button = (page, name) => page.getByRole('button', { name, exact: true })
const calls = (name) => mock.calls.filter((c) => c.cmd === name)

try {
  // --- Organiser: "Score this match" on the next scheduled Match and the live one only.
  const org = await ctx('org')
  const op = org.page
  await op.goto(`${base}/t/${T}`)
  await op.getByRole('tab', { name: 'Matches' }).click()
  await op.locator('.match-card').first().waitFor()
  assert.equal(await button(op, 'Score this match').count(), 2)
  assert.equal(await op.locator('li', { hasText: /RTM\s*v\s*RE8/  }).getByRole('button', { name: 'Score this match' }).count(), 1)
  assert.equal(await op.locator('li', { hasText: /RTM\s*v\s*GFC/  }).getByRole('button', { name: 'Score this match' }).count(), 0)

  // Open the console: full screen, this phone holds scoring, strip with the title and the BS and AD date.
  await op.locator('li', { hasText: /RTM\s*v\s*RE8/  }).getByRole('button', { name: 'Score this match' }).click()
  await op.waitForURL(`**/t/${T}/score/${mid(1)}`)
  await text(op, 'RTM v RE8').waitFor()
  assert.equal(calls('take_scoring').length, 1)
  assert.equal(await op.getByRole('tablist').count(), 0, 'Tab bar in the console')
  assert.equal(await op.locator('header.home-bar').count(), 0, 'App bar in the console')
  await button(op, 'Leave console').waitFor()
  assert.match(await op.locator('.console-date').innerText(), /Saturday · Kartik 14, 2083 BS \(31 Oct 2026\)/)
  assert.equal(await text(op, '● On the stream').count(), 0)
  assert.equal(await op.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')

  // Counters and reasons.
  await text(op, 'Starting 0 of 5 · Bench 0 of 9').first().waitFor()
  await text(op, "Line-up needs 5 starters. You've picked 0.").waitFor()
  assert.equal(await button(op, 'Confirm line-ups').isDisabled(), true)
  const tick = (code, n, bench) => op.getByLabel(bench ? `Put ${code} Player ${n} on the bench` : `Start ${code} Player ${n}`, { exact: true })
  for (let n = 1; n <= 4; n++) await tick('RTM', n).check()
  await text(op, 'Starting 4 of 5 · Bench 0 of 9').waitFor()
  await text(op, "Line-up needs 5 starters. You've picked 4.").waitFor()
  await tick('RTM', 5).check()
  for (let n = 6; n <= 15; n++) await tick('RTM', n, true).check()
  await text(op, 'Starting 5 of 5 · Bench 10 of 9').waitFor()
  await text(op, "Bench can hold up to 9. You've picked 10.").waitFor()
  await tick('RTM', 15, true).uncheck()
  await text(op, 'Starting 5 of 5 · Bench 9 of 9').waitFor()
  // Picking a starter as bench moves them: one place only.
  await tick('RTM', 5, true).check()
  assert.equal(await tick('RTM', 5).isChecked(), false)
  await text(op, 'Starting 4 of 5 · Bench 10 of 9').waitFor()
  await tick('RTM', 5).check()
  await tick('RTM', 14, true).uncheck()
  for (let n = 1; n <= 5; n++) await tick('RE8', n).check()
  await tick('RE8', 6, true).check()
  assert.equal(await button(op, 'Confirm line-ups').isDisabled(), false)
  assert.equal(await op.locator('.ui-reason').count(), 0)

  // Kit clash: contrast 1.5:1 or less warns and says what to do; another colour clears it.
  const kit = (code) => op.getByLabel(`Kit colour for ${code}`, { exact: true })
  assert.equal(await text(op, 'RTM and RE8 kits look alike.').count(), 0)
  await kit('RTM').fill('#ffffff')
  await kit('RE8').fill('#fafafa')
  await text(op, 'RTM and RE8 kits look alike.').waitFor()
  await text(op, 'Pick another colour for the away Team.').waitFor()
  assert.equal(await button(op, 'Confirm line-ups').isDisabled(), false, 'a kit clash must not block confirming')
  await kit('RE8').fill('#0000ff')
  assert.equal(await text(op, 'RTM and RE8 kits look alike.').count(), 0)
  // Kit dots always carry the ring and the Team code.
  assert.equal(await op.locator('.kit-chip').first().innerText(), 'RTM')
  assert.match(await op.locator('.kit-chip .ui-kit-dot').first().evaluate((e) => getComputedStyle(e).borderTopWidth), /^[1-9]/)

  // Swap: the sides exchange in the title and the order.
  await button(op, 'Swap home and away').click()
  await text(op, 'RE8 v RTM').waitFor()
  assert.equal(await op.locator('.prematch-head .meta').first().innerText(), 'Home')
  assert.match(await op.locator('.prematch-head').first().innerText(), /RE8/)

  // Confirm: both lineups go in one command, home first.
  await button(op, 'Confirm line-ups').click()
  await text(op, 'Line-ups confirmed.').waitFor()
  const sent = calls('confirm_lineups')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].home.team_id, tid(2))
  assert.equal(sent[0].away.team_id, tid(1))
  assert.deepEqual([sent[0].home.starters.length, sent[0].home.bench.length, sent[0].away.starters.length, sent[0].away.bench.length], [5, 1, 5, 8])
  assert.deepEqual([sent[0].home.kit_colour, sent[0].away.kit_colour], ['#0000ff', '#ffffff'])
  assert.equal(sent[0].match_id, mid(1))

  // Show on stream: the strip shows it, in live red, only for this Match.
  await button(op, 'Show on stream').click()
  await text(op, '● On the stream').waitFor()
  assert.equal(calls('show_on_stream').length, 1)
  assert.equal(await button(op, 'Show on stream').count(), 0)
  const live = await op.evaluate(() => getComputedStyle(document.querySelector('.console-air')).color)
  assert.equal(live, 'rgb(215, 25, 32)')

  // Leave: back on the Matches tab with the polite note; nothing else changes.
  const before = mock.calls.length
  await button(op, 'Leave console').click()
  await op.waitForURL(`**/t/${T}`)
  await text(op, 'The clock keeps running.').waitFor()
  assert.equal(await op.getByRole('tab', { name: 'Matches' }).getAttribute('aria-selected'), 'true')
  assert.deepEqual(mock.calls.slice(before).filter((c) => ['take_scoring', 'confirm_lineups', 'show_on_stream'].includes(c.cmd)), [])

  // Reopen: the saved lineups show and the Match is still the On-air Match.
  await op.goto(`${base}/t/${T}/score/${mid(1)}`)
  await text(op, 'RE8 v RTM').waitFor()
  await text(op, 'Starting 5 of 5 · Bench 1 of 9').waitFor()
  await text(op, '● On the stream').waitFor()

  // A Match held by another phone opens read-only.
  mock.holders[mid(2)] = 'other'
  await op.goto(`${base}/t/${T}/score/${mid(2)}`)
  await text(op, 'Another phone is scoring this match.').waitFor()
  assert.equal(await button(op, 'Confirm line-ups').count(), 0)
  assert.equal(await op.getByLabel('Start RTM Player 1', { exact: true }).isDisabled(), true)
  assert.equal(await text(op, '● On the stream').count(), 0)
  assert.equal(mock.holders[mid(2)], 'other')

  // --- Scorer phone: lists the live Match and the next scheduled one in place of "No Match on air yet.", no navigation.
  const ph = await ctx('phone')
  const pp = ph.page
  await pp.goto(`${base}/score#${TOKEN}`)
  await pp.locator('.match-card').first().waitFor()
  assert.equal(await pp.getByRole('button', { name: 'Score this match', exact: true }).count(), 2)
  assert.equal(await text(pp, 'No Match on air yet.').count(), 0)
  assert.equal(await pp.locator('a, nav, [role="tab"]').count(), 0, 'navigation on the Scorer page')
  await pp.locator('.match-card', { hasText: 'Live' }).getByRole('button', { name: 'Score this match' }).click()
  await pp.waitForURL(`**/score/${mid(3)}#${TOKEN}`)
  await text(pp, 'RE8 v GFC').waitFor()
  assert.equal(mock.holders[mid(3)], 'phone')
  assert.equal(await pp.locator('a, nav, [role="tab"]').count(), 0, 'navigation in the Scorer console')
  assert.deepEqual(await pp.evaluate(() => Object.keys(localStorage).filter((k) => /auth/.test(k))), ['tsl-score-auth'])
  await button(pp, 'Leave console').click()
  await pp.waitForURL(`**/score#${TOKEN}`)
  await text(pp, 'The clock keeps running.').waitFor()
  await pp.locator('.match-card').first().waitFor()

  // A console of a Match the caller may not read is the unavailable screen.
  await pp.goto(`${base}/score/${mid(9)}#${TOKEN}`)
  await pp.getByRole('main').waitFor()
  await pp.waitForTimeout(300)
  assert.equal(await button(pp, 'Leave console').count() + (await pp.getByLabel(/^Start /).count()), 0, 'a Match the phone cannot read opened')
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
