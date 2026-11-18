// Story 4.4 goals check: GOAL buttons and the picker (cancel, Escape, outside), the live region, the Undo toast (8 s, held by the pointer, replaced), Add assist,
// own goal, Edit goal and Delete goal behind a Confirm sheet, a conflict left to the hand-back ("Couldn't save"), swapped sides, End the match at the derived score and an offline goal.
// Real Chrome, Supabase mocked by route interception. `npm run check:goals`. Needs Google Chrome.
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
const outDir = 'node_modules/.goals-dist'
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

// M1: live, clock paused at 5:30 of the 2nd half (20 + 5 + 1: a goal is minute 26). M2: live with the line-up swapped (the console lists Eight Eagles first). M3: scheduled.
const mock = { calls: [], events: {}, offline: false, conflict: false }
const frozen = { running: false, anchor_at: new Date().toISOString(), elapsed_ms: 330000, period: 2, interval: false }
const matches = [
  { id: mid(1), status: 'live', order: [0, 1], clock: frozen }, { id: mid(2), status: 'live', order: [1, 0], clock: frozen },
  { id: mid(3), status: 'scheduled', order: [0, 1], clock: { ...frozen, period: 0, elapsed_ms: 0 } },
]
for (const m of matches) mock.events[m.id] = []
const score = (m, t) => mock.events[m.id].filter((e) => e.kind === 'goal' && e.team_id === t).length

function consoleFor(id) {
  const m = matches.find((x) => x.id === id)
  const teams = m.order.map((i, k) => ({ team_id: TEAMS[i].id, name: TEAMS[i].name, code: TEAMS[i].code, registered_kit: TEAMS[i].kit, side: k === 0 ? 'home' : 'away', squad: squad(TEAMS[i]),
    lineup: { starters: [1, 2, 3].map((n) => pid(i + 1, n)), bench: [], kit_colour: TEAMS[i].kit, version: 1 } }))
  return { match: { id, season_id: S, tournament_id: T, stage: 'group', round: 'Group A', label: null, kick_off: null, status: m.status, season_status: 'started', version: 1 },
    rules: { starters: 3, max_bench: 9, periods: 2, extra_time_periods: 0, period_minutes: 20, extra_time_minutes: 5 }, clock: m.clock,
    score: { home: score(m, teams[0].team_id), away: score(m, teams[1].team_id) }, events: mock.events[id], holder: true, held: true, on_air: false, teams }
}

