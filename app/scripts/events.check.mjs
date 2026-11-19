// Story 4.5 events check: the Event row (futsal and 11-a-side), card, foul, sub, timeout and missed penalty flows with their pickers (cancel, Escape, outside),
// foul counts and the Limit, their reset and extra time, timeout and substitution limits with reasons, the on-pitch goal picker, the power-play countdown (paused clock,
// opponent goal, Undo), the Event log, Edit event and Delete event behind a Confirm sheet, and a conflict left to the hand-back.
// Real Chrome, Supabase mocked by route interception. `npm run check:events`. Needs Google Chrome.
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
const outDir = 'node_modules/.events-dist'
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
const TEAMS = [{ id: tid(1), name: 'Red Tigers', code: 'RTM', kit: '#ff0000', n: 8 }, { id: tid(2), name: 'Eight Eagles', code: 'RE8', kit: '#0000ff', n: 8 }]
const squad = (t) => Array.from({ length: t.n }, (_, i) => ({ player_id: pid(TEAMS.indexOf(t) + 1, i + 1), name: `${t.code} Player ${i + 1}`, shirt: i + 1 }))

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

const futsal = { starters: 3, max_bench: 9, periods: 2, extra_time_periods: 0, period_minutes: 20, extra_time_minutes: 5, foul_warning: 5, timeouts_per_period: 1, substitutions: 'rolling', max_substitutions: null, power_play_minutes: 2 }
const limited = { ...futsal, foul_warning: null, timeouts_per_period: null, substitutions: 'limited', max_substitutions: 2, power_play_minutes: null }
const frozen = (period, ms) => ({ running: false, anchor_at: new Date().toISOString(), elapsed_ms: ms, period, interval: false })
const ev = (id, kind, team, period, extra = {}) => ({ id, kind, period, minute: 3, entered_at: new Date(Date.now() - 600000).toISOString(), home: null, away: null, team_id: team, player_id: null, assist_id: null,
  own_goal: false, version: 1, ...extra })
// M1: futsal, paused at 5:30 of the 2nd half. M2: 11-a-side style (no fouls or timeouts, 2 substitutions, both used by RTM). M3: 20:00 of the 1st half with 5 RTM fouls.
// M4: extra time with 5 RTM fouls from the 2nd half.
const mock = { calls: [], events: {}, conflict: false }
const matches = [
  { id: mid(1), rules: futsal, clock: frozen(2, 330000) }, { id: mid(2), rules: limited, clock: frozen(2, 330000) },
  { id: mid(3), rules: futsal, clock: frozen(1, 1200000) }, { id: mid(4), rules: { ...futsal, extra_time_periods: 2 }, clock: frozen(3, 60000) },
]
for (const m of matches) mock.events[m.id] = []
mock.events[mid(2)] = [ev('e0000000-0000-4000-8000-000000000001', 'sub', tid(1), 1, { player_id: pid(1, 1), player_on_id: pid(1, 4) }),
  ev('e0000000-0000-4000-8000-000000000002', 'sub', tid(1), 1, { player_id: pid(1, 2), player_on_id: pid(1, 5) })]
mock.events[mid(3)] = [1, 2, 3, 4, 5].map((n) => ev(`e0000000-0000-4000-8000-00000000010${n}`, 'foul', tid(1), 1))
mock.events[mid(4)] = [1, 2, 3, 4].map((n) => ev(`e0000000-0000-4000-8000-00000000020${n}`, 'foul', tid(1), 2))

function consoleFor(id) {
  const m = matches.find((x) => x.id === id)
  const teams = TEAMS.map((t, i) => ({ team_id: t.id, name: t.name, code: t.code, registered_kit: t.kit, side: i === 0 ? 'home' : 'away', squad: squad(t),
    lineup: { starters: [1, 2, 3].map((n) => pid(i + 1, n)), bench: [4, 5].map((n) => pid(i + 1, n)), kit_colour: t.kit, version: 1 } }))
  return { match: { id, season_id: S, tournament_id: T, stage: 'group', round: 'Group A', label: null, kick_off: null, status: 'live', season_status: 'started', version: 1 },
    rules: m.rules, clock: m.clock, score: { home: 0, away: 0 }, events: mock.events[id], holder: true, held: true, on_air: false, teams }
}

