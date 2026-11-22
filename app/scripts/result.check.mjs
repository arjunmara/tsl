// Story 4.6 result check: the whistle (End the match stops the clock on the phone and opens the Awards sheet), the shootout step for a level knockout Match,
// Skip and Cancel, Finish match, then on the Match page the FT result, Awards edit, goal corrections and "Type the result", each behind a Confirm sheet, and the FT pill
// on the Matches tab. Real Chrome, Supabase mocked by route interception (the rules themselves are checked on Postgres by check.sh). `npm run check:result`.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ORG = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const outDir = 'node_modules/.result-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4200 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ORG, email: 'org@example.com', exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ORG, aud: 'authenticated', role: 'authenticated', email: 'org@example.com', email_confirmed_at: '2026-11-08T00:00:00Z', app_metadata: {}, user_metadata: {},
    identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}
const tid = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`
const mid = (n) => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`
const pid = (t, n) => `88888888-0000-4000-8000-${String(t).padStart(6, '0')}${String(n).padStart(6, '0')}`
const TEAMS = [{ id: tid(1), name: 'Red Tigers', code: 'RTM', kit: '#ff0000' }, { id: tid(2), name: 'Eight Eagles', code: 'RE8', kit: '#0000ff' }]
const squad = (i) => Array.from({ length: 8 }, (_, n) => ({ player_id: pid(i + 1, n + 1), name: `${TEAMS[i].code} Player ${n + 1}`, shirt: n + 1 }))

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

const rules = { starters: 3, max_bench: 9, periods: 2, extra_time_periods: 0, period_minutes: 20, extra_time_minutes: 5, substitutions: 'rolling' }
const goal = (id, team, player, extra = {}) => ({ id, kind: 'goal', period: 2, minute: 3, entered_at: new Date(Date.now() - 600000).toISOString(), home: null, away: null, team_id: team,
  player_id: player, assist_id: null, own_goal: false, version: 1, ...extra })
const goals = (prefix, home, away) => [...Array.from({ length: home }, (_, i) => goal(`${prefix}0000-4000-8000-0000000000a${i}`, tid(1), pid(1, i + 1))),
  ...Array.from({ length: away }, (_, i) => goal(`${prefix}0000-4000-8000-0000000000b${i}`, tid(2), pid(2, i + 1)))]
const frozen = { running: false, anchor_at: new Date().toISOString(), elapsed_ms: 330000, period: 2, interval: false }
// M1 group live 2-1; M2 knockout live 3-3; M3 knockout live 2-1; M4 knockout finished 4-4 (pens 5-3, the 4th RTM goal has no scorer); M5 group scheduled; M6 knockout scheduled.
const mock = { calls: [], refuse: {}, events: {
  [mid(1)]: goals('e1', 2, 1), [mid(2)]: goals('e2', 3, 3), [mid(3)]: goals('e3', 2, 1),
  [mid(4)]: [...goals('e4', 3, 4), goal('e4000000-0000-4000-8000-0000000000c0', tid(1), null)], [mid(5)]: [], [mid(6)]: [] } }
const matches = [
  { n: 1, stage: 'group', status: 'live' }, { n: 2, stage: 'knockout', status: 'live' }, { n: 3, stage: 'knockout', status: 'live' },
  { n: 4, stage: 'knockout', status: 'finished', hg: 4, ag: 4, home_pens: 5, away_pens: 3, mom: pid(1, 1), fair: pid(2, 1) },
  { n: 5, stage: 'group', status: 'scheduled' }, { n: 6, stage: 'knockout', status: 'scheduled' },
].map((m) => ({ id: mid(m.n), round: m.stage === 'group' ? 'Group A' : 'Final', label: null, ord: m.n, home_team_id: tid(1), away_team_id: tid(2), home_src: null, away_src: null, kick_off: null,
  version: 1, hg: null, ag: null, home_pens: null, away_pens: null, ...m }))

