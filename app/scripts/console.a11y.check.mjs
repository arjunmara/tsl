// Story 4.9 console layouts and sunlight check: the phone stack, the tablet grid, contrast, targets, 200% text, reduced motion and the keyboard, measured on rendered elements.
// At 360x740, 768x1024 and 1024x768, light and dark. Real Chrome, Supabase mocked by route interception. `npm run check:console-a11y`. Needs Google Chrome.
// Same console mock as goals.check.mjs; the contrast maths is a11y.check.mjs's (WCAG relative luminance), applied to computed colours.
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
const outDir = 'node_modules/.console-a11y-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4205 } })
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
const TEAMS = [{ id: tid(1), name: 'Tamghas Thunderbolts Under Twenty Reserve', code: 'RTM', kit: '#ff0000', n: 16 }, { id: tid(2), name: 'Eight Eagles', code: 'RE8', kit: '#0000ff', n: 10 },
  { id: tid(3), name: 'Green FC', code: 'GFC', kit: '#00aa00', n: 10 }]
const byId = (id) => TEAMS.find((t) => t.id === id)
const squad = (t) => Array.from({ length: t.n }, (_, i) => ({ player_id: pid(TEAMS.indexOf(t) + 1, i + 1), name: i === 0 ? 'Bahadur Gurung Thapa Magar Ghimire Pun' : `${t.code} Player ${i + 1}`, shirt: i + 1 }))



const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

// M1: live, clock paused at 5:30 of the 2nd half (20 + 5 + 1: a goal is minute 26). M2: live with the line-up swapped (the console lists Eight Eagles first). M3: scheduled.
const mock = { calls: [], events: {}, offline: false, conflict: false, asks: [] }
const frozen = { running: false, anchor_at: new Date().toISOString(), elapsed_ms: 330000, period: 2, interval: false }
const matches = [
  { id: mid(1), status: 'live', order: [0, 1], clock: frozen }, { id: mid(2), status: 'live', order: [1, 0], clock: frozen },
  { id: mid(3), status: 'scheduled', order: [0, 1], clock: { ...frozen, period: 0, elapsed_ms: 0 } },
  // 4: a level knockout Match (the Awards sheet asks for the shootout). 5: another phone holds scoring. 6: finished. 7: Season not started. 8: one Team only. 9: the console cannot be opened.
  { id: mid(4), status: 'live', order: [0, 1], clock: frozen, stage: 'knockout' }, { id: mid(5), status: 'live', order: [0, 1], clock: frozen, holder: false },
  { id: mid(6), status: 'finished', order: [0, 1], clock: frozen }, { id: mid(7), status: 'scheduled', order: [0, 1], clock: frozen, season: 'draft' },
  { id: mid(8), status: 'scheduled', order: [0], clock: frozen },
]
for (const m of matches) mock.events[m.id] = []
const score = (m, t) => mock.events[m.id].filter((e) => e.kind === 'goal' && e.team_id === t).length

