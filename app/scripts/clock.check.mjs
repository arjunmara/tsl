// Story 4.3 clock check: Start, Pause and Resume clock, two pages within 1 s, the period button (2 x 20 without extra time, knockout with extra time),
// Period dividers newest first, Correct the clock, End the match (focus on Cancel), wake lock on return, an offline pause. Real Chrome, Supabase mocked
// by route interception. `npm run check:clock`. Needs Google Chrome.
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
const outDir = 'node_modules/.clock-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4199 } })
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

// M1: group Match, 2 periods, no extra time. M2: knockout Match with 2 extra-time periods. Both have line-ups and are held by the organiser's phone.
const lineup = (t) => ({ team_id: t, starters: [pid(1, 1)], bench: [], kit_colour: '#ff0000' })
const mock = { calls: [], events: {}, now: Date.now() }
const matches = [
  { id: mid(1), stage: 'group', round: 'Group A', label: null, ord: 1, home_team_id: tid(1), away_team_id: tid(2), status: 'scheduled', kick_off: null, et: 0 },
  { id: mid(2), stage: 'knockout', round: 'Final', label: 'F', ord: 2, home_team_id: tid(1), away_team_id: tid(3), status: 'scheduled', kick_off: null, et: 2 },
].map((m) => ({ home_src: null, away_src: null, version: 1, clock: { running: false, anchor_at: null, elapsed_ms: 0, period: 0, interval: false }, ...m }))
for (const m of matches) mock.events[m.id] = []

function consoleFor(id) {
  const m = matches.find((x) => x.id === id)
  const teams = [m.home_team_id, m.away_team_id].map((t, i) => ({ team_id: t, name: byId(t).name, code: byId(t).code, registered_kit: byId(t).kit, side: i === 0 ? 'home' : 'away',
    squad: squad(byId(t)), lineup: { starters: [pid(TEAMS.indexOf(byId(t)) + 1, 1)], bench: [], kit_colour: byId(t).kit, version: 1 } }))
  return { match: { id, season_id: S, tournament_id: T, stage: m.stage, round: m.round, label: m.label, kick_off: m.kick_off, status: m.status, season_status: 'started', version: m.version },
    rules: { starters: 1, max_bench: 9, periods: 2, extra_time_periods: m.et }, clock: m.clock, score: { home: 0, away: 0 }, events: mock.events[id],
    holder: true, held: true, on_air: false, teams }
}

// The server's rules for a clock command, as the migration decides them.
function step(m, cmd, a) {
  const c = m.clock
  const at = Math.min(Date.parse(a.at), Date.now())
  const el = c.elapsed_ms + (c.running ? at - Date.parse(c.anchor_at) : 0)
  const to = (p) => ({ ...c, anchor_at: new Date(at).toISOString(), ...p })
  const ev = (kind, period, ms) => mock.events[m.id].unshift({ id: a.command_id, kind, period, minute: Math.floor(ms / 60000), entered_at: new Date(at).toISOString(), home: 0, away: 0 })
  if (cmd === 'start_clock') {
    if (c.period === 0) { m.status = 'live'; m.clock = to({ running: true, elapsed_ms: 0, period: 1 }); ev('period_start', 1, 0) } else m.clock = to({ running: true })
  } else if (cmd === 'pause_clock') m.clock = to({ running: false, elapsed_ms: el })
  else if (cmd === 'set_clock') { m.clock = to({ elapsed_ms: a.elapsed_ms }); ev('clock_set', c.period, a.elapsed_ms) }
  else if (cmd === 'end_match') { m.status = 'finished'; m.clock = to({ running: false, elapsed_ms: el }); ev('match_end', c.period, el) }
  else if (c.interval || (c.period === 2 && m.et)) { m.clock = to({ running: true, elapsed_ms: 0, period: c.period + 1, interval: false }); ev('period_start', c.period + 1, 0) }
  else { m.clock = to({ running: false, elapsed_ms: el, interval: true }); ev('period_end', c.period, el) }
  m.version += 1
}