function consoleFor(id) {
  const m = matches.find((x) => x.id === id)
  const teams = TEAMS.map((t, i) => ({ team_id: t.id, name: t.name, code: t.code, registered_kit: t.kit, side: i === 0 ? 'home' : 'away', squad: squad(i),
    lineup: m.status === 'scheduled' ? null : { starters: [1, 2, 3].map((n) => pid(i + 1, n)), bench: [4, 5].map((n) => pid(i + 1, n)), kit_colour: t.kit, version: 1 } }))
  return { match: { id, season_id: S, tournament_id: T, stage: m.stage, round: m.round, label: null, kick_off: null, status: m.status, season_status: 'started', version: m.version,
    home_team_id: tid(1), away_team_id: tid(2), home_pens: m.home_pens, away_pens: m.away_pens, mom_player_id: m.mom ?? null, fair_player_id: m.fair ?? null },
    rules, clock: m.status === 'scheduled' ? { running: false, anchor_at: null, elapsed_ms: 0, period: 0, interval: false } : frozen, score: { home: 0, away: 0 },
    events: mock.events[id], holder: true, held: true, on_air: false, teams }
}

function eventCommand(cmd, a) {
  if (mock.refuse[cmd]) return { ok: false, ...mock.refuse[cmd] }
  const list = mock.events[a.match_id] ?? Object.values(mock.events).find((l) => l.some((e) => e.id === a.event_id))
  if (cmd === 'record_goal') list.unshift(goal(a.command_id, a.team_id, a.player_id, { period: a.period, minute: a.minute, own_goal: a.own_goal }))
  const e = list.find((x) => x.id === a.event_id)
  if (cmd === 'edit_event') Object.assign(e, { player_id: a.player_id, minute: a.minute ?? e.minute, version: e.version + 1 })
  if (cmd === 'delete_event') list.splice(list.indexOf(e), 1)
  return { ok: true, code: null, message: 'Saved.', version: e?.version }
}

const season = { id: S, number: 1, status: 'started', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
  starts_on: '2033-11-07', ends_on: '2033-11-21', registration_deadline: '2033-11-03', structure: 'groups_knockout', group_count: 2, teams_per_group: 4, qualifiers_per_group: 2 }
async function page(scorer = false) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    if (path === '/rest/v1/team') return json(route, TEAMS.map((t) => ({ id: t.id, name: t.name, code: t.code, kit_colour: t.kit, status: 'approved', registration_link: [], version: 1 })))
    if (path === '/rest/v1/match') return json(route, matches)
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    if (cmd === 'console_match') return json(route, consoleFor(a.p_match_id))
    if (/^(standings|match_sides)$/.test(cmd)) return json(route, [])
    if (/^(record_goal|edit_event|delete_event|add_assist)$/.test(cmd)) return json(route, (mock.calls.push({ ...a, cmd, seen: Date.now() }), eventCommand(cmd, a)))
    if (/^(end_match|set_awards|type_result)$/.test(cmd)) {
      mock.calls.push({ ...a, cmd, seen: Date.now() })
      return json(route, mock.refuse[cmd] ? { ok: false, ...mock.refuse[cmd] } : { ok: true, code: null, message: 'ok', version: 2 })
    }
    return json(route, { ok: true, code: null, message: 'ok' })
  })
  if (scorer) {
    // A Scorer's phone: its own anonymous session and device token (see console.check.mjs).
    const anon = session()
    anon.user = { ...anon.user, is_anonymous: true, email: undefined }
    await context.addInitScript(([k, v]) => localStorage.setItem(k, v), ['tsl-score-auth', JSON.stringify(anon)])
    await context.addInitScript(([k, v]) => localStorage.setItem(k, v), [`tsl-scorer-device:${'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'}`, '33333333-0000-4000-8000-000000000001'])
  } else await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  const p = await context.newPage()
  await p.emulateMedia({ colorScheme: 'light' })
  return p
}
const text = (p, t) => p.getByText(t, { exact: true })
const button = (p, name) => p.getByRole('button', { name, exact: true })
const dialog = (p) => p.getByRole('dialog')
const calls = (name) => mock.calls.filter((c) => c.cmd === name)
const sent = async (name, n) => { for (let i = 0; i < 60 && calls(name).length < n; i++) await new Promise((r) => setTimeout(r, 100)); assert.equal(calls(name).length, n, `${name} sent`) }
const closed = (p) => p.waitForFunction(() => !document.querySelector('dialog[open]'))
const heading = (p) => dialog(p).getByRole('heading').first().innerText()
const tiles = (p) => dialog(p).locator('.picker-tile').allInnerTexts().then((l) => l.map((t) => t.replace(/\s+/g, ' ').trim()))
const whistle = async (p, n, score) => {
  await p.goto(`${base}/t/${T}/score/${mid(n)}`)
  await text(p, 'RTM v RE8').waitFor()
  await button(p, 'End the match').click()
  assert.equal(await heading(p), `End the match at ${score}?`)
  await dialog(p).getByRole('button', { name: 'End the match', exact: true }).click()
  await dialog(p).getByRole('heading', { name: 'Finish the match' }).waitFor()
}