// The server's answer to an event command (the rules themselves are checked on Postgres by check.sh).
function eventCommand(cmd, a) {
  const evs = Object.values(mock.events).flat()
  if (cmd === 'record_event') {
    mock.events[a.match_id].unshift({ id: a.command_id, kind: a.kind, period: a.period, minute: a.minute, entered_at: a.at, home: null, away: null, team_id: a.team_id, player_id: a.player_id,
      player_on_id: a.player_on_id, card: a.card, clock_ms: a.clock_ms, assist_id: null, own_goal: false, version: 1 })
    return { ok: true, code: null, message: 'Event saved.' }
  }
  if (cmd === 'record_goal') {
    mock.events[a.match_id].unshift({ id: a.command_id, kind: 'goal', period: a.period, minute: a.minute, entered_at: a.at, home: null, away: null, team_id: a.team_id, player_id: a.player_id,
      assist_id: null, own_goal: a.own_goal, version: 1 })
    return { ok: true, code: null, message: 'Goal saved.' }
  }
  const list = Object.values(mock.events).find((l) => l.some((e) => e.id === a.event_id))
  const e = evs.find((x) => x.id === a.event_id)
  if (!e) return { ok: false, code: 'event_missing', message: 'gone' }
  if (mock.conflict || e.version !== a.expected_version) {
    return { ok: false, code: 'version_conflict', message: 'Someone else changed this first.', conflict: { current_version: e.version, current: { player_id: e.player_id, assist_id: e.assist_id, minute: e.minute, own_goal: e.own_goal },
      changed_by: 'Organiser', changed_at: new Date().toISOString() } }
  }
  if (cmd === 'edit_event') Object.assign(e, { player_id: a.player_id, minute: a.minute ?? e.minute })
  else list.splice(list.indexOf(e), 1)
  e.version += 1
  return { ok: true, code: null, message: 'Saved.', version: e.version }
}

async function ctx() {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session(ORG, false)))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    if (cmd === 'console_match') return json(route, consoleFor(a.p_match_id))
    if (/^(record_event|record_goal|edit_event|delete_event)$/.test(cmd)) {
      const r = eventCommand(cmd, a)
      mock.calls.push({ ...a, cmd, seen: Date.now(), ok: r.ok })
      return json(route, r)
    }
    if (/clock|period/.test(cmd)) mock.calls.push({ ...a, cmd })
    return json(route, { ok: true, code: null, message: 'ok' })
  })
  await context.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-fake-auth-token', JSON.stringify(session(ORG, false))])
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, page }
}
const text = (page, t) => page.getByText(t, { exact: true })
const button = (page, name) => page.getByRole('button', { name, exact: true })
const calls = (name) => mock.calls.filter((c) => c.cmd === name)
const sent = async (name, n) => { for (let i = 0; i < 60 && calls(name).length < n; i++) await new Promise((r) => setTimeout(r, 100)); assert.equal(calls(name).length, n, `${name} sent`) }
const scoreText = (page) => page.locator('.scoreboard-score').innerText()
const rows = (page) => page.locator('[data-event]').allInnerTexts().then((l) => l.map((t) => t.replace(/\s+/g, ' ').trim()))
const teamsText = (page) => page.locator('.scoreboard-team').allInnerTexts().then((l) => l.map((t) => t.replace(/\s+/g, ' ').trim()))
const dialog = (page) => page.getByRole('dialog')
const open = async (page, n, code) => { await page.goto(`${base}/t/${T}/score/${mid(n)}`); await text(page, code).waitFor() }
const tiles = (page) => dialog(page).locator('.picker-tile').allInnerTexts().then((l) => l.map((t) => t.replace(/\s+/g, ' ').trim()))
const headings = (page) => dialog(page).locator('h3').allInnerTexts()
const closed = (page) => page.waitForFunction(() => !document.querySelector('dialog[open]'))