function consoleFor(id) {
  const m = matches.find((x) => x.id === id)
  const teams = m.order.map((i, k) => ({ team_id: TEAMS[i].id, name: TEAMS[i].name, code: TEAMS[i].code, registered_kit: TEAMS[i].kit, side: k === 0 ? 'home' : 'away', squad: squad(TEAMS[i]),
    lineup: { starters: [1, 2, 3].map((n) => pid(i + 1, n)), bench: [], kit_colour: TEAMS[i].kit, version: 1 } }))
  return { match: { id, season_id: S, tournament_id: T, stage: m.stage ?? 'group', round: 'Group A', label: null, kick_off: null, status: m.status, season_status: m.season ?? 'started', version: 1 },
    rules: { starters: 3, max_bench: 9, periods: 2, extra_time_periods: 0, period_minutes: 20, extra_time_minutes: 5, foul_warning: 5, timeouts_per_period: 1, substitutions: 'rolling', max_substitutions: null, power_play_minutes: 2 }, clock: m.clock,
    score: { home: score(m, teams[0].team_id), away: teams[1] ? score(m, teams[1].team_id) : 0 }, events: mock.events[id], holder: m.holder !== false, held: true, on_air: false, teams }
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
    if (!req.postData()) return json(route, mock.asks.length ? [{ status: 'live', kick_off: null, scoring_device: null }] : [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    if (cmd === 'console_match') return a.p_match_id === mid(9) ? route.fulfill({ status: 500, headers: cors, contentType: 'application/json', body: '{"message":"boom"}' }) : json(route, consoleFor(a.p_match_id))
    if (cmd === 'scoring_state') {
      const mine = matches.find((x) => x.id === a.p_match_id)?.holder !== false
      return json(route, { version: 1, stamp: '0', status: 'live', held: true, mine, holder_label: mine ? null : 'Bikash phone', request: null, devices: mine ? [{ id: '33333333-0000-4000-8000-0000000000b1', label: 'Ana phone' }] : [] })
    }
    if (cmd === 'takeover_requests') return json(route, mock.asks)
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

const seed = () => Array.from({ length: 12 }, (_, i) => ({ id: `99999999-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'goal', period: i < 6 ? 1 : 2, minute: i + 1, entered_at: new Date().toISOString(),
  home: null, away: null, team_id: tid(1 + (i % 2)), player_id: pid(1 + (i % 2), 1), assist_id: null, own_goal: false, version: 1 }))
const button = (page, name) => page.getByRole('button', { name, exact: true })
const calls = (name) => mock.calls.filter((c) => c.cmd === name)

// Runs in the page. Computed colours with every translucent background composited over its ancestors; WCAG 2 contrast.
const measure = () => {
  const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 } }
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 })
  const lum = (c) => { const f = [c.r, c.g, c.b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2] }
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
  // The opaque colour behind an element's own box (its background included when `self`).
  const behind = (el, self) => {
    const layers = []
    for (let e = self ? el : el.parentElement; e; e = e.parentElement) {
      const bg = parse(getComputedStyle(e).backgroundColor)
      if (bg.a > 0) layers.push(bg)
      if (bg.a === 1) break
    }
    return layers.reduceRight((under, l) => over(l, under), { r: 255, g: 255, b: 255, a: 1 })
  }
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('[aria-hidden="true"], .ui-visually-hidden, dialog:not([open])') }
  const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 32)
  const bad = []
  // The console and the Organiser's take-over prompt (outside it) wear the same rules.
  const inRoots = (sel) => sel.split(',').flatMap((x) => ['.console ', '.takeover-prompt '].map((r) => r + x.trim())).join(', ')
  const seven = '.scoreboard-score, .scoreboard-team > .meta:nth-child(2), .kit-chip .body-strong, .picker-tile > span:first-child, .event-goal-text, .goal-button, .event-button'
  // Text: 7:1 for the named elements, 4.5:1 for the rest (3:1 for large text).
  const seen = new Set()
  const texts = [...document.querySelectorAll('.console, .takeover-prompt')].flatMap((root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const l = []; for (let n = w.nextNode(); n; n = w.nextNode()) l.push(n); return l })
  for (const n of texts) {
    const el = n.parentElement
    if (!n.textContent.trim() || seen.has(el) || !visible(el) || el.closest(':disabled, [disabled]')) continue
    seen.add(el)
    const s = getComputedStyle(el)
    const size = parseFloat(s.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
    const need = el.closest(seven) ? 7 : large ? 3 : 4.5
    const bg = behind(el, true)
    const r = ratio(over(parse(s.color), bg), bg)
    if (r < need) bad.push(`text "${label(el)}" ${r.toFixed(2)}:1, needs ${need}:1`)
  }
  // Outlines: a control's border (or its fill when it has none) against what is behind it; the kit-dot ring too.
  for (const el of document.querySelectorAll(inRoots('button, .ui-input, .ui-kit-dot'))) {
    if (!visible(el) || el.disabled) continue
    const s = getComputedStyle(el)
    if (parse(s.backgroundColor).a === 0 && !(parseFloat(s.borderTopWidth) > 0)) continue // a bare text button: its words are measured above
    const edge = parseFloat(s.borderTopWidth) >= 2 && parse(s.borderTopColor).a > 0 ? parse(s.borderTopColor) : parse(s.backgroundColor)
    const under = behind(el, false)
    const r = ratio(over(edge, under), under)
    if (r < 3) bad.push(`outline of "${label(el)}" ${r.toFixed(2)}:1, needs 3:1`)
  }
  // Targets: 64px and 8px apart (the Undo toast floats over the page, so its own buttons are measured among themselves).
  const controls = [...document.querySelectorAll(inRoots('button, .ui-input'))].filter(visible)
  for (const el of controls) {
    const r = el.getBoundingClientRect()
    if (r.width < 63.5 || r.height < 63.5) bad.push(`target "${label(el)}" is ${Math.round(r.width)}x${Math.round(r.height)}`)
  }
  const group = (el) => (el.closest('.undo-toast') ? 'toast' : el.closest('dialog') ? 'sheet' : 'page')
  controls.forEach((a, i) => controls.slice(i + 1).forEach((b) => {
    if (group(a) !== group(b) || a.contains(b) || b.contains(a)) return
    const x = a.getBoundingClientRect(), y = b.getBoundingClientRect()
    const dx = Math.max(0, x.left - y.right, y.left - x.right), dy = Math.max(0, x.top - y.bottom, y.top - x.bottom)
    if (Math.hypot(dx, dy) < 7.5) bad.push(`"${label(a)}" and "${label(b)}" are ${Math.hypot(dx, dy).toFixed(1)}px apart`)
  }))
  // Names wrap: no ellipsis, nothing clipped, nothing sideways.
  for (const el of document.querySelectorAll(inRoots('*'))) {
    if (!visible(el)) continue
    const s = getComputedStyle(el)
    if (s.textOverflow === 'ellipsis') bad.push(`"${label(el)}" has an ellipsis`)
    if (el.matches('.scoreboard-team > .meta, .picker-tile > span, .event-goal-text')) {
      if (s.overflowWrap !== 'anywhere') bad.push(`"${label(el)}" does not wrap (${s.overflowWrap})`)
      if (el.scrollWidth > el.clientWidth + 1) bad.push(`"${label(el)}" is clipped`)
    }
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth) bad.push('the page scrolls sideways: ' + [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).slice(0, 4).map((e) => e.tagName + '.' + e.className).join(', '))
  for (const el of document.querySelectorAll(inRoots('button') + ', dialog[open] button')) {
    const r = el.getBoundingClientRect()
    if (visible(el) && (r.left < -0.5 || r.right > innerWidth + 0.5)) bad.push(`"${label(el)}" spans ${Math.round(r.left)}-${Math.round(r.right)}px`)
  }
  // Names: every control has one.
  for (const el of document.querySelectorAll(inRoots('button, input, select, [role="button"]'))) {
    if (!visible(el)) continue
    const by = el.getAttribute('aria-labelledby')
    const name = el.getAttribute('aria-label') || (by && document.getElementById(by)?.textContent) || el.labels?.[0]?.textContent ||
      [...el.childNodes].map((c) => (c.nodeType === 3 ? c.textContent : c.getAttribute?.('aria-hidden') === 'true' ? '' : c.textContent)).join('')
    if (!name.trim()) bad.push(`a ${el.tagName.toLowerCase()} has no accessible name`)
  }
  return bad
}

// Tab through the page: the stops in order, with each one's focus ring and place.
async function tabStops(page, limit = 60) {
  await page.evaluate(() => document.activeElement?.blur())
  const stops = []
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab')
    const s = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const parse = (c) => c.match(/[\d.]+/g).map(Number)
      let bg = [255, 255, 255]
      for (let e = el.parentElement; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if ((c[3] ?? 1) === 1) { bg = c.slice(0, 3); break } }
      const lum = (c) => { const f = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2] }
      const o = parse(cs.outlineColor).slice(0, 3)
      const [hi, lo] = [lum(o), lum(bg)].sort((x, y) => y - x)
      const toast = document.querySelector('.undo-toast')?.getBoundingClientRect()
      const hit = !!toast && !el.closest('.undo-toast') && r.bottom > toast.top && r.top < toast.bottom && r.right > toast.left && r.left < toast.right
      return { name: (el.getAttribute('aria-label') || el.textContent).replace(/\s+/g, ' ').trim().slice(0, 30), x: r.x, y: r.y + scrollY, right: r.right, inToast: !!el.closest('.undo-toast'),
        ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2, ringRatio: (hi + 0.05) / (lo + 0.05), ringColour: cs.outlineColor, covered: hit, inView: r.top >= -1 && r.bottom <= innerHeight + 1 }
    })
    if (!s || (stops.length && stops[0].name === s.name && stops.length > 2 && s.name === stops[0].name && i > 3 && stops.some((t) => t.name === s.name && t.y === s.y && t !== stops[stops.length - 1] && false))) break
    if (stops.some((t) => t.name === s.name && t.y === s.y && t.x === s.x)) break
    stops.push(s)
  }
  return stops
}

async function open(page, width, height, scheme, opts = {}) {
  await page.setViewportSize({ width, height })
  // 'attr-dark': a light device with data-theme="dark" set; 'dark': a dark device.
  await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'dark' : 'light', reducedMotion: opts.reduce ? 'reduce' : 'no-preference' })
  mock.events[mid(1)] = seed()
  mock.calls.length = 0
  await page.goto(`${base}/t/${T}/score/${opts.match ?? mid(1)}`)
  if (!opts.state) await page.getByText(opts.title ?? 'RTM v RE8', { exact: true }).waitFor()
  if (scheme === 'attr-dark') await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  if (opts.zoom) await page.evaluate(() => (document.documentElement.style.fontSize = '200%'))
}
async function goal(page) {
  await button(page, 'GOAL RTM').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Bahadur', exact: false }).first().click()
  await page.getByRole('group', { name: 'Goal recorded' }).waitFor()
  for (let i = 0; i < 50 && !calls('record_goal').length; i++) await page.waitForTimeout(100)
}
const tops = (page, sels) => page.evaluate((l) => l.map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { s, top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right } }), sels)
const order = ['.scoreboard', '.clock-controls', '.goal-buttons', '.event-buttons', '.save-bar', '.event-log-panel']

try {
  const { page } = await ctx()
  const scores = {}
  for (const scheme of ['light', 'dark', 'attr-dark']) {
    for (const [w, h] of [[360, 740], [740, 360], [768, 1024], [1024, 768]]) {
      const where = `${w}x${h} ${scheme}`
      await open(page, w, h, scheme)
      assert.deepEqual(await page.evaluate(measure), [], `${where}: page`)
      scores[w] = await page.$eval('.scoreboard-score', (e) => parseFloat(getComputedStyle(e).fontSize))

      // Layout.
      const t = await tops(page, order)
      if (w === 1024) {
        const log = t[5]
        assert.ok(t.slice(0, 5).every((x) => x.right <= log.left + 1), `${where}: controls left of the Event log`)
        assert.ok(t.slice(0, 4).every((x, i, a) => i === 0 || x.top >= a[i - 1].bottom - 1), `${where}: controls stack on the left`)
        const own = await page.$eval('.event-log-panel', (e) => ({ y: getComputedStyle(e).overflowY, over: e.scrollHeight > e.clientHeight }))
        assert.deepEqual(own, { y: 'auto', over: true }, `${where}: Event log scrolls on its own`)
      } else {
        t.forEach((x, i) => i && assert.ok(x.top >= t[i - 1].top && x.top + 1 >= t[i - 1].bottom - (order[i] === '.save-bar' ? 0 : 0), `${where}: ${order[i]} after ${order[i - 1]}`))
        assert.equal(await page.$eval('.event-log-panel', (e) => getComputedStyle(e).overflowY), 'visible', `${where}: stacked log does not scroll apart`)
      }

      // A goal: the toast is the next Tab stop after the Goal buttons; focus rings; nothing under the toast; room kept for it.
      await goal(page)
      assert.deepEqual(await page.evaluate(measure), [], `${where}: with the toast`)
      const room = await page.evaluate(() => ({ pad: parseFloat(getComputedStyle(document.querySelector('.console')).paddingBottom), toast: document.querySelector('.undo-toast').getBoundingClientRect().height }))
      assert.ok(room.pad >= room.toast, `${where}: room ${room.pad}px for a ${room.toast}px toast`)
      const stops = await tabStops(page)
      const names = stops.map((s) => s.name)
      const lastGoal = names.indexOf('GOAL') >= 0 ? names.findLastIndex((n) => n.startsWith('GOAL')) : names.findLastIndex((n) => n.startsWith('GOAL RE8'))
      assert.ok(stops[lastGoal + 1]?.inToast, `${where}: toast is not the stop after the Goal buttons (${names.slice(lastGoal - 1, lastGoal + 3)})`)
      const toastRing = stops.filter((s) => s.inToast)
      assert.ok(toastRing.length === 2 && toastRing.every((s) => s.ringColour === 'rgb(246, 196, 83)'), `${where}: gold ring on the toast`)
      for (const s of stops) {
        assert.ok(s.ring && s.ringRatio >= 3, `${where}: focus ring of "${s.name}" ${s.ringRatio.toFixed(2)}:1`)
        assert.ok(!s.covered, `${where}: the toast covers "${s.name}"`)
      }
      const page1 = stops.filter((s) => !s.inToast)
      page1.forEach((s, i) => {
        const p = page1[i - 1]
        if (p) assert.ok(w === 1024 ? s.x >= p.x - 1 || s.y >= p.y - 1 : s.y >= p.y - 1, `${where}: Tab goes back up from "${p.name}" to "${s.name}"`)
      })
      if (w === 1024) {
        const cut = page1.findIndex((s) => s.name.startsWith('Edit'))
        assert.ok(cut > 0 && page1.slice(cut).every((s) => (s.name.startsWith('Edit') && s.x > 700) || s.name === 'Show on stream'), `${where}: the Event log is the last Tab stops ${JSON.stringify(page1.map((x) => [x.name, Math.round(x.x), Math.round(x.y)]))}`)
      }

      // Pickers: the Player picker and the card picker, measured while open; Escape returns focus to the opener.
      await page.evaluate(() => document.activeElement?.blur())
      await page.getByRole('button', { name: 'GOAL RE8', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('dialog').waitFor()
      assert.deepEqual(await page.evaluate(measure), [], `${where}: Player picker`)
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'GOAL RE8', `${where}: focus returns to the opener`)
      await button(page, 'Record card').focus()
      await page.keyboard.press('Enter')
      await page.getByRole('dialog').waitFor()
      assert.deepEqual(await page.evaluate(measure), [], `${where}: card picker`)
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      assert.equal(await page.evaluate(() => document.activeElement?.textContent.includes('Record card')), true, `${where}: focus returns to Record card`)

      // Enter and Space on anything that is not a button record nothing.
      const before = mock.calls.length
      await page.evaluate(() => document.activeElement?.blur())
      await page.locator('.scoreboard-score').click({ force: true })
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(150)
      assert.equal(mock.calls.length, before, `${where}: a key press outside a button recorded something`)
      assert.equal(await page.locator('dialog[open]').count(), 0)
    }
  }
  assert.ok(scores[768] > scores[360], `the score grows on a tablet (${scores[360]}px -> ${scores[768]}px)`)

  // 200% text on a phone, both themes: everything reachable, nothing clipped, names wrap, the toast covers nothing focused.
  for (const scheme of ['light', 'dark', 'attr-dark']) {
    const where = `200% ${scheme}`
    await open(page, 360, 740, scheme, { zoom: true })
    assert.deepEqual(await page.evaluate(measure), [], `${where}: page`)
    const empty = await page.$eval('.console', (e) => parseFloat(getComputedStyle(e).paddingBottom))
    await goal(page)
    assert.deepEqual(await page.evaluate(measure), [], `${where}: with the toast`)
    const room = await page.evaluate(() => ({ pad: parseFloat(getComputedStyle(document.querySelector('.console')).paddingBottom), toast: document.querySelector('.undo-toast').getBoundingClientRect().height }))
    assert.ok(empty >= 352 && room.pad >= room.toast, `${where}: room ${room.pad}px (empty ${empty}px) for a ${room.toast}px toast`)
    const stops = await tabStops(page, 80)
    assert.ok(stops.length > 12, `${where}: ${stops.length} stops`)
    await button(page, 'GOAL RE8').focus()
    for (const s of stops) assert.ok(!s.covered && s.inView, `${where}: "${s.name}" is covered or off screen`)
    for (const el of await page.locator('.console button:visible').elementHandles()) {
      await el.scrollIntoViewIfNeeded()
      const hit = await el.evaluate((e) => { const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!top && (e === top || e.contains(top) || !!top.closest('.undo-toast')) })
      assert.ok(hit, `${where}: a control is hidden behind another`)
    }
    await button(page, 'GOAL RE8').click()
    await page.getByRole('dialog').waitFor()
    assert.deepEqual(await page.evaluate(measure), [], `${where}: picker`)
  }

  // Every other surface of the console, on a phone at 100% and 200% text, in the three themes.
  const keyboard = async (target) => {
    await target.focus()
    await page.evaluate(() => (window.__opener = document.activeElement))
    await page.keyboard.press('Enter')
  }
  // Escape closes the sheet; focus goes back to the opener, or to the page's main when the opener has gone.
  const escape = async (where) => {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog[open]'))
    const at = await page.evaluate(() => { const o = window.__opener, a = document.activeElement; return o?.isConnected ? a === o : a?.tagName === 'MAIN' })
    assert.ok(at, `${where}: focus did not return to the opener (${await page.evaluate(() => [window.__opener?.outerHTML.slice(0, 80), window.__opener?.isConnected, document.activeElement?.outerHTML.slice(0, 80), document.querySelector('main')?.outerHTML.slice(0, 60), document.querySelector('dialog[open]') !== null])})`)
  }
  const clean = async (where) => assert.deepEqual(await page.evaluate(measure), [], where)
  for (const scheme of ['light', 'dark', 'attr-dark']) {
    for (const zoom of [false, true]) {
      const at = (what) => `${what} ${scheme}${zoom ? ' 200%' : ''}`
      const go = (match, o = {}) => open(page, 360, 740, scheme, { zoom, match, ...o })

      // Correct the clock (the form, then its Confirm sheet) and Hand over scoring.
      await go(mid(1))
      await button(page, 'Open scoreboard menu').click()
      await keyboard(button(page, 'Correct the clock'))
      await page.locator('#fix-clock').waitFor()
      await clean(at('Correct the clock'))
      await keyboard(button(page, 'Review the clock change'))
      await page.getByRole('dialog').waitFor()
      await clean(at('Confirm sheet'))
      await escape(at('Confirm sheet'))
      await go(mid(1))
      await button(page, 'Open scoreboard menu').click()
      await keyboard(button(page, 'Hand over scoring'))
      await page.getByRole('dialog', { name: 'Hand over scoring' }).waitFor()
      await clean(at('Hand over sheet'))
      await escape(at('Hand over sheet'))

      // Edit goal.
      await go(mid(1))
      await keyboard(page.getByRole('button', { name: /^Edit goal/ }).first())
      await page.getByRole('dialog', { name: /^Edit goal/ }).waitFor()
      await clean(at('Edit goal sheet'))
      await escape(at('Edit goal sheet'))

      // End the match, then the Awards sheet with its shootout, and a Player picker over it.
      await go(mid(4))
      await keyboard(button(page, 'End the match'))
      await page.getByRole('dialog').waitFor()
      await clean(at('End the match sheet'))
      await page.getByRole('dialog').getByRole('button', { name: 'End the match', exact: true }).click()
      await page.getByRole('dialog', { name: 'Finish the match' }).waitFor()
      await page.evaluate(() => (window.__opener = null)) // the End button is gone: focus goes to main
      await clean(at('Awards sheet'))
      await page.getByRole('dialog').getByRole('button', { name: /^Pick Man of the Match/ }).click()
      await page.getByRole('dialog', { name: 'Who is the Man of the Match?' }).waitFor()
      await clean(at('Award picker'))
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: 'Finish the match' }).waitFor()
      await escape(at('Awards sheet'))

      // Read-only, pre-match and finished.
      await go(mid(5))
      await page.locator('.handover-follow').waitFor()
      await clean(at('Following view'))
      await go(mid(3))
      await page.locator('.prematch').first().waitFor()
      await clean(at('Pre-match'))
      await go(mid(6))
      await page.getByText('This Match is finished.', { exact: true }).waitFor()
      await clean(at('Finished match'))

      // The Organiser's take-over prompt, outside the console.
      mock.asks = [{ id: 'req-1', season_id: S, label: 'Ana phone', home_code: 'RTM', away_code: 'RE8', holder_label: null, expires_at: new Date(Date.now() + 120000).toISOString(), version: 1 }]
      await go(mid(1))
      await page.locator('.takeover-prompt').waitFor()
      await clean(at('Take-over prompt'))
      mock.asks = []
    }
  }

  // The Save status shows in every console state: loading cannot be held still, so the others.
  for (const [id, state] of [[mid(1), 'ready'], [mid(3), 'pre-match'], [mid(5), 'read-only'], [mid(6), 'finished'], [mid(7), 'not started'], [mid(8), 'one Team'], [mid(9), 'unopenable']]) {
    await open(page, 360, 740, 'light', { match: id, state: true })
    await page.locator('.console').first().waitFor()
    await page.waitForTimeout(400)
    assert.equal(await page.locator('.save-bar').count(), 1, `${state}: Save status not shown once`)
    assert.equal(await page.locator('.console .save-bar').count(), 1, `${state}: Save status is not inside the console`)
  }

  // Reduced motion: record a goal and open a picker; nothing on the page has a transition or an animation, and the score changes at once.
  await open(page, 360, 740, 'light', { reduce: true })
  const was = await page.locator('.scoreboard-score').innerText()
  await goal(page)
  assert.notEqual(await page.locator('.scoreboard-score').innerText(), was, 'the score changed at once')
  await button(page, 'GOAL RE8').click()
  await page.getByRole('dialog').waitFor()
  const moving = await page.evaluate(() => [...document.querySelectorAll('*, *::before, *::after')].flatMap((e) => ['', '::before', '::after'].map((p) => [e, p])).filter(([e, p]) => {
    const s = getComputedStyle(e, p)
    return s.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || (s.animationName !== 'none' && s.animationName !== '') || e.getAnimations?.().length
  }).map(([e]) => e.className || e.tagName))
  assert.deepEqual(moving, [], 'reduced motion: something still moves')
  await page.close()
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