try {
  const op = await page()

  // Group Match 2-1: the whistle sends nothing; the Awards sheet has no shootout; Skip is allowed; Cancel keeps the clock stopped and Finish match comes back.
  await whistle(op, 1, '2–1')
  assert.equal(calls('end_match').length, 0, 'the whistle sent end_match')
  assert.equal(await dialog(op).getByText('Shootout', { exact: true }).count(), 0, 'a shootout for a group Match')
  await dialog(op).getByRole('button', { name: 'Pick Man of the Match', exact: true }).click()
  await text(op, 'Who is the Man of the Match?').waitFor()
  assert.deepEqual(await dialog(op).locator('h3').allInnerTexts(), ['Red Tigers', 'Eight Eagles'])
  const all = await tiles(op)
  assert.equal(all.length, 11, 'both line-ups (5 each) and Skip')
  assert.deepEqual([all[0], all[4], all[5], all[10]], ['RTM Player 1 1', 'RTM Player 5 5', 'RE8 Player 1 1', 'Skip'])
  await dialog(op).getByRole('button', { name: 'RTM Player 2', exact: false }).click()
  await text(op, 'Man of the Match: RTM Player 2').waitFor()
  await dialog(op).getByRole('button', { name: 'Cancel', exact: true }).click()
  await closed(op)
  assert.equal(calls('end_match').length, 0)
  assert.equal(await button(op, 'Resume clock').count() + (await button(op, 'End the match').count()), 0, 'the clock controls came back after Cancel')
  await button(op, 'Finish match').click()
  await dialog(op).getByRole('button', { name: 'Finish match', exact: true }).click()
  await sent('end_match', 1)
  const e1 = calls('end_match')[0]
  assert.deepEqual([e1.match_id, e1.expected_version, e1.home_pens, e1.away_pens, e1.mom_player_id, e1.fair_player_id], [mid(1), 1, null, null, pid(1, 2), null])
  assert.ok(Math.abs(Date.parse(e1.at) - Date.now()) < 20000, 'at is the whistle')
  // Story 5.4: the Organiser's Finish match goes on to the Post-match pack.
  await op.waitForURL(`**/t/${T}/m/${mid(1)}/pack`)

  // Knockout 3-3: the shootout comes first and needs a winner.
  await whistle(op, 2, '3–3')
  const sheet = await dialog(op).innerText()
  assert.ok(sheet.indexOf('Shootout') >= 0 && sheet.indexOf('Shootout') < sheet.indexOf('Man of the Match'), 'the shootout is first')
  await dialog(op).getByRole('button', { name: 'Finish match', exact: true }).click()
  await text(op, 'Enter the shootout result.').waitFor()
  await dialog(op).getByLabel('RTM shootout goals').fill('4')
  await dialog(op).getByLabel('RE8 shootout goals').fill('4')
  await dialog(op).getByRole('button', { name: 'Finish match', exact: true }).click()
  await text(op, 'A shootout needs a winner.').waitFor()
  assert.equal(calls('end_match').length, 1)
  await dialog(op).getByLabel('RTM shootout goals').fill('5')
  await dialog(op).getByLabel('RE8 shootout goals').fill('3')
  await dialog(op).getByRole('button', { name: 'Finish match', exact: true }).click()
  await sent('end_match', 2)
  assert.deepEqual([calls('end_match')[1].home_pens, calls('end_match')[1].away_pens, calls('end_match')[1].mom_player_id], [5, 3, null])

  // Knockout 2-1: no shootout step.
  await whistle(op, 3, '2–1')
  assert.equal(await dialog(op).getByText('Shootout', { exact: true }).count(), 0, 'a shootout for a decided knockout Match')
  await dialog(op).getByRole('button', { name: 'Finish match', exact: true }).click()
  await sent('end_match', 3)
  assert.equal(calls('end_match')[2].home_pens, null)

  // The Scorer console stays where it is after Finish match (no pack).
  const sc = await page(true)
  await sc.goto(`${base}/score/${mid(3)}#AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde`)
  await text(sc, 'RTM v RE8').waitFor()
  await button(sc, 'End the match').click()
  await dialog(sc).getByRole('button', { name: 'End the match', exact: true }).click()
  await dialog(sc).getByRole('heading', { name: 'Finish the match' }).waitFor()
  await dialog(sc).getByRole('button', { name: 'Finish match', exact: true }).click()
  await sent('end_match', 4)
  await sent('end_match', 4)
  await new Promise((r) => setTimeout(r, 500))
  assert.ok(new URL(sc.url()).pathname.startsWith(`/score/${mid(3)}`), `the Scorer left the console: ${sc.url()}`)

  // Entry points: the finished Match card's link and the Graphics tab (newest first, "No finished Matches yet" when none).
  await op.goto(`${base}/t/${T}`)
  const packLinks = op.getByRole('link', { name: 'Open the post-match pack' })
  await packLinks.first().waitFor()
  assert.equal(await packLinks.count(), 1, 'a pack link on an unfinished Match')
  await packLinks.click()
  await op.waitForURL(`**/t/${T}/m/${mid(4)}/pack`)
  const tabs = async () => {
    await op.goto(`${base}/t/${T}`)
    await op.getByRole('tab', { name: 'Graphics', exact: true }).click()
  }
  const saved = [matches[0], matches[1]].map((m) => ({ ...m }))
  Object.assign(matches[0], { status: 'finished', hg: 2, ag: 1 })
  Object.assign(matches[1], { status: 'finished', hg: 3, ag: 3 })
  await tabs()
  const entries = op.getByRole('link').filter({ hasText: / · / })
  await entries.first().waitFor()
  assert.deepEqual(await entries.allInnerTexts(), ['RTM 4–4 RE8 · Final', 'RTM 3–3 RE8 · Final', 'RTM 2–1 RE8 · Group A'])
  assert.deepEqual(await entries.evaluateAll((l) => l.map((a) => new URL(a.href).pathname.split('/').slice(-2).join('/'))), [`${mid(4)}/pack`, `${mid(2)}/pack`, `${mid(1)}/pack`])
  await entries.nth(2).click()
  await op.waitForURL(`**/t/${T}/m/${mid(1)}/pack`)
  matches.forEach((m) => { if (m.status === 'finished') m.status = 'live' })
  await tabs()
  await text(op, 'No finished Matches yet').waitFor()
  Object.assign(matches[0], saved[0])
  Object.assign(matches[1], saved[1])
  matches[3].status = 'finished'

  // The Match page of a finished Match: FT result, Awards edit, corrections.
  await op.goto(`${base}/t/${T}/m/${mid(4)}`)
  await op.getByRole('heading', { name: /FT\s+4–4 · pens 5–3/ }).waitFor()
  await text(op, 'Man of the Match: RTM Player 1').waitFor()
  await button(op, 'Change Man of the Match').click()
  await dialog(op).getByRole('button', { name: 'RE8 Player 2', exact: false }).click()
  assert.equal(await heading(op), 'Change Man of the Match from RTM Player 1 to RE8 Player 2?')
  await dialog(op).getByRole('button', { name: 'Save Awards', exact: true }).click()
  await sent('set_awards', 1)
  const aw = calls('set_awards')[0]
  assert.deepEqual([aw.match_id, aw.expected_version, aw.mom_player_id, aw.fair_player_id], [mid(4), 1, pid(2, 2), pid(2, 1)])

  // Delete a goal: a Confirm sheet; the server says the next round has started and the goal stays.
  mock.refuse.delete_event = { code: 'downstream_started', message: "This can't change: the next round has already started." }
  const rows = () => op.locator('[data-goal]').count()
  const before = await rows()
  await op.locator('[data-goal]').first().getByRole('button').click()
  await dialog(op).getByRole('button', { name: 'Delete goal', exact: true }).click()
  assert.match(await heading(op), /^Delete the 3′ goal by .*The score becomes \d–\d\.$/)
  await dialog(op).getByRole('button', { name: 'Delete goal', exact: true }).click()
  await sent('delete_event', 1)
  await text(op, "This can't change: the next round has already started.").waitFor()
  assert.equal(await rows(), before, 'a refused delete changed the log')
  delete mock.refuse.delete_event

  // Name later: the unknown-scorer goal gets a Player; Confirm sheet first.
  await op.locator('[data-goal]', { hasText: 'Unknown scorer' }).getByRole('button').click()
  await dialog(op).getByRole('button', { name: 'RTM Player 4', exact: false }).click()
  await dialog(op).getByRole('button', { name: 'Save goal', exact: true }).click()
  assert.equal(await heading(op), 'Change the 3′ goal from Unknown scorer to RTM Player 4?')
  assert.equal(calls('edit_event').length, 0)
  await dialog(op).getByRole('button', { name: 'Save goal', exact: true }).click()
  await sent('edit_event', 1)
  assert.deepEqual([calls('edit_event')[0].player_id, calls('edit_event')[0].own_goal], [pid(1, 4), false])

  // Record a goal for the other Team.
  await button(op, 'Record goal for RE8').click()
  await text(op, 'Who scored for Eight Eagles?').waitFor()
  await dialog(op).getByRole('button', { name: 'Unknown scorer', exact: true }).click()
  assert.match(await heading(op), /^Add a goal for RE8 by unknown scorer\? The score becomes \d–\d\.$/)
  await dialog(op).getByRole('button', { name: 'Save goal', exact: true }).click()
  await sent('record_goal', 1)
  assert.deepEqual([calls('record_goal')[0].team_id, calls('record_goal')[0].player_id, calls('record_goal')[0].period], [tid(2), null, 2])

  // Type the result on a scheduled group Match: no shootout fields.
  await op.goto(`${base}/t/${T}/m/${mid(5)}`)
  await op.getByRole('heading', { name: 'Type the result' }).waitFor()
  assert.equal(await button(op, 'Change Man of the Match').count(), 0)
  await op.getByLabel('RTM goals').fill('3')
  await op.getByLabel('RE8 goals').fill('1')
  assert.equal(await op.getByLabel('RTM shootout goals').count(), 0)
  await button(op, 'Save result').click()
  assert.equal(await heading(op), 'Save RTM 3–1 RE8 as the final result?')
  await dialog(op).getByRole('button', { name: 'Save result', exact: true }).click()
  await sent('type_result', 1)
  const tr = calls('type_result')[0]
  assert.deepEqual([tr.match_id, tr.expected_version, tr.home, tr.away, tr.home_pens, tr.away_pens], [mid(5), 1, 3, 1, null, null])

  // A level knockout Match asks for the shootout.
  await op.goto(`${base}/t/${T}/m/${mid(6)}`)
  await op.getByLabel('RTM goals').fill('2')
  await op.getByLabel('RE8 goals').fill('2')
  await op.getByLabel('RTM shootout goals').waitFor()
  await button(op, 'Save result').click()
  await text(op, 'Enter the shootout result.').waitFor()
  await op.getByLabel('RTM shootout goals').fill('3')
  await op.getByLabel('RE8 shootout goals').fill('3')
  await button(op, 'Save result').click()
  await text(op, 'A shootout needs a winner.').waitFor()
  await op.getByLabel('RE8 shootout goals').fill('3')
  await op.getByLabel('RTM shootout goals').fill('5')
  await button(op, 'Save result').click()
  assert.equal(await heading(op), 'Save RTM 2–2 RE8 (pens 5–3) as the final result?')
  assert.equal(calls('type_result').length, 1)

  // The Matches tab: the finished Match shows an FT pill with the score and the shootout.
  await op.goto(`${base}/t/${T}`)
  await op.getByRole('tab', { name: 'Matches' }).click()
  const card = op.locator('.match-card', { hasText: 'FT' })
  await card.waitFor()
  assert.equal(await card.count(), 1)
  assert.match(await card.innerText(), /FT\s+4–4 · pens 5–3/)
  assert.equal(await op.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
