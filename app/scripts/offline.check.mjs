// Story 4.7 offline check: scoring on one phone with no signal (goal, card, sub, Undo of a queued goal, pause), the leave warning, a reload with no signal
// (the kept console plus the queue, the clock running; a Match never opened needs a signal), then the signal back: each command goes once, in order, with the
// minute and time of its tap, and the Save status says "Saved · on the stream". Real Chrome, Supabase mocked. `npm run check:offline`. Needs Google Chrome.
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
const outDir = 'node_modules/.offline-dist'
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
const squad = (t) => Array.from({ length: t.n }, (_, i) => ({ player_id: pid(TEAMS.indexOf(t) + 1, i + 1), name: `${t.code} Player ${i + 1}`, shirt: i + 1 }))

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

// M1: live, 2nd half, the clock running (5:30 in when the page opens; a goal then is minute 26), On-air Match. M2: live, never opened on this phone.
const rules = { starters: 3, max_bench: 9, periods: 2, extra_time_periods: 0, period_minutes: 20, extra_time_minutes: 5, foul_warning: null, timeouts_per_period: null, substitutions: 'rolling', max_substitutions: null, power_play_minutes: null }
// calls: each command once (the server answers a repeated command id from its stored result); raw: every request; refuse: a code every command but discard_command is refused with; slow: ms a record_goal takes to answer.
const mock = { calls: [], raw: [], ids: new Set(), offline: false, opened: [], refuse: null, slow: 0, lose: false, m2: null }
const running = { running: true, anchor_at: new Date(Date.now() - 330000).toISOString(), elapsed_ms: 0, period: 2, interval: false }

function consoleFor(id) {
  mock.opened.push(id)
  const teams = TEAMS.slice(0, 2).map((t, i) => ({ team_id: t.id, name: t.name, code: t.code, registered_kit: t.kit, side: i === 0 ? 'home' : 'away', squad: squad(t),
    lineup: { starters: [1, 2, 3].map((n) => pid(i + 1, n)), bench: [4, 5].map((n) => pid(i + 1, n)), kit_colour: t.kit, version: 1 } }))
  return { match: { id, season_id: S, tournament_id: T, stage: 'group', round: 'Group A', label: null, kick_off: null, status: 'live', season_status: 'started', version: 1 },
    rules, clock: id !== mid(2) ? running : mock.m2 ? { running: false, anchor_at: mock.m2.at, elapsed_ms: 1200000, period: 1, interval: true } : { ...running, period: 1 }, score: { home: 0, away: 0 },
    events: mock.m2 && id === mid(2) ? [{ id: mock.m2.id, kind: 'period_end', period: 1, minute: 20, entered_at: mock.m2.at, home: 0, away: 0 }] : [], holder: true, held: true, on_air: id === mid(1), teams }
}

async function ctx() {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  // The app itself stays reachable while "offline" (a phone has it installed): the page's own files come through the route, not the network.
  await context.route(`${base}/**`, async (route) => route.fulfill({ response: await route.fetch() }))
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => mock.offline ? route.abort('internetdisconnected') : route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session(ANON, true)))
  await context.route(`${SUPA}/rest/v1/**`, async (route) => {
    const req = route.request()
    if (mock.offline) return route.abort('internetdisconnected')
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    if (cmd === 'console_match') return json(route, consoleFor(a.p_match_id))
    if (a.command_id) {
      mock.raw.push({ ...a, cmd })
      if (mock.refuse && cmd !== 'discard_command') return json(route, { ok: false, code: mock.refuse, message: null })
      if (mock.lose && cmd === 'next_period') return (mock.m2 ??= { id: a.command_id, at: a.at }, route.abort('failed'))
      if (!mock.ids.has(a.command_id)) (mock.ids.add(a.command_id), mock.calls.push({ ...a, cmd }))
      if (mock.slow && cmd === 'record_goal') await new Promise((r) => setTimeout(r, mock.slow))
    }
    return json(route, { ok: true, code: null, message: 'ok' }).catch(() => {})
  })
  await context.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v) }, ['tsl-score-auth', JSON.stringify(session(ANON, true))])
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, page }
}
const text = (page, t) => page.getByText(t, { exact: true })
const button = (page, name) => page.getByRole('button', { name, exact: true })
const dialog = (page) => page.getByRole('dialog')
const status = (page) => page.locator('.ui-save [aria-live="polite"]')
const scoreText = (page) => page.locator('.scoreboard-score').innerText()
const clockSecs = async (page) => { const [m, s] = (await page.getByTestId('clock').innerText()).split(':').map(Number); return m * 60 + s }
// The leave warning is armed when a cancelable beforeunload is cancelled by the page.
const armed = (page) => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })
const queue = (page) => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('tsl-outbox'); r.onsuccess = () => { const q = r.result.transaction('entries').objectStore('entries').getAll(); q.onsuccess = () => res(q.result) } }))
const pickScorer = async (page, goalButton, who) => {
  await button(page, goalButton).click()
  await dialog(page).getByRole('button', { name: who, exact: false }).first().click()
}