async function ctx() {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session(ORG, false)))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (mock.offline) return route.abort('internetdisconnected')
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    if (cmd === 'console_match') return json(route, consoleFor(a.p_match_id))
    if (/^(take_scoring|start_clock|pause_clock|next_period|set_clock|end_match)$/.test(cmd)) {
      mock.calls.push({ ...a, cmd, seen: Date.now() })
      if (cmd !== 'take_scoring') {
        const m = matches.find((x) => x.id === a.match_id)
        if (m.version !== a.expected_version) return json(route, { ok: false, code: 'version_conflict', message: 'Someone else changed this first.' })
        step(m, cmd, a)
      }
    }
    return json(route, { ok: true, code: null, message: 'ok' })
  })
  await context.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-fake-auth-token', JSON.stringify(session(ORG, false))])
  // A wake lock that is released when the page is hidden, as Chrome does.
  await context.addInitScript(() => {
    window.__locks = []
    Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => {
      const lock = { released: false, release: async () => { lock.released = true } }
      window.__locks.push(lock)
      return lock
    } } })
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') window.__locks.forEach((l) => { l.released = true }) })
  })
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, page }
}
const text = (page, t) => page.getByText(t, { exact: true })
const button = (page, name) => page.getByRole('button', { name, exact: true })
const calls = (name) => mock.calls.filter((c) => c.cmd === name)
const sent = async (name, n) => { for (let i = 0; i < 60 && calls(name).length < n; i++) await new Promise((r) => setTimeout(r, 100)); assert.equal(calls(name).length, n, `${name} sent`) }
const secs = (t) => { const [m, s] = t.split(':').map(Number); return m * 60 + s }
const clockText = (page) => page.getByTestId('clock').innerText()

