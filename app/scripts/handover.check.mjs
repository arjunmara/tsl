// Story 4.8 check: hand over and take over scoring with three pages (Bikash's phone, Ana's phone, an Organiser). Read-only console with the holder's name,
// Hand over sheet (disabled while changes wait), ask / waiting / declined / expired, approve, the Organiser's direct Take over with its Confirm sheet,
// switching within the 2 s poll (one poll in flight at a time) and the prompt polling only while a Match is live or today. Real Chrome, Supabase mocked.
// `npm run check:handover`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ORG = '00000000-0000-4000-8000-000000000001'
const IDS = { bikash: '00000000-0000-4000-8000-0000000000a1', ana: '00000000-0000-4000-8000-0000000000a2' }
const LABEL = { bikash: "Bikash's phone", ana: "Ana's phone" }
const DEV = { bikash: '33333333-0000-4000-8000-000000000001', ana: '33333333-0000-4000-8000-000000000002' }
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const M = '77777777-0000-4000-8000-000000000001'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const outDir = 'node_modules/.handover-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4201 } })
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
const pid = (t, n) => `88888888-0000-4000-8000-${String(t).padStart(6, '0')}${String(n).padStart(6, '0')}`
const TEAMS = [{ id: tid(1), name: 'Red Tigers', code: 'RTM', kit: '#ff0000' }, { id: tid(2), name: 'Eight Eagles', code: 'RE8', kit: '#0000ff' }]
const squad = (i) => Array.from({ length: 7 }, (_, k) => ({ player_id: pid(i + 1, k + 1), name: `${TEAMS[i].code} Player ${k + 1}`, shirt: k + 1 }))

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

// The one Match: live, held by `holder` ('bikash', 'ana' or 'org'). requests: asks by phone. rows: what the Organiser's Match list holds.
const mock = { down: null, prev: null, movedAt: 0, goals: [], calls: [], holder: 'bikash', version: 4, requests: [], rows: [], inflight: 0, maxInflight: 0, nextReq: 1 }
const calls = (name) => mock.calls.filter((c) => c.cmd === name)
// A tap sends its command a moment later: wait up to 5 s for the count.
const called = async (name, n) => { for (let i = 0; i < 50 && calls(name).length < n; i++) await new Promise((r) => setTimeout(r, 100)); assert.equal(calls(name).length, n, `${name} sent ${calls(name).length} times`) }
const label = (who) => (who === 'org' ? null : LABEL[who])
const askStatus = (r) => (r.status === 'pending' && r.expires < Date.now() ? 'expired' : r.status)
// A move changes no version; the old holder keeps a grace of 3 s for changes entered before the move (the server's is an hour).
const move = (to) => { mock.prev = mock.holder; mock.movedAt = Date.now(); mock.holder = to; mock.requests = [] }

function consoleFor(who) {
  const teams = TEAMS.map((t, i) => ({ team_id: t.id, name: t.name, code: t.code, registered_kit: t.kit, side: i === 0 ? 'home' : 'away', squad: squad(i),
    lineup: { starters: [1, 2, 3, 4, 5].map((n) => pid(i + 1, n)), bench: [6, 7].map((n) => pid(i + 1, n)), kit_colour: t.kit, version: 1 } }))
  return { match: { id: M, season_id: S, tournament_id: T, stage: 'group', round: 'Group A', label: null, kick_off: null, status: 'live', season_status: 'started', version: mock.version,
    home_team_id: tid(1), away_team_id: tid(2) },
    rules: { starters: 5, max_bench: 9, periods: 2, extra_time_periods: 0 }, clock: { running: false, anchor_at: null, elapsed_ms: 60000, period: 1, interval: false },
    score: { home: 0, away: 0 }, events: [], holder: mock.holder === who, held: true, on_air: false, teams }
}
function stateFor(who) {
  const mine = mock.holder === who
  const req = [...mock.requests].reverse().find((r) => r.who === who)
  return { version: mock.version, stamp: '0', status: 'live', held: true, mine, holder_label: label(mock.holder),
    request: req ? { id: req.id, status: askStatus(req) } : null,
    devices: mine ? Object.keys(DEV).filter((k) => k !== who).map((k) => ({ id: DEV[k], label: LABEL[k] })) : [] }
}