try {
  const { page: op } = await ctx()
  await open(op, 1, 'RTM v RE8')

  // The Event row, futsal: five 64px buttons with icon and text, below the GOAL buttons; the period button on its own full-width row 24px below.
  const labels = ['Record card', 'Record foul', 'Record sub', 'Record timeout', 'Record missed penalty']
  assert.deepEqual((await op.locator('.event-button').allInnerTexts()).map((t) => t.replace(/^\S+\s/, '').trim()), labels)
  const box = async (sel) => op.locator(sel).first().boundingBox()
  const goal = await box('.goal-button')
  const evb = await op.locator('.event-button').evaluateAll((els) => els.map((e) => ({ ...e.getBoundingClientRect().toJSON(), icon: !!e.querySelector('[aria-hidden]') })))
  assert.ok(evb.every((b) => b.height >= 64 && b.icon), 'event buttons 64px with an icon')
  assert.ok(evb[0].y >= goal.y + goal.height, 'event row below the GOAL buttons')
  const period = await op.getByRole('button', { name: 'End the match', exact: true }).boundingBox()
  const wide = await box('.clock-controls')
  assert.ok(Math.abs(period.width - wide.width) < 2, 'period button is full width')
  const resume = await button(op, 'Resume clock').boundingBox()
  assert.ok(period.y - (resume.y + resume.height) >= 24 - 1 && period.y + period.height <= goal.y, 'period button 24px below its own row, above the GOAL buttons (Story 4.9 order)')

  // Cancel, Escape and outside record nothing.
  await button(op, 'Record card').click()
  await text(op, 'Which card?').waitFor()
  await op.keyboard.press('Escape')
  await closed(op)
  await button(op, 'Record foul').click()
  await op.mouse.click(190, 20)
  await closed(op)
  await button(op, 'Record sub').click()
  await dialog(op).getByRole('button', { name: 'Cancel', exact: true }).click()
  await closed(op)
  assert.equal(mock.calls.length, 0, 'a cancelled picker recorded something')

  // Card: button, colour, Player (3 taps). Tiles grouped under each Team's name, on the pitch first and then the bench.
  await button(op, 'Record card').click()
  await dialog(op).getByRole('button', { name: 'Give red card', exact: true }).click()
  await text(op, 'Who got the red card?').waitFor()
  assert.deepEqual(await headings(op), ['Red Tigers', 'Eight Eagles'])
  const all = await tiles(op)
  assert.deepEqual(all.slice(0, 5), ['RTM Player 1 1', 'RTM Player 2 2', 'RTM Player 3 3', 'RTM Player 4 4 · Bench', 'RTM Player 5 5 · Bench'])
  assert.equal(all.indexOf('RE8 Player 1 1'), 5, 'second Team after the first')
  assert.ok((await dialog(op).locator('.picker-tile').first().boundingBox()).height >= 64, 'tile height')
  await dialog(op).getByRole('button', { name: 'RTM Player 2', exact: false }).click()
  await sent('record_event', 1)
  const c1 = calls('record_event')[0]
  assert.deepEqual([c1.kind, c1.card, c1.team_id, c1.player_id, c1.player_on_id, c1.period, c1.minute, c1.clock_ms], ['card', 'red', tid(1), pid(1, 2), null, 2, 26, 330000])
  assert.ok(Math.abs(Date.parse(c1.at) - Date.now()) < 5000, 'at is the time of the tap')
  await text(op, 'Red card · RTM Player 2 26′').waitFor()
  assert.equal(await op.getByRole('group', { name: 'Event recorded' }).count(), 1)
  assert.equal(await op.getByRole('button', { name: 'Add assist' }).count(), 0, 'Add assist on a card')
  assert.deepEqual(await rows(op), ['🟨 26′ Red card · RTM Player 2 Edit event'])
  assert.equal(await scoreText(op), '0 – 0')

  // Power play for the opponent: counts down with the clock (paused here, so it holds), never in a live region.
  await op.getByTestId('power-play').waitFor()
  const pp = () => op.getByTestId('power-play').innerText()
  assert.equal(await pp(), 'Power play RE8 2:00')
  await op.waitForTimeout(1300)
  assert.equal(await pp(), 'Power play RE8 2:00', 'the countdown ran with the clock stopped')
  assert.equal(await op.getByTestId('power-play').evaluate((e) => !!e.closest('[aria-live], [role="status"], [role="alert"]')), false, 'the power play is in a live region')
  // Undo of the card takes it away; the opponent goal after a red card ends it, and Undo of that goal brings it back.
  await button(op, 'Undo').click()
  assert.equal(await op.getByTestId('power-play').count(), 0)
  await sent('delete_event', 1)
  await button(op, 'Record card').click()
  await dialog(op).getByRole('button', { name: 'Give red card', exact: true }).click()
  await dialog(op).getByRole('button', { name: 'RTM Player 2', exact: false }).click()
  await sent('record_event', 2)
  await op.getByTestId('power-play').waitFor()
  await button(op, 'GOAL RE8').click()
  await dialog(op).getByRole('button', { name: 'RE8 Player 1', exact: false }).first().click()
  await op.getByTestId('power-play').waitFor({ state: 'detached' })
  await button(op, 'Undo').click()
  await op.getByTestId('power-play').waitFor()

  // Foul: button, Team (2 taps); the count shows on the Scoreboard and at 5 reads "Fouls 5 · Limit" in the live red.
  assert.deepEqual(await teamsText(op), ['RTM Red Tigers Fouls 0', 'RE8 Eight Eagles Fouls 0'])
  for (let i = 1; i <= 5; i++) {
    await button(op, 'Record foul').click()
    await dialog(op).getByRole('button', { name: 'Record foul for Red Tigers', exact: true }).click()
    await sent('record_event', 2 + i)
    assert.equal((await teamsText(op))[0], i < 5 ? `RTM Red Tigers Fouls ${i}` : 'RTM Red Tigers Fouls 5 · Limit')
  }
  const limit = await op.locator('.scoreboard-limit').evaluate((e) => ({ color: getComputedStyle(e).color, live: (() => { const p = document.createElement('i'); p.style.color = 'var(--live)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c })() }))
  assert.equal(limit.color, limit.live, 'Limit is in the live red')
  assert.equal((await teamsText(op))[1], 'RE8 Eight Eagles Fouls 0')
  assert.deepEqual(calls('record_event')[3].kind, 'foul')
  assert.equal(calls('record_event')[3].player_id, null)

  // Timeout: one per half; the used-up Team's tile is disabled with the reason.
  await button(op, 'Record timeout').click()
  assert.deepEqual(await tiles(op), ['Record timeout for Red Tigers', 'Record timeout for Eight Eagles'])
  await dialog(op).getByRole('button', { name: 'Record timeout for Red Tigers', exact: true }).click()
  await sent('record_event', 8)
  await button(op, 'Record timeout').click()
  const used = dialog(op).getByRole('button', { name: 'Record timeout for Red Tigers', exact: true })
  assert.equal(await used.isDisabled(), true)
  await dialog(op).getByText('RTM has used its timeout this half.', { exact: true }).waitFor()
  assert.match(await used.getAttribute('aria-describedby'), /reason-/)
  assert.equal(await dialog(op).getByRole('button', { name: 'Record timeout for Eight Eagles', exact: true }).isDisabled(), false)
  await dialog(op).getByRole('button', { name: 'Cancel', exact: true }).click()
  await closed(op)

  // Sub: button, Player going off (on-pitch tiles grouped by Team), Player coming on (3 taps). Then the goal picker follows the pitch.
  await button(op, 'Record sub').click()
  await text(op, 'Who goes off?').waitFor()
  assert.deepEqual(await headings(op), ['Red Tigers', 'Eight Eagles'])
  assert.deepEqual((await tiles(op)).slice(0, 3), ['RTM Player 1 1', 'RTM Player 3 3', 'RE8 Player 1 1'])
  await dialog(op).getByRole('button', { name: 'RTM Player 1', exact: false }).click()
  await text(op, 'Who comes on for RTM Player 1?').waitFor()
  assert.deepEqual(await headings(op), ['Red Tigers'])
  assert.deepEqual(await tiles(op), ['RTM Player 4 4', 'RTM Player 5 5'])
  await dialog(op).getByRole('button', { name: 'RTM Player 4', exact: false }).click()
  await sent('record_event', 9)
  const sub = calls('record_event')[8]
  assert.deepEqual([sub.kind, sub.player_id, sub.player_on_id, sub.card], ['sub', pid(1, 1), pid(1, 4), null])
  await text(op, 'Sub · RTM Player 1 off, RTM Player 4 on 26′').waitFor()
  await button(op, 'GOAL RTM').click()
  const scorers = await tiles(op)
  assert.ok(scorers.includes('RTM Player 4 4') && !scorers.some((t) => t.startsWith('RTM Player 1 ')), `the goal picker follows the pitch: ${scorers}`)
  await op.keyboard.press('Escape')
  await closed(op)
  // Rolling: the Player who went off may come back.
  await button(op, 'Record sub').click()
  await dialog(op).getByRole('button', { name: 'RTM Player 4', exact: false }).click()
  assert.ok((await tiles(op)).includes('RTM Player 1 1'), 'a subbed-off Player may return')
  await dialog(op).getByRole('button', { name: 'Cancel', exact: true }).click()
  await closed(op)

  // Missed penalty: button, Player; the score does not change.
  await button(op, 'Record missed penalty').click()
  await dialog(op).getByRole('button', { name: 'RE8 Player 2', exact: false }).click()
  await sent('record_event', 10)
  assert.deepEqual([calls('record_event')[9].kind, calls('record_event')[9].team_id, calls('record_event')[9].player_id], ['missed_penalty', tid(2), pid(2, 2)])
  assert.equal(await scoreText(op), '0 – 0')
  await text(op, 'Missed penalty · RE8 Player 2 26′').waitFor()

  // The Event log: icon, minute and text per kind, "Edit event" on each.
  const log = await rows(op)
  assert.ok(log.includes('🥅 26′ Missed penalty · RE8 Player 2 Edit event') && log.includes('✋ 26′ Foul · RTM Edit event') && log.includes('⏸ 26′ Timeout · RTM Edit event'), log.join('|'))
  assert.ok(log.includes('🔄 26′ Sub · RTM Player 1 off, RTM Player 4 on Edit event'), log.join('|'))

  // Edit event: another Player and the minute behind a Confirm sheet; the edit carries the event's version.
  const red = calls('record_event')[1].command_id
  await op.locator(`[data-event="${red}"]`).getByRole('button').click()
  await dialog(op).getByRole('button', { name: 'RTM Player 3 3' }).click()
  await dialog(op).getByLabel('Minute of the event').fill('27')
  await button(op, 'Save event').click()
  assert.equal(await dialog(op).getByRole('heading').innerText(), 'Change "Red card · RTM Player 2" at 26′ to "Red card · RTM Player 3" at 27′?')
  await dialog(op).getByText('This is logged.').waitFor()
  assert.equal(calls('edit_event').length, 0)
  await dialog(op).getByRole('button', { name: 'Save event', exact: true }).click()
  await sent('edit_event', 1)
  const ed = calls('edit_event')[0]
  assert.deepEqual([ed.event_id, ed.expected_version, ed.player_id, ed.own_goal, ed.minute], [red, 1, pid(1, 3), false, 27])
  assert.ok((await rows(op)).includes('🟨 27′ Red card · RTM Player 3 Edit event'))
  // A foul has no Player to edit; Delete event names the event.
  const foul = calls('record_event')[2].command_id
  await op.locator(`[data-event="${foul}"]`).getByRole('button').click()
  assert.equal(await dialog(op).locator('.picker-tile').count(), 0, 'a foul has no Player')
  await button(op, 'Delete event').click()
  assert.equal(await dialog(op).getByRole('heading').innerText(), 'Delete "Foul · RTM" at 26′?')
  await dialog(op).getByRole('button', { name: 'Delete event', exact: true }).click()
  await sent('delete_event', 2)
  assert.equal((await teamsText(op))[0], 'RTM Red Tigers Fouls 4', 'the foul count is re-derived')
  // A stale version goes to the hand-back, not a message.
  mock.conflict = true
  await op.locator(`[data-event="${red}"]`).getByRole('button').click()
  await dialog(op).getByLabel('Minute of the event').fill('30')
  await button(op, 'Save event').click()
  await dialog(op).getByRole('button', { name: 'Save event', exact: true }).click()
  await sent('edit_event', 2)
  await op.waitForTimeout(500)
  assert.deepEqual(await op.getByRole('alert').allInnerTexts(), ["Couldn't save"], 'the conflict is left to the hand-back')
  mock.conflict = false

  // 11-a-side style Format: no Foul and no Timeout button; the substitution limit disables the Team with its reason.
  await open(op, 2, 'RTM v RE8')
  assert.deepEqual((await op.locator('.event-button').allInnerTexts()).map((t) => t.replace(/^\S+\s/, '').trim()), ['Record card', 'Record sub', 'Record missed penalty'])
  assert.equal(await op.locator('.scoreboard-team').first().innerText().then((t) => t.includes('Fouls')), false, 'fouls shown without a foul limit')
  await button(op, 'Record sub').click()
  await dialog(op).getByText('RTM has used all 2 substitutions.', { exact: true }).waitFor()
  assert.deepEqual((await tiles(op)).slice(0, 3).map((t) => t.startsWith('RTM')), [true, true, true])
  assert.equal(await dialog(op).getByRole('button', { name: 'RTM Player 3', exact: false }).isDisabled(), true)
  assert.equal(await dialog(op).getByRole('button', { name: 'RE8 Player 1', exact: false }).isDisabled(), false)
  await dialog(op).getByRole('button', { name: 'RE8 Player 1', exact: false }).click()
  // Limited: a Player subbed off earlier may not come back.
  const back = await tiles(op)
  assert.ok(back.includes('RE8 Player 4 4') && !back.some((t) => t.startsWith('RTM')), back.join('|'))
  await dialog(op).getByRole('button', { name: 'Cancel', exact: true }).click()
  await closed(op)

  // Fouls reset at each regular period: 5 at the end of the 1st half, 0 once the 2nd half starts.
  await open(op, 3, 'RTM v RE8')
  assert.equal((await teamsText(op))[0], 'RTM Red Tigers Fouls 5 · Limit')
  await button(op, 'Start half-time').click()
  await button(op, 'Start 2nd half').click()
  assert.deepEqual(await teamsText(op), ['RTM Red Tigers Fouls 0', 'RE8 Eight Eagles Fouls 0'])
  // Extra time carries the last regular period's count, and has no timeouts.
  await open(op, 4, 'RTM v RE8')
  assert.equal((await teamsText(op))[0], 'RTM Red Tigers Fouls 4')
  await button(op, 'Record foul').click()
  await dialog(op).getByRole('button', { name: 'Record foul for Red Tigers', exact: true }).click()
  assert.equal((await teamsText(op))[0], 'RTM Red Tigers Fouls 5 · Limit', 'an extra-time foul adds to the 2nd half count')
  await button(op, 'Record timeout').click()
  await dialog(op).getByText('No timeouts in extra time.', { exact: true }).first().waitFor()
  assert.equal(await dialog(op).getByRole('button', { name: 'Record timeout for Eight Eagles', exact: true }).isDisabled(), true)
  await dialog(op).getByRole('button', { name: 'Cancel', exact: true }).click()
  await closed(op)

  assert.equal(await op.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