try {
  const { context, page: op } = await ctx()
  await op.goto(`${base}/t/${T}/score/${mid(1)}`)
  await text(op, 'RTM v RE8').waitFor()

  // Start: the clock runs, the button becomes "Pause clock" (with a filled square), no confirmation. The clock and period are never in a live region.
  assert.equal(await clockText(op), '00:00')
  await text(op, 'Not started').waitFor()
  await button(op, 'Start clock').click()
  await button(op, 'Pause clock').waitFor()
  assert.equal(await op.locator('.clock-pause-icon').count(), 1)
  await sent('start_clock', 1)
  assert.equal(calls('start_clock')[0].expected_version, 1)
  assert.ok(Math.abs(Date.parse(calls('start_clock')[0].at) - Date.now()) < 5000, 'at is the time of the tap')
  assert.equal(matches[0].status, 'live')
  await text(op, '1st half').waitFor()
  assert.equal(await op.getByTestId('clock').evaluate((e) => !e.closest('[aria-live], [role="status"], [role="alert"], [role="log"]')), true, 'clock in a live region')
  assert.equal(await text(op, '1st half').evaluate((e) => !e.closest('[aria-live], [role="status"], [role="alert"], [role="log"]')), true, 'period in a live region')
  await op.waitForTimeout(1300)
  assert.ok(secs(await clockText(op)) >= 1, 'the clock did not run')

  // Two devices: a second page reads the same running clock; the two show the same time within 1 s.
  const other = await ctx()
  await other.page.goto(`${base}/t/${T}/score/${mid(1)}`)
  await text(other.page, 'RTM v RE8').waitFor()
  await op.waitForTimeout(500)
  const [a, b] = await Promise.all([clockText(op), clockText(other.page)])
  assert.ok(Math.abs(secs(a) - secs(b)) <= 1, `two devices show ${a} and ${b}`)
  await other.context.close()

  // Pause stops the clock; Resume continues from the same time.
  await button(op, 'Pause clock').click()
  await button(op, 'Resume clock').waitFor()
  const paused = await clockText(op)
  await op.waitForTimeout(1300)
  assert.equal(await clockText(op), paused)
  await sent('pause_clock', 1)
  assert.equal(calls('pause_clock')[0].expected_version, 2)
  await button(op, 'Resume clock').click()
  await button(op, 'Pause clock').waitFor()
  await op.waitForTimeout(1200)
  assert.ok(secs(await clockText(op)) > secs(paused), 'resume did not continue')

  // Correct the clock: the menu, the new time, a Confirm sheet that says it is logged, then the clock jumps.
  await button(op, 'Open scoreboard menu').click()
  await button(op, 'Correct the clock').click()
  await op.getByLabel('New clock time (minutes:seconds)').fill('14:05')
  await button(op, 'Review the clock change').click()
  const sheet = op.getByRole('dialog')
  assert.match(await sheet.getByRole('heading').innerText(), /^Set the clock from \d\d:\d\d to 14:05\?$/)
  await text(sheet, 'This is logged.').waitFor()
  await sheet.getByRole('button', { name: 'Set the clock', exact: true }).click()
  await op.waitForFunction(() => /^14:0[5-9]$/.test(document.querySelector('[data-testid="clock"]').textContent))
  await sent('set_clock', 1)
  assert.equal(calls('set_clock')[0].elapsed_ms, 845000)

  // Periods (2 periods, no extra time): Start half-time, then Start 2nd half, then only End the match. The dividers are newest first.
  assert.equal(await button(op, 'Start extra time').count(), 0)
  await button(op, 'Start half-time').click()
  await button(op, 'Start 2nd half').waitFor()
  assert.equal(await button(op, 'Pause clock').count() + (await button(op, 'Resume clock').count()), 0, 'clock controls in an interval')
  await text(op, 'Half-time').first().waitFor()
  await button(op, 'Start 2nd half').click()
  await button(op, 'End the match').waitFor()
  assert.equal(await button(op, 'Start extra time').count(), 0, 'extra time on a group Match')
  assert.deepEqual(await op.locator('.event-log li').allInnerTexts(), ['2nd half started · 0 – 0', 'Half-time started · 0 – 0', '1st half started · 0 – 0'])

  // End the match: the sheet names the score and opens with focus on Cancel; confirming finishes the Match.
  await button(op, 'End the match').click()
  const end = op.getByRole('dialog')
  assert.equal(await end.getByRole('heading').innerText(), 'End the match at 0–0?')
  assert.equal(await op.evaluate(() => document.activeElement.textContent), 'Cancel')
  await end.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(calls('end_match').length, 0)
  await button(op, 'End the match').click()
  await op.getByRole('dialog').getByRole('button', { name: 'End the match', exact: true }).click()
  await text(op, 'Full time').waitFor()
  await sent('end_match', 1)
  assert.equal(matches[0].status, 'finished')
  assert.equal(await button(op, 'Pause clock').count() + (await button(op, 'Resume clock').count()) + (await button(op, 'End the match').count()), 0)

  // Extra time: a knockout Match with extra time on offers "Start extra time" and "End the match" in the last regular period.
  await op.goto(`${base}/t/${T}/score/${mid(2)}`)
  await button(op, 'Start clock').click()
  await button(op, 'Start half-time').click()
  await button(op, 'Start 2nd half').click()
  await button(op, 'Start extra time').waitFor()
  await button(op, 'End the match').waitFor()
  await button(op, 'Start extra time').click()
  await text(op, 'Extra time').waitFor()
  await button(op, 'Start interval').waitFor()
  assert.equal(await button(op, 'Start extra time').count(), 0)
  assert.equal(await op.locator('.event-log li').first().innerText(), 'Extra time started · 0 – 0')

  // Return: the wake lock is asked for on open and again when the page is shown after being hidden; the clock is right on return.
  const before = await op.evaluate(() => window.__locks.length)
  assert.ok(before >= 1, 'no wake lock on open')
  await op.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  matches[1].clock = { ...matches[1].clock, anchor_at: new Date(Date.now() - 120_000).toISOString(), elapsed_ms: 0 }
  await op.reload()
  await button(op, 'Pause clock').waitFor()
  const opened = await op.evaluate(() => window.__locks.length)
  assert.equal(opened, 1, 'no wake lock after reload')
  await op.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  await op.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
  assert.equal(await op.evaluate(() => window.__locks.length), 2, 'wake lock not asked for again')
  const back = secs(await clockText(op))
  assert.ok(back >= 120 && back <= 123, `clock on return: ${back}`)

  // Offline: Pause applies on this phone at once and replays with the time of the tap.
  const tapped = Date.now()
  mock.offline = true
  await context.setOffline(true)
  await button(op, 'Pause clock').click()
  await button(op, 'Resume clock').waitFor()
  await text(op, "Saved on this phone. It sends when there's a signal.").waitFor()
  const offline = await clockText(op)
  await op.waitForTimeout(1300)
  assert.equal(await clockText(op), offline)
  assert.equal(calls('pause_clock').length, 1, 'the offline pause reached the server')
  mock.offline = false
  await context.setOffline(false)
  await op.evaluate(() => window.dispatchEvent(new Event('online')))
  await op.waitForFunction(() => true)
  for (let i = 0; i < 50 && calls('pause_clock').length < 2; i++) await op.waitForTimeout(100)
  const replay = calls('pause_clock').at(-1)
  assert.equal(calls('pause_clock').length, 2, 'the offline pause did not replay')
  assert.ok(Date.parse(replay.at) >= tapped - 100 && Date.parse(replay.at) < replay.seen - 800, 'the replay lost the time of the tap')
  assert.equal(await op.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