// The server's rules for a goal command.
function goalCommand(cmd, a) {
  const evs = Object.values(mock.events).flat()
  if (cmd === 'record_goal') {
    mock.events[a.match_id].unshift({ id: a.command_id, kind: 'goal', period: a.period, minute: a.minute, entered_at: a.at, home: null, away: null, team_id: a.team_id,
      player_id: a.player_id, assist_id: null, own_goal: a.own_goal, version: 1 })
    return { ok: true, code: null, message: 'Goal saved.' }
  }
  const list = Object.values(mock.events).find((l) => l.some((e) => e.id === a.event_id))
  const e = evs.find((x) => x.id === a.event_id)
  if (!e) return { ok: false, code: 'event_missing', message: 'gone' }
  if (mock.conflict || e.version !== a.expected_version) {
    return { ok: false, code: 'version_conflict', message: 'Someone else changed this first.', conflict: { current_version: e.version, current: { player_id: e.player_id, assist_id: e.assist_id, minute: e.minute, own_goal: e.own_goal },
      changed_by: 'Organiser', changed_at: new Date().toISOString() } }
  }
  if (cmd === 'add_assist') e.assist_id = a.assist_id
  else if (cmd === 'edit_event') Object.assign(e, { player_id: a.player_id, own_goal: a.own_goal, minute: a.minute ?? e.minute })
  else list.splice(list.indexOf(e), 1)
  e.version += 1
  return { ok: true, code: null, message: 'Goal saved.', version: e.version }
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
    if (/^(record_goal|add_assist|edit_event|delete_event)$/.test(cmd)) {
      const r = goalCommand(cmd, a)
      mock.calls.push({ ...a, cmd, seen: Date.now(), ok: r.ok })
      return json(route, r)
    }
    if (cmd === 'start_clock') mock.calls.push({ ...a, cmd, seen: Date.now() })
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
const live = (page) => page.locator('.ui-visually-hidden[role="status"]').innerText()
const rows = (page) => page.locator('.event-goal').allInnerTexts().then((l) => l.map((t) => t.replace(/\s+/g, ' ').trim()))
const dialog = (page) => page.getByRole('dialog')
const pickScorer = async (page, goalButton, who) => {
  await button(page, goalButton).click()
  await dialog(page).getByRole('button', { name: who, exact: false }).first().click()
}

try {
  const { context, page: op } = await ctx()
  await op.goto(`${base}/t/${T}/score/${mid(1)}`)
  await text(op, 'RTM v RE8').waitFor()

  // A Match that is not live has no GOAL buttons.
  await op.goto(`${base}/t/${T}/score/${mid(3)}`)
  await text(op, 'RTM v RE8').waitFor()
  assert.equal(await op.locator('.goal-button').count(), 0, 'GOAL buttons before kick-off')
  await op.goto(`${base}/t/${T}/score/${mid(1)}`)
  await text(op, 'RTM v RE8').waitFor()

  // The buttons: side by side in the Scoreboard's order, orange, at least 96px, "GOAL" in display-lg with the Team code beneath, an 8px kit band.
  const geo = await op.locator('.goal-button').evaluateAll((els) => els.map((e) => ({ ...e.getBoundingClientRect().toJSON(), text: e.innerText.replace(/\s+/g, ' '), bg: getComputedStyle(e).backgroundColor,
    lg: e.querySelector('.display-lg').textContent, band: getComputedStyle(e, '::before').width })))
  assert.deepEqual(geo.map((g) => g.text), ['GOAL RTM', 'GOAL RE8'])
  assert.ok(geo[0].x < geo[1].x && Math.abs(geo[0].y - geo[1].y) < 1 && geo.every((g) => g.height >= 96), 'goal buttons layout')
  assert.equal(geo[0].bg, 'rgb(245, 130, 32)')
  assert.equal(geo[0].band, '8px')

  // Cancel, Escape and tapping outside record nothing.
  await button(op, 'GOAL RTM').click()
  await text(op, 'Who scored for Red Tigers?').waitFor()
  const tiles = await dialog(op).locator('.picker-tile').allInnerTexts()
  assert.deepEqual(tiles.map((t) => t.replace(/\s+/g, ' ')), ['RTM Player 1 1', 'RTM Player 2 2', 'RTM Player 3 3', 'Own goal', 'Unknown scorer'])
  assert.ok((await dialog(op).locator('.picker-tile').first().boundingBox()).height >= 64, 'tile height')
  await op.keyboard.press('Escape')
  await dialog(op).waitFor({ state: 'detached' }).catch(() => {})
  await button(op, 'GOAL RTM').click()
  await op.mouse.click(190, 20)
  await op.waitForFunction(() => !document.querySelector('dialog[open]'))
  await button(op, 'GOAL RTM').click()
  await dialog(op).getByRole('button', { name: 'Cancel', exact: true }).click()
  await op.waitForTimeout(300)
  assert.equal(mock.calls.length, 0, 'a cancelled picker recorded something')
  assert.equal(await scoreText(op), '0 – 0')

  // Goal: two taps, the Scoreboard updates, the live region and the toast speak, the minute counts the 1st half's 20 minutes, the 5 elapsed and 1.
  await pickScorer(op, 'GOAL RTM', 'RTM Player 1')
  await sent('record_goal', 1)
  assert.equal(await scoreText(op), '1 – 0')
  assert.equal(await live(op), 'Goal for RTM, RTM Player 1, 26 minutes. RTM 1, RE8 0.')
  await text(op, 'Goal · RTM Player 1 26′ · RTM').waitFor()
  const g1 = calls('record_goal')[0]
  assert.deepEqual([g1.team_id, g1.player_id, g1.own_goal, g1.period, g1.minute], [tid(1), pid(1, 1), false, 2, 26])
  assert.ok(Math.abs(Date.parse(g1.at) - Date.now()) < 5000, 'at is the time of the tap')
  assert.equal(await op.getByRole('group', { name: 'Goal recorded' }).evaluate((e) => getComputedStyle(e).position), 'fixed')
  assert.notEqual(await op.evaluate(() => document.activeElement.closest('.undo-toast') !== null), true, 'the toast took focus')
  assert.deepEqual(await rows(op), ['⚽ 26′ RTM Player 1 · RTM Edit goal'])

  // Undo: no sheet, the goal and the score go, the delete carries the goal's version.
  await button(op, 'Undo').click()
  assert.equal(await dialog(op).count(), 0)
  assert.equal(await scoreText(op), '0 – 0')
  await sent('delete_event', 1)
  assert.equal(calls('delete_event')[0].expected_version, 1)
  assert.equal(await op.locator('.event-goal').count(), 0)

  // Assist: Add assist offers the Team's starters except the scorer; the row shows it.
  await pickScorer(op, 'GOAL RTM', 'RTM Player 1')
  await button(op, 'Add assist').click()
  await text(op, 'Who assisted for Red Tigers?').waitFor()
  assert.equal(await dialog(op).locator('.picker-tile').count(), 2)
  await dialog(op).getByRole('button', { name: 'RTM Player 2' }).click()
  await sent('add_assist', 1)
  assert.equal(calls('add_assist')[0].expected_version, 1)
  assert.deepEqual(await rows(op), ['⚽ 26′ RTM Player 1 · assist RTM Player 2 · RTM Edit goal'])

  // Own goal: counts for the Team of the button.
  await pickScorer(op, 'GOAL RE8', 'Own goal')
  await sent('record_goal', 3)
  assert.equal(await scoreText(op), '1 – 1')
  assert.equal(await live(op), 'Goal for RE8, own goal, 26 minutes. RTM 1, RE8 1.')
  assert.equal(calls('record_goal')[2].player_id, null)
  assert.equal(calls('record_goal')[2].own_goal, true)
  assert.equal((await rows(op))[0], '⚽ 26′ Own goal · RE8 Edit goal')
  // A newer goal replaces the toast.
  await text(op, 'Goal · Own goal 26′ · RE8').waitFor()
  assert.equal(await op.locator('.undo-toast').count(), 1)

  // The toast goes after 8 s; the pointer on it holds it.
  await op.locator('.undo-toast').hover()
  await op.waitForTimeout(8600)
  assert.equal(await op.locator('.undo-toast').count(), 1, 'the toast left while the pointer was on it')
  await op.mouse.move(5, 5)
  await op.waitForTimeout(7000)
  assert.equal(await op.locator('.undo-toast').count(), 1, 'the toast left early')
  await op.waitForTimeout(1600)
  assert.equal(await op.locator('.undo-toast').count(), 0, 'the toast stayed')

  // Edit goal: a confirm sheet names the change; the edit carries the goal's version (1 + the assist).
  await op.getByRole('button', { name: /^Edit goal at 26′ by RTM Player 1$/ }).click()
  await dialog(op).getByRole('button', { name: 'RTM Player 3 3' }).click()
  await dialog(op).getByLabel('Minute of the goal').fill('27')
  await button(op, 'Save goal').click()
  assert.equal(await dialog(op).getByRole('heading').innerText(), 'Change the 26′ goal from RTM Player 1 to RTM Player 3 at 27′?')
  await dialog(op).getByText('This is logged.').waitFor()
  assert.equal(calls('edit_event').length, 0)
  await dialog(op).getByRole('button', { name: 'Save goal', exact: true }).click()
  await sent('edit_event', 1)
  const ed = calls('edit_event')[0]
  assert.deepEqual([ed.expected_version, ed.player_id, ed.own_goal, ed.minute], [2, pid(1, 3), false, 27])
  assert.ok((await rows(op)).some((r) => r === '⚽ 27′ RTM Player 3 · assist RTM Player 2 · RTM Edit goal'), (await rows(op)).join('|'))

  // Delete goal: the sheet says the new score; cancel keeps the goal, confirm deletes it.
  await op.getByRole('button', { name: /^Edit goal at 26′ by Own goal$/ }).click()
  assert.equal(await dialog(op).getByRole('button', { name: 'Add assist' }).count(), 0, 'assist on an own goal')
  await button(op, 'Delete goal').click()
  assert.equal(await dialog(op).getByRole('heading').innerText(), 'Delete the 26′ goal (own goal)? The score becomes 1–0.')
  await dialog(op).getByRole('button', { name: 'Delete goal', exact: true }).click()
  await sent('delete_event', 2)
  assert.equal(await scoreText(op), '1 – 0')

  // End the match: the sheet names the derived score.
  await button(op, 'End the match').click()
  assert.equal(await dialog(op).getByRole('heading').innerText(), 'End the match at 1–0?')
  await dialog(op).getByRole('button', { name: 'Cancel', exact: true }).click()

  // Offline: the goal shows at once with "Waiting", then replays with the minute and time of the tap.
  const tapped = Date.now()
  mock.offline = true
  await context.setOffline(true)
  await pickScorer(op, 'GOAL RE8', 'RE8 Player 2')
  await text(op, 'Goal · RE8 Player 2 26′ · RE8').waitFor()
  assert.equal(await scoreText(op), '1 – 1')
  await op.locator('.event-waiting', { hasText: 'Waiting' }).waitFor()
  assert.equal(calls('record_goal').length, 3)
  assert.equal(await op.locator('[data-goal] .event-waiting').locator('xpath=..').getByRole('button').count(), 0, 'Edit goal on a waiting row')
  // Undo of a goal that has not been sent drops it from the outbox: nothing is sent for it, not even a delete.
  await pickScorer(op, 'GOAL RTM', 'RTM Player 3')
  assert.equal(await scoreText(op), '2 – 1')
  await button(op, 'Undo').click()
  assert.equal(await scoreText(op), '1 – 1')
  assert.equal(await live(op), 'Goal removed. RTM 1, RE8 1.')
  await op.waitForTimeout(1300)
  mock.offline = false
  await context.setOffline(false)
  await op.evaluate(() => window.dispatchEvent(new Event('online')))
  await sent('record_goal', 4)
  const replay = calls('record_goal')[3]
  assert.equal(replay.minute, 26)
  assert.ok(Date.parse(replay.at) >= tapped - 100 && Date.parse(replay.at) < replay.seen - 500, 'the replay lost the time of the tap')
  await op.locator('.event-waiting').waitFor({ state: 'detached' })
  await op.waitForTimeout(400)
  assert.equal(calls('record_goal').length, 4, 'the undone goal was sent')
  assert.equal(calls('delete_event').length, 2, 'a delete was sent for an unsent goal')

  // Swapped sides: the console lists Eight Eagles first, so the buttons and the score follow that order.
  await op.goto(`${base}/t/${T}/score/${mid(2)}`)
  await text(op, 'RE8 v RTM').waitFor()
  assert.deepEqual(await op.locator('.goal-button').allInnerTexts().then((l) => l.map((t) => t.replace(/\s+/g, ' '))), ['GOAL RE8', 'GOAL RTM'])
  await pickScorer(op, 'GOAL RTM', 'RTM Player 1')
  assert.equal(await scoreText(op), '0 – 1')
  assert.equal(await live(op), 'Goal for RTM, RTM Player 1, 26 minutes. RE8 0, RTM 1.')
  // A stale version is a conflict: nothing is forgotten, no message, the hand-back keeps it.
  mock.conflict = true
  await op.getByRole('button', { name: /^Edit goal at 26′ by RTM Player 1$/ }).click()
  await dialog(op).getByLabel('Minute of the goal').fill('30')
  await button(op, 'Save goal').click()
  await dialog(op).getByRole('button', { name: 'Save goal', exact: true }).click()
  await sent('edit_event', 2)
  await op.waitForTimeout(500)
  assert.deepEqual(await op.getByRole('alert').allInnerTexts(), ["Couldn't save"], 'the conflict is left to the hand-back')
  mock.conflict = false
  // The held conflict stops only that goal's own changes: a new goal and a clock tap still go out.
  await pickScorer(op, 'GOAL RE8', 'RE8 Player 1')
  await sent('record_goal', 6)
  await button(op, 'Resume clock').click()
  for (let i = 0; i < 30 && !calls('start_clock').length; i++) await op.waitForTimeout(100)
  assert.equal(calls('start_clock').length, 1, 'the clock tap sent once')

  assert.equal(await op.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