try {
  const { context, page } = await ctx()
  await page.goto(`${base}/score/${mid(1)}`)
  await text(page, 'RTM v RE8').waitFor()
  assert.equal(await armed(page), false, 'the leave warning with nothing waiting')

  // No signal. A goal, a card and a sub show at once, "Waiting", the status counts them; the second goal is undone before it was sent.
  mock.offline = true
  await context.setOffline(true)
  await pickScorer(page, 'GOAL RTM', 'RTM Player 1')
  await text(page, 'Offline · 1 change waiting to send').waitFor()
  assert.equal(await status(page).innerText(), 'Offline · 1 change waiting to send')
  await dialog(page).waitFor({ state: 'detached' }).catch(() => {})
  await button(page, 'Record card').click()
  await dialog(page).getByRole('button', { name: 'Give yellow card', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'RTM Player 2', exact: false }).click()
  await button(page, 'Record sub').click()
  await dialog(page).getByRole('button', { name: 'RTM Player 1', exact: false }).click()
  await dialog(page).getByRole('button', { name: 'RTM Player 4', exact: false }).click()
  await pickScorer(page, 'GOAL RE8', 'RE8 Player 1')
  assert.equal(await scoreText(page), '1 – 1')
  await button(page, 'Undo').click()
  assert.equal(await scoreText(page), '1 – 0')
  await text(page, 'Offline · 3 changes waiting to send').waitFor()
  assert.equal(await page.locator('.event-waiting').count(), 3, 'the goal, the card and the sub wait')
  assert.equal(await armed(page), true, 'the leave warning while changes wait')

  // The tab is killed and the phone opens the Scorer console again, still with no signal: the kept console, the queue on top of it, the clock running.
  const before = await clockSecs(page)
  await page.goto(`${base}/score/${mid(1)}`)
  await text(page, 'RTM v RE8').waitFor({ timeout: 5000 })
  await text(page, 'Offline · 3 changes waiting to send').waitFor()
  assert.equal(await scoreText(page), '1 – 0', 'the kept console with the goal applied')
  assert.equal(await page.locator('.event-waiting').count(), 3, 'the queue shows as Waiting')
  assert.ok(await clockSecs(page) >= before, 'the clock keeps running from the kept clock')
  assert.equal(await armed(page), true, 'the leave warning on the Scorer route')
  await button(page, 'Pause clock').click()
  await button(page, 'Resume clock').waitFor()
  await text(page, 'Offline · 4 changes waiting to send').waitFor()
  // A Match this phone never opened needs a signal the first time.
  await page.goto(`${base}/score/${mid(2)}`)
  await text(page, "This match hasn't been opened on this phone yet. It needs a signal the first time.").waitFor()

  // The phone opens the first Match again, still with no signal, then the signal is back: everything goes once, in the order it was entered, with the
  // minute and time of each tap, and the status says so. (Not while a page is mid-replay: a replay cut off by a reload is sent again, which the server answers from its stored result.)
  await page.goto(`${base}/score/${mid(1)}`)
  await text(page, 'Offline · 4 changes waiting to send').waitFor()
  mock.offline = false
  await context.setOffline(false)
  for (let i = 0; i < 80 && mock.calls.length < 4; i++) await page.waitForTimeout(100)
  await page.waitForTimeout(500)
  assert.deepEqual(mock.calls.map((c) => c.cmd), ['record_goal', 'record_event', 'record_event', 'pause_clock'], 'sent once each, in enqueue order')
  assert.equal(new Set(mock.calls.map((c) => c.command_id)).size, 4, 'one command id each')
  const [goal, card, sub, pause] = mock.calls
  assert.deepEqual([goal.minute, goal.period, goal.player_id], [26, 2, pid(1, 1)])
  assert.deepEqual([card.kind, card.card, card.minute, card.clock_ms > 330000], ['card', 'yellow', 26, true])
  assert.deepEqual([sub.kind, sub.player_id, sub.player_on_id, sub.minute], ['sub', pid(1, 1), pid(1, 4), 26])
  assert.ok([goal, card, sub, pause].every((c, i, l) => i === 0 || Date.parse(c.at) >= Date.parse(l[i - 1].at)), 'each keeps the time of its tap')
  assert.ok(Date.parse(pause.at) - Date.parse(goal.at) > 0 && Date.now() - Date.parse(goal.at) < 60000)
  assert.equal(await armed(page), false, 'the leave warning once nothing waits')
  await text(page, 'Saved · on the stream').waitFor().catch(() => { throw new Error(`no "Saved · on the stream": ${status(page)}`) })
  assert.equal(mock.raw.length, mock.calls.length, 'no request was repeated')

  // A clock command refused for the lock is held, not dropped: the clock stays as tapped, and the hand-back offers Try sending again and Discard (logged).
  mock.refuse = 'not_scoring_device'
  await button(page, 'Resume clock').click()
  await button(page, 'Pause clock').waitFor()
  await page.getByRole('alert').getByText("Couldn't save").waitFor()
  await button(page, 'Review this change').click()
  await dialog(page).getByRole('button', { name: 'Try sending again', exact: true }).waitFor()
  await dialog(page).getByRole('button', { name: 'Discard this change', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Discard this change', exact: true }).click()
  for (let i = 0; i < 40 && !mock.calls.some((c) => c.cmd === 'discard_command'); i++) await page.waitForTimeout(100)
  assert.equal(mock.calls.find((c) => c.cmd === 'discard_command').name, 'start_clock', 'the discard is logged')
  assert.equal((await queue(page)).length, 0, 'nothing left in the outbox')

  // A goal refused for the lock stays in the score; its assist is chained to it. Try sending again gives the goal a new id and the assist follows it.
  const was = await scoreText(page)
  await pickScorer(page, 'GOAL RTM', 'RTM Player 1')
  await button(page, 'Add assist').click()
  await dialog(page).getByRole('button', { name: 'RTM Player 2', exact: false }).click()
  for (let i = 0; i < 40 && !mock.raw.some((c) => c.cmd === 'add_assist'); i++) await page.waitForTimeout(100)
  await page.waitForTimeout(300)
  assert.notEqual(await scoreText(page), was, 'a held goal stays in the score')
  const old = mock.raw.find((c) => c.cmd === 'record_goal' && mock.refuse).command_id
  mock.refuse = null
  await button(page, 'Review refused changes').click()
  await dialog(page).getByRole('button', { name: 'Try sending again', exact: true }).click()
  for (let i = 0; i < 40 && !mock.calls.some((c) => c.cmd === 'record_goal' && c.command_id !== old && c.player_id === pid(1, 1) && c.minute === 26 && mock.calls.at(-1).cmd === 'record_goal'); i++) await page.waitForTimeout(100)
  const again = mock.calls.filter((c) => c.cmd === 'record_goal').at(-1)
  assert.notEqual(again.command_id, old, 'the retried goal has a new id')
  assert.equal((await queue(page)).find((e) => e.name === 'add_assist').args.event_id, again.command_id, 'the assist follows the goal')
  await dialog(page).getByRole('button', { name: 'Try sending again', exact: true }).click()
  for (let i = 0; i < 40 && !mock.calls.some((c) => c.cmd === 'add_assist'); i++) await page.waitForTimeout(100)
  assert.equal(mock.calls.find((c) => c.cmd === 'add_assist').event_id, again.command_id, 'the assist is sent for the new goal')

  // No signal, three goals, and the access token has expired: the console still opens from the kept read, the queue intact. Then the signal is back and a
  // reload cuts the replay short: each goal is sent (the server would answer a repeat from its stored result), none is lost.
  mock.offline = true
  await context.setOffline(true)
  for (const n of [1, 2, 3]) await pickScorer(page, 'GOAL RTM', `RTM Player ${n}`)
  const ids = (await queue(page)).filter((e) => e.name === 'record_goal').map((e) => e.commandId)
  assert.equal(ids.length, 3)
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('tsl-score-auth')); s.expires_at = Math.floor(Date.now() / 1000) - 100; localStorage.setItem('tsl-score-auth', JSON.stringify(s)) })
  await page.goto(`${base}/score/${mid(1)}`)
  await text(page, 'RTM v RE8').waitFor({ timeout: 8000 }).catch(async (e) => { console.log('BODY', await page.locator('body').innerText()); throw e })
  await text(page, 'Offline · 3 changes waiting to send').waitFor()
  mock.slow = 600
  mock.offline = false
  await context.setOffline(false)
  for (let i = 0; i < 80 && !mock.raw.some((c) => ids.includes(c.command_id)); i++) await page.waitForTimeout(50)
  await page.reload()
  await text(page, 'RTM v RE8').waitFor()
  mock.slow = 0
  for (let i = 0; i < 100 && (await queue(page)).length; i++) await page.waitForTimeout(100)
  assert.equal((await queue(page)).length, 0, 'the queue emptied after the reload')
  assert.deepEqual(ids.filter((id) => mock.calls.some((c) => c.command_id === id)), ids, 'every goal reached the server, each once')

  // The server applied "Start half-time" but the reply was lost: a reload (online) reads the divider and still holds the command; the period advances once.
  mock.lose = true
  await page.goto(`${base}/score/${mid(2)}`)
  await button(page, 'Start half-time').click()
  for (let i = 0; i < 40 && !mock.m2; i++) await page.waitForTimeout(50)
  await page.reload()
  await button(page, 'Start 2nd half').waitFor()
  assert.equal(await page.locator('.event-log li', { hasText: 'Half-time started' }).count(), 1, 'one divider')
  assert.equal(await text(page, '1st half').count() + (await text(page, '2nd half').count()), 0, 'the period did not advance twice')
  mock.lose = false
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