async function ctx(who) {
  const organiser = who === 'org'
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session(organiser ? ORG : IDS[who], !organiser)))
  await context.route(`${SUPA}/rest/v1/**`, async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    // No signal for one phone: its requests fail as a dropped connection does.
    if (mock.down === who) return route.abort('connectionfailed')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/match') return json(route, mock.rows)
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd, who })
    if (cmd === 'console_match') return json(route, consoleFor(who))
    if (cmd === 'scoring_state') {
      // One poll in flight at a time per phone: the answer takes a moment.
      mock.inflight++
      mock.maxInflight = Math.max(mock.maxInflight, mock.inflight)
      await new Promise((r) => setTimeout(r, 250))
      mock.inflight--
      return json(route, stateFor(who))
    }
    if (cmd === 'take_scoring') return json(route, { ok: false, code: 'scoring_elsewhere', message: 'Another phone is scoring this match.' })
    if (cmd === 'hand_over_scoring') {
      if (mock.holder !== who) return json(route, { ok: false, code: 'not_scoring_device', message: 'x' })
      if (a.expected_version !== mock.version) return json(route, { ok: false, code: 'version_conflict', message: 'x' })
      move(Object.keys(DEV).find((k) => DEV[k] === a.device_id))
      return json(route, { ok: true, code: null, message: 'ok' })
    }
    if (cmd === 'ask_take_over') {
      mock.requests.push({ id: `req-${mock.nextReq++}`, who, status: 'pending', expires: Date.now() + 120_000 })
      return json(route, { ok: true, code: null, message: 'ok' })
    }
    if (cmd === 'takeover_requests') {
      return json(route, mock.requests.filter((r) => askStatus(r) === 'pending').map((r) => ({ id: r.id, match_id: M, season_id: S, label: LABEL[r.who], home_code: 'RTM', away_code: 'RE8',
        holder_label: label(mock.holder), expires_at: new Date(r.expires).toISOString(), version: 1 })))
    }
    if (cmd === 'approve_take_over' || cmd === 'decline_take_over') {
      const r = mock.requests.find((x) => x.id === a.request_id)
      if (!r || askStatus(r) !== 'pending') return json(route, { ok: false, code: 'request_expired', message: 'x' })
      if (cmd === 'decline_take_over') r.status = 'declined'
      else move(r.who)
      return json(route, { ok: true, code: null, message: 'ok' })
    }
    if (cmd === 'take_over_scoring') return (move('org'), json(route, { ok: true, code: null, message: 'ok' }))
    if (cmd === 'record_goal') {
      const entered = Date.parse(req.headers()['x-entered-at'] ?? a.at)
      if (mock.holder !== who && !(mock.prev === who && entered < mock.movedAt + 3000)) return json(route, { ok: false, code: 'not_scoring_device', message: 'x' })
      mock.goals.push(a.player_id)
      return json(route, { ok: true, code: null, message: 'ok', version: 1 })
    }
    if (cmd === 'start_clock') mock.version++
    return json(route, { ok: true, code: null, message: 'ok' })
  })
  if (organiser) await context.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-fake-auth-token', JSON.stringify(session(ORG, false))])
  else await context.addInitScript(([k, v]) => localStorage.setItem(k, v), ['tsl-score-auth', JSON.stringify(session(IDS[who], true))])
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, page }
}
const text = (page, t) => page.getByText(t, { exact: true })
const button = (page, name) => page.getByRole('button', { name, exact: true })
const gone = async (page, t) => assert.equal(await text(page, t).count(), 0, `${t} still shown`)
const SCORER_URL = `${base}/score/${M}#${TOKEN}`
const ORG_URL = `${base}/t/${T}/score/${M}`

try {
  // The Organiser's prompt does not poll while the Tournament has no live Match and none today.
  const org = await ctx('org')
  const op = org.page
  await op.goto(ORG_URL)
  await text(op, "Scoring on Bikash's phone.").waitFor()
  await op.waitForTimeout(3600)
  assert.equal(calls('takeover_requests').length, 0, 'the prompt polled with no live Match')
  // A live Match: a new page polls.
  mock.rows = [{ status: 'live', kick_off: null }]
  await op.goto(ORG_URL)
  await text(op, "Scoring on Bikash's phone.").waitFor()
  await op.waitForFunction(() => true)
  await op.waitForTimeout(1500)
  assert.ok(calls('takeover_requests').length >= 1, 'the prompt did not poll for a live Match')

  const bk = await ctx('bikash')
  const bp = bk.page
  await bp.goto(SCORER_URL)
  const an = await ctx('ana')
  const ap = an.page
  await ap.goto(SCORER_URL)

  // Read-only: the holder's name, no clock or event buttons, Ask to take over (a Scorer phone) or Take over scoring (an Organiser).
  mock.holder = 'bikash'
  await text(ap, "Scoring on Bikash's phone.").waitFor()
  await button(ap, 'Ask to take over').waitFor()
  for (const name of ['Resume clock', 'Pause clock', 'Open scoreboard menu']) assert.equal(await button(ap, name).count(), 0, `${name} on a read-only console`)
  assert.equal(await ap.getByRole('button', { name: /^GOAL/ }).count(), 0)
  await text(op, "Scoring on Bikash's phone.").waitFor()
  await button(op, 'Take over scoring').waitFor()
  assert.equal(await button(op, 'Ask to take over').count(), 0)
  assert.equal(await button(bp, 'Ask to take over').count(), 0, 'the holder can ask')
  await button(bp, 'Resume clock').waitFor()

  // One poll in flight at a time; every few seconds, and no full console read repeating every 5 s.
  const reads = calls('console_match').length
  const polls = calls('scoring_state').filter((c) => c.who === 'ana').length
  await ap.waitForTimeout(4600)
  const more = calls('scoring_state').filter((c) => c.who === 'ana').length - polls
  assert.ok(more >= 1 && more <= 3, `scoring_state polls in 4.6 s: ${more}`)
  assert.equal(mock.maxInflight <= 3, true, 'more than one poll per phone in flight')
  assert.equal(calls('console_match').length, reads, 'the console was read again with nothing moved')

  // Hand over: needs the waiting changes sent first. Offline, the clock tap waits in the queue and the sheet is disabled with its reason.
  mock.down = 'bikash'
  await button(bp, 'Resume clock').click()
  await button(bp, 'Open scoreboard menu').click()
  await button(bp, 'Hand over scoring').click()
  await text(bp, 'Send the waiting changes first.').waitFor()
  assert.equal(await button(bp, "Hand over to Ana's phone").isDisabled(), true)
  assert.equal(await button(bp, "Hand over to Bikash's phone").count(), 0, 'the holder can hand over to itself')
  mock.down = null
  await bp.evaluate(() => window.dispatchEvent(new Event('online')))
  await text(bp, 'Send the waiting changes first.').waitFor({ state: 'detached', timeout: 15000 })
  assert.equal(await button(bp, "Hand over to Ana's phone").isDisabled(), false)
  await button(bp, "Hand over to Ana's phone").click()
  const hand = calls('hand_over_scoring')
  assert.equal(hand.length, 1)
  assert.deepEqual([hand[0].match_id, hand[0].season_id, hand[0].device_id, hand[0].expected_version], [M, S, DEV.ana, mock.version])
  // Both consoles switch within the 2 s poll.
  const t0 = Date.now()
  await text(bp, "Scoring on Ana's phone.").waitFor({ timeout: 4500 })
  await button(ap, 'Pause clock').or(button(ap, 'Resume clock')).waitFor({ timeout: 4500 })
  assert.ok(Date.now() - t0 < 4500)
  await gone(ap, "Scoring on Bikash's phone.")
  assert.equal(await button(bp, 'Resume clock').count(), 0, 'the old holder kept the clock buttons')
  await button(bp, 'Ask to take over').waitFor()

  // Ask, Keep: the Organiser's prompt names the Match and both phones, its buttons are 64px; the decline reaches the asker.
  await button(bp, 'Ask to take over').click()
  await text(bp, 'Waiting for an organiser to approve.').waitFor()
  await text(op, "Bikash's phone asks to take over scoring of RTM v RE8 from Ana's phone.").waitFor({ timeout: 6000 })
  for (const name of ["Let Bikash's phone score", "Keep Ana's phone"]) assert.ok((await button(op, name).boundingBox()).height >= 64, `${name} is under 64px`)
  await button(op, "Keep Ana's phone").click()
  await called('decline_take_over', 1)
  await text(bp, "The organiser said no. Ana's phone keeps scoring.").waitFor({ timeout: 4500 })
  await text(op, "Bikash's phone asks to take over scoring of RTM v RE8 from Ana's phone.").waitFor({ state: 'detached', timeout: 6000 })
  await gone(ap, "Scoring on Bikash's phone.")

  // Ask again, Let: the holder moves even though Ana's phone is not asked.
  await button(bp, 'Ask to take over').click()
  await text(bp, 'Waiting for an organiser to approve.').waitFor()
  await button(op, "Let Bikash's phone score").waitFor({ timeout: 6000 })
  await button(op, "Let Bikash's phone score").click()
  await called('approve_take_over', 1)
  await button(bp, 'Pause clock').or(button(bp, 'Resume clock')).waitFor({ timeout: 4500 })
  await text(ap, "Scoring on Bikash's phone.").waitFor({ timeout: 4500 })

  // Expire: after 2 minutes the asker reads "This request expired." with Ask again, and the prompt is gone.
  await button(ap, 'Ask to take over').click()
  await text(ap, 'Waiting for an organiser to approve.').waitFor()
  await button(op, "Let Ana's phone score").waitFor({ timeout: 6000 })
  mock.requests.at(-1).expires = Date.now() - 1
  await text(ap, 'This request expired.').waitFor({ timeout: 4500 })
  await button(ap, 'Ask again to take over').waitFor()
  await button(op, "Let Ana's phone score").waitFor({ state: 'detached', timeout: 6000 })
  assert.equal(await text(ap, 'Waiting for an organiser to approve.').count(), 0)

  // An answer that comes after the request expired says so and takes the prompt away.
  await button(ap, 'Ask again to take over').click()
  await button(op, "Let Ana's phone score").waitFor({ timeout: 6000 })
  mock.requests.at(-1).expires = Date.now() - 1
  await button(op, "Let Ana's phone score").click()
  await text(op, 'That request expired. Ask the Scorer to ask again.').waitFor()
  assert.equal(mock.holder, 'bikash')

  // The Organiser takes over directly: a Confirm sheet first; then the old phones read "an organiser's phone".
  await button(op, 'Take over scoring').click()
  await text(op, "Take over scoring from Bikash's phone?").waitFor()
  assert.equal(calls('take_over_scoring').length, 0, 'took over before confirming')
  await op.getByRole('dialog').getByRole('button', { name: 'Take over scoring', exact: true }).click()
  await called('take_over_scoring', 1)
  await text(bp, "Scoring on an organiser's phone.").waitFor({ timeout: 4500 })
  await text(ap, "Scoring on an organiser's phone.").waitFor({ timeout: 4500 })
  await text(op, "Scoring on Bikash's phone.").waitFor({ state: 'detached' })
  await button(op, 'Resume clock').waitFor()
  assert.equal(await button(op, 'Take over scoring').count(), 0, 'the new holder can take over from itself')

  // The old phone is dead (its page is closed): an Organiser takes scoring over anyway.
  move('ana')
  await text(op, "Scoring on Ana's phone.").waitFor({ timeout: 4500 })
  await ap.close()
  await button(op, 'Take over scoring').click()
  await op.getByRole('dialog').getByRole('button', { name: 'Take over scoring', exact: true }).click()
  await button(op, 'Resume clock').waitFor({ timeout: 4500 })
  assert.equal(mock.holder, 'org')

  // Comeback: Bikash's phone is offline and still thinks it scores. A goal entered before the move is kept; one entered after it is handed back and the console turns read-only.
  mock.holder = 'bikash'
  await bp.goto(SCORER_URL)
  await button(bp, 'Open scoreboard menu').waitFor()
  mock.down = 'bikash'
  await button(bp, 'GOAL RTM').click()
  await bp.getByRole('dialog').getByRole('button', { name: 'RTM Player 1', exact: false }).first().click()
  await bp.waitForTimeout(600)
  move('ana')
  await bp.waitForTimeout(3600)
  await button(bp, 'GOAL RTM').click()
  await bp.getByRole('dialog').getByRole('button', { name: 'RTM Player 2', exact: false }).first().click()
  mock.down = null
  await bp.evaluate(() => window.dispatchEvent(new Event('online')))
  await text(bp, "Scoring on Ana's phone.").waitFor({ timeout: 8000 })
  for (let i = 0; i < 40 && calls('record_goal').length < 2; i++) await bp.waitForTimeout(100)
  assert.deepEqual(mock.goals, [pid(1, 1)], 'only the goal entered before the move is kept')
  await bp.getByRole('alert').getByText("Couldn't save").waitFor()
  assert.equal(await button(bp, 'Open scoreboard menu').count(), 0, 'the old holder kept its menu')
  await button(bp, 'Ask to take over').waitFor()

  // A phone with no signal can't ask; it says so.
  mock.down = 'bikash'
  await button(bp, 'Ask to take over').click()
  await text(bp, 'Moving scoring needs a signal. Check your signal, then try again.').waitFor()
  assert.equal(await op.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
