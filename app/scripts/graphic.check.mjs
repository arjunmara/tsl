// Story 5.1 check: the Result Graphic of a finished Match in the Classic Template: layout and fixed rules, the caption, Share (share sheet with the PNG and caption, cancel), Download
// (PNG of exactly 1080x1350 plus the copied caption, or the caption as text when the clipboard is blocked), the failure message with a working retry, zero Storage uploads and zero
// `app` writes, and the Venue field (editable after start, 80 characters). Story 5.3 adds the Player Graphics: cut-out only through the consent gate, text-only own and
// unknown goals, Awards, captions, file names, contrast with the panel's 5% blend, and a source scan. Real Chrome, Supabase mocked by route interception. `npm run check:graphic`.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ORG = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const outDir = 'node_modules/.graphic-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA', VITE_PLATFORM_NAME: 'Test Platform' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4201 } })
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
const squad = (i) => Array.from({ length: 9 }, (_, n) => ({ player_id: pid(i + 1, n + 1), name: n === 8 ? ['Roshan Adhikari', 'Dilson Sunar'][i] : `${TEAMS[i].code} Player ${n + 1}`, shirt: n + 1 }))
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

const goal = (id, team, player, minute, extra = {}) => ({ id, kind: 'goal', period: 1, minute, entered_at: new Date(Date.now() - 600000 + minute * 1000).toISOString(), home: null, away: null,
  team_id: team, player_id: player, assist_id: null, own_goal: false, version: 1, ...extra })
const ev = (id, kind, team, player, minute, extra = {}) => goal(id, team, player, minute, { kind, ...extra })
const g = (n) => `e${n}000000-0000-4000-8000-000000000000`
// M1: 3-2 with an own goal and an unknown scorer (newest first, as the server sends them). M2: 2-2, shootout 4-3.
const events = {
  [mid(1)]: [goal(g(5), tid(1), pid(1, 2), 31), goal(g(4), tid(2), null, 20), goal(g(3), tid(1), null, 14, { own_goal: true }), goal(g(2), tid(2), pid(2, 1), 9), goal(g(1), tid(1), pid(1, 1), 5)],
  [mid(3)]: Array.from({ length: 12 }, (_, i) => goal(`e${20 - i}000000-0000-4000-8000-000000000000`, tid(1), pid(1, (i % 3) + 1), 12 - i)),
  // M4: 3-1. Consented cut-out (Roshan, with an assist), an own goal, an unknown scorer, and a scorer without consent.
  [mid(4)]: [goal(g(14), tid(1), pid(1, 2), 33), goal(g(13), tid(2), null, 27), goal(g(12), tid(1), null, 20, { own_goal: true }), goal(g(11), tid(1), pid(1, 9), 12, { assist_id: pid(1, 2) })],
  // M5 (the full pack): 2 goals, a yellow, a red, a missed penalty, a card with no Player on record, both Awards. M6: nothing at all.
  [mid(5)]: [ev(g(24), 'missed_penalty', tid(1), pid(1, 1), 25), ev(g(23), 'card', tid(2), null, 30, { card: 'yellow' }), ev(g(22), 'card', tid(2), pid(2, 2), 22, { card: 'red' }),
    goal(g(21), tid(2), pid(2, 1), 17), ev(g(20), 'card', tid(1), pid(1, 3), 8, { card: 'yellow' }), goal(g(19), tid(1), pid(1, 2), 4)],
  [mid(6)]: [],
  [mid(2)]: [goal(g(9), tid(2), pid(2, 3), 38), goal(g(8), tid(1), pid(1, 3), 30), goal(g(7), tid(2), pid(2, 1), 12), goal(g(6), tid(1), pid(1, 1), 3)],
}
const matches = [
  { n: 1, kick_off: '2033-11-13T10:00:00+05:45', hg: 3, ag: 2, home_pens: null, away_pens: null },
  { n: 2, kick_off: '2033-11-14T10:00:00+05:45', hg: 2, ag: 2, home_pens: 4, away_pens: 3 },
  { n: 3, kick_off: null, hg: 12, ag: 0, home_pens: null, away_pens: null },
  { n: 4, kick_off: '2033-11-13T10:00:00+05:45', hg: 3, ag: 1, home_pens: null, away_pens: null },
  { n: 5, kick_off: '2033-11-15T10:00:00+05:45', hg: 1, ag: 1, home_pens: null, away_pens: null },
  { n: 6, kick_off: '2033-11-16T10:00:00+05:45', hg: 0, ag: 0, home_pens: null, away_pens: null },
].map((m) => ({ id: mid(m.n), stage: m.n === 1 ? 'group' : 'knockout', round: m.n === 1 ? 'Group A' : 'Final', label: null, ord: m.n, home_team_id: tid(1), away_team_id: tid(2),
  home_src: null, away_src: null, status: 'finished', version: 2, ...m }))
const rules = { starters: 3, max_bench: 9, periods: 2, extra_time_periods: 0, period_minutes: 20, extra_time_minutes: 5, substitutions: 'rolling' }
const frozen = { running: false, anchor_at: new Date().toISOString(), elapsed_ms: 2400000, period: 2, interval: false }
const LONG = 'Extraordinarily Long Name For A Futsal Side That Goes On And On Forever Ok'
function consoleFor(id, long, kits) {
  const m = matches.find((x) => x.id === id)
  const teams = TEAMS.map((t, i) => ({ team_id: t.id, name: long ? `${t.name} ${LONG}`.slice(0, 80) : t.name, code: t.code, registered_kit: kits?.[i] ?? t.kit, side: i === 0 ? 'home' : 'away', squad: squad(i),
    lineup: { starters: [1, 2, 3].map((n) => pid(i + 1, n)), bench: [4, 5].map((n) => pid(i + 1, n)), kit_colour: kits?.[i] ?? t.kit, version: 1 } }))
  return { match: { id, season_id: S, tournament_id: T, stage: m.stage, round: m.round, label: null, kick_off: m.kick_off, status: 'finished', season_status: 'started', version: 2,
    home_team_id: tid(1), away_team_id: tid(2), home_pens: m.home_pens, away_pens: m.away_pens, mom_player_id: id === mid(4) ? pid(1, 9) : id === mid(5) ? pid(1, 2) : null, fair_player_id: id === mid(4) ? pid(2, 9) : id === mid(5) ? pid(2, 1) : null },
    rules, clock: frozen, score: { home: 0, away: 0 }, events: events[id], holder: true, held: true, on_air: false, teams }
}

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const READS = new Set(['console_match', 'server_now', 'standings', 'match_sides', 'season_top_scorers', 'takeover_requests', 'scoring_state', 'finish_check'])

/** variant 'full': logo, brand colours, two Sponsors and a venue; 'plain': none of them. A Season in the started state. brand: { primary, secondary, kits } overrides the colours. */
async function open({ variant = 'full', init = '', long = false, brand = null, list = null, template = 'classic', three = false } = {}) {
  const mock = { writes: [], commands: [], signed: [], views: [] }
  let tplNow = template, tplVersion = 1
  const season = { id: S, number: 1, status: 'started', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
    starts_on: '2033-11-07', ends_on: '2033-11-21', registration_deadline: '2033-11-03', structure: 'groups_knockout', group_count: 2, teams_per_group: 4, qualifiers_per_group: 2,
    venue: variant === 'full' ? 'Tamghas Arena' : null }
  if (list?.structure) season.structure = list.structure
  const sponsors = variant === 'full'
    ? [{ id: 'a1', caption: 'Alpha Co', logo_path: `${T}/a1.webp`, ad_paths: [], version: 1, sort: 0 }, { id: 'b2', caption: 'Beta Ltd', logo_path: `${T}/b2.webp`, ad_paths: [], version: 1, sort: 1 },
      ...(three ? [{ id: 'c3', caption: 'Gamma Industries Pvt Ltd', logo_path: `${T}/c3.webp`, ad_paths: [], version: 1, sort: 2 }] : [])] : []
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1200 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/storage/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    // Signing a URL is a read.
    if (req.method() === 'POST' && req.url().includes('/object/sign/player-photos')) {
      const b = JSON.parse(req.postData())
      mock.signed.push(b)
      return json(route, b.paths.map((path) => ({ path, signedURL: `/object/sign/player-photos/${path}?token=t`, error: null })))
    }
    if (req.method() !== 'GET') mock.writes.push(`${req.method()} ${req.url()}`)
    return route.fulfill({ status: 200, headers: cors, contentType: 'image/png', body: PIXEL })
  })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    // Routed requests ignore setOffline, so a test that goes offline also drops what it sends.
    if (mock.drop && req.method() === 'POST') return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') {
      // The full variant has a later Season with another venue: the Graphic reads the venue of the Match's own Season (S).
      const later = { ...season, id: '22222222-0000-4000-8000-000000000010', number: 2, venue: 'Latest Venue' }
      return json(route, [{ id: T, name: long ? LONG : 'Gulmi Cup', brand_primary: brand?.primary ?? (variant === 'full' ? '#f6c453' : '#0a1a3f'), brand_secondary: brand?.secondary ?? '#f58220', logo_path: variant === 'full' ? `${T}/logo.webp` : null, version: tplVersion, template: tplNow, season: variant === 'full' ? [season, later] : [season] }])
    }
    if (path === '/rest/v1/season' && new URL(req.url()).searchParams.get('select') === 'fixtures_published_at') return json(route, [{ fixtures_published_at: list?.published ? '2033-11-01T00:00:00Z' : null }])
    if (path === '/rest/v1/draw_slot') return json(route, list?.slots ?? [])
    if (path === '/rest/v1/season') return json(route, { venue: new URL(req.url()).searchParams.get('id') === `eq.${S}` ? season.venue : 'Latest Venue' })
    if (path === '/rest/v1/player_photo_public') {
      // What the consent view gives: a path only for a consented cut-out (Roshan); others come back null. Anyone else's photo is never in the answer.
      mock.views.push(req.url())
      return json(route, [{ player_id: pid(1, 9), photo_path: `${T}/roshan.webp` }, { player_id: pid(2, 9), photo_path: null }, { player_id: pid(1, 2), photo_path: null }])
    }
    if (path === '/rest/v1/sponsor') return json(route, sponsors)
    if (path === '/rest/v1/squad_entry') return json(route, list?.squad ?? [])
    if (path === '/rest/v1/season_awards') return json(route, list?.awards ?? [])
    if (path === '/rest/v1/team') return json(route, (list?.teams ?? TEAMS).map((t) => ({ id: t.id, name: t.name, code: t.code, kit_colour: t.kit, status: 'approved', registration_link: [], version: 1 })))
    if (path === '/rest/v1/match') return json(route, list?.matches ?? matches)
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (req.method() !== 'GET' && !path.startsWith('/rest/v1/rpc/')) mock.writes.push(`${req.method()} ${path}`)
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    if (req.method() !== 'GET' && !READS.has(cmd)) mock.commands.push({ cmd, ...a })
    if (req.method() !== 'GET' && !READS.has(cmd) && !/^(set_season_venue|set_setup_step|set_season_award|set_template)$/.test(cmd)) mock.writes.push(`${req.method()} ${path}`)
    if (cmd === 'standings' && list) return json(route, list.rows)
    if (cmd === 'match_sides' && list?.sides) return json(route, list.sides)
    if (cmd === 'season_top_scorers') return json(route, list?.scorers ?? [])
    if (cmd === 'set_template') {
      // The server's side: the Template changes and the Tournament's version moves on.
      tplNow = a.template
      tplVersion += 1
      return json(route, { ok: true, code: null, message: 'Template saved.', version: tplVersion })
    }
    if (cmd === 'set_season_award') {
      // The server's side: a new award is version 1, a change bumps it.
      const row = list.awards.find((x) => x.award === a.award)
      if (row) Object.assign(row, { player_id: a.player_id, version: row.version + 1 })
      else list.awards.push({ id: `a${list.awards.length + 1}000000-0000-4000-8000-000000000000`, award: a.award, player_id: a.player_id, version: 1 })
      return json(route, { ok: true, code: null, message: 'Award saved.', version: row ? row.version : 1 })
    }
    if (cmd === 'console_match') return json(route, consoleFor(a.p_match_id, long, brand?.kits))
    if (READS.has(cmd)) return json(route, [])
    return json(route, { ok: true, code: null, message: 'ok', version: 4 })
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { page, mock }
}

const button = (p, name) => p.getByRole('button', { name, exact: true })
const status = (p) => p.locator('.graphic-card [role="status"]').first()
const ready = async (p, n) => { await p.goto(`${base}/t/${T}/m/${mid(n)}/pack`); await button(p, 'Download this Graphic').waitFor({ timeout: 30000 }) }
const alt = (p) => p.locator('.graphic-thumb').first().getAttribute('aria-label')
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)]
const download = async (p) => {
  const [d] = await Promise.all([p.waitForEvent('download'), button(p, 'Download this Graphic').click()])
  return { name: d.suggestedFilename(), buf: readFileSync(await d.path()) }
}
/**
 * Story 5.2: every text layer (an element with its own text) against the opaque fill directly behind it (the nearest ancestor with an opaque
 * background), at 4.5:1, or 3:1 at 70px and up. Any see-through text or fill fails, since its contrast can't be read off the DOM.
 */
const audit = (p, sel = '.graphic-classic') => p.locator(sel).evaluateAll((roots) => roots.flatMap((root) => {
  const rgba = (s) => { const v = s.match(/[\d.]+/g).map(Number); return v.length === 3 ? [...v, 1] : v }
  const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
  const layers = []
  for (const el of root.querySelectorAll('*')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
    const cs = getComputedStyle(el)
    let fill = el
    while (fill && rgba(getComputedStyle(fill).backgroundColor)[3] === 0) fill = fill.parentElement
    let see = rgba(cs.color)[3] < 1
    for (let n = el; n && n !== root.parentElement; n = n.parentElement) if (getComputedStyle(n).opacity !== '1') see = true
    const bg = rgba(getComputedStyle(fill).backgroundColor)
    const px = parseFloat(cs.fontSize)
    // A fill at least 95% opaque (the Player panel over the cut-out) is measured as the fill blended 5% with black and with white, the worst of the two.
    const worst = bg[3] >= 0.95 && bg[3] < 1 ? Math.min(...[0, 255].map((k) => ratio(rgba(cs.color), bg.slice(0, 3).map((v) => v * 0.95 + k * 0.05)))) : ratio(rgba(cs.color), bg)
    layers.push({ cls: el.className, text: el.textContent.slice(0, 20), px, ratio: Math.round(worst * 100) / 100, need: px >= 70 ? 3 : 4.5, see: see || bg[3] < 0.95 })
  }
  return layers
}))
const COLOURS = [
  { primary: '#f6c453', secondary: '#ffffff', kits: ['#ffffff', '#f6c453'] },
  { primary: '#ffff00', secondary: '#ffffff', kits: ['#777777', '#808080'] },
  { primary: '#fde68a', secondary: '#f6c453', kits: ['#ffff00', '#000000'] },
  { primary: '#777777', secondary: '#ffffff', kits: ['#e0457b', '#00a0e0'] },
  { primary: '#e0457b', secondary: '#0a1a3f', kits: ['#0a1a3f', '#ff0000'] },
  { primary: '#00a0e0', secondary: '#ffffff', kits: ['#808080', '#0000ff'] },
]

const DATE = /^Full time: Red Tigers 3, Eight Eagles 2\. Group A, Gulmi Cup\. Goals: RTM RTM Player 1 5′, RTM \(og\) 14′, RTM RTM Player 2 31′, RE8 RE8 Player 1 9′, RE8 Unknown 20′\. \w+ · \w+ \d+, 20\d\d BS \(13 Nov 2033\), Tamghas Arena\. Sponsored by Alpha Co, Beta Ltd\.$/

try {
  // Full: the layout's fixed rules, the caption, the PNG and the copied caption; nothing is uploaded or written.
  {
    const { page: p, mock } = await open()
    await ready(p, 1)
    const caption = await alt(p)
    assert.match(caption, DATE)
    const facts = await p.locator('.graphic-classic').evaluate((el) => {
      const px = (sel) => [...el.querySelectorAll(sel)].map((n) => parseFloat(getComputedStyle(n).fontSize))
      const bottom = (sel) => { const n = el.querySelector(sel); return n.offsetTop + n.offsetHeight }
      return { w: el.offsetWidth, h: el.offsetHeight, fits: el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth,
        facts: px('.graphic-goals li').concat(px('.graphic-when')), sponsors: px('.graphic-plate span'), made: px('.graphic-made'), score: px('.graphic-score'),
        madeText: el.querySelector('.graphic-made').textContent, madeOpacity: getComputedStyle(el.querySelector('.graphic-made')).opacity, madeBottom: bottom('.graphic-made'),
        score_text: el.querySelector('.graphic-score').textContent, goals: [...el.querySelectorAll('.graphic-goals ul')].map((u) => u.innerText.split('\n')),
        logo: !!el.querySelector('.graphic-logo'), plates: el.querySelectorAll('.graphic-plate').length, crests: [...el.querySelectorAll('.graphic-disc')].map((d) => d.textContent),
        when: el.querySelector('.graphic-when').textContent }
    })
    assert.deepEqual([facts.w, facts.h, facts.fits], [1080, 1350, true], 'canvas size or overflow')
    assert.ok(facts.facts.every((s) => s >= 36), `facts below 36px: ${facts.facts}`)
    assert.ok(facts.sponsors.length === 2 && facts.sponsors.every((s) => s >= 28), `Sponsor names below 28px: ${facts.sponsors}`)
    assert.ok(facts.made[0] >= 24 && facts.madeOpacity === '1' && facts.madeText === 'Made with Test Platform', `made with: ${facts.made} ${facts.madeOpacity} ${facts.madeText}`)
    assert.equal(facts.score[0], 270)
    assert.equal(facts.score_text, '3–2')
    assert.deepEqual(facts.goals, [['RTM Player 1 5′', '(og) 14′', 'RTM Player 2 31′'], ['RE8 Player 1 9′', 'Unknown 20′']])
    assert.deepEqual([facts.logo, facts.plates, facts.crests], [true, 2, ['RTM', 'RE8']])
    assert.match(facts.when, /13 Nov 2033\)\nTamghas Arena$/)

    // Download without the share sheet: the PNG is exactly 1080x1350, named for the Teams, and the caption is on the clipboard.
    const d = await download(p)
    assert.equal(d.name, 'RTM-v-RE8.png')
    if (process.env.GRAPHIC_SAVE) writeFileSync(process.env.GRAPHIC_SAVE, d.buf)
    assert.deepEqual(pngSize(d.buf), [1080, 1350])
    assert.ok(d.buf.length > 5000, 'the PNG is nearly empty')
    // Not blank: the field is brand-primary #f6c453 (navy ink reads on it) and the frame's secondary colour #f58220 is drawn 28px in.
    const px = await p.evaluate(async (b64) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = Object.assign(document.createElement('canvas'), { width: 1080, height: 1350 }).getContext('2d')
      c.drawImage(img, 0, 0)
      return [[10, 10], [40, 600], [540, 29]].map(([x, y]) => [...c.getImageData(x, y, 1, 1).data.slice(0, 3)])
    }, d.buf.toString('base64'))
    assert.deepEqual(px, [[246, 196, 83], [246, 196, 83], [245, 130, 32]], 'the PNG is not the Graphic')
    await status(p).filter({ hasText: 'Image saved. Caption copied.' }).waitFor()
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), caption)
    assert.ok(!caption.includes('Made with'), 'the caption has the platform name')
    assert.deepEqual(mock.writes, [], 'a Storage upload or an app write')
    await p.context().close()
  }

  // Readable text (Story 5.2): with gold #f6c453 / white and a sweep of hard brand and kit colours, every text layer passes, the "Made with" mark and
  // the date line included, and the stored colours are never written.
  for (const brand of COLOURS) {
    const { page: p, mock } = await open({ brand })
    await ready(p, 2)
    const layers = await audit(p)
    const names = layers.map((l) => l.cls)
    for (const c of ['graphic-made', 'graphic-when', 'graphic-score', 'graphic-pens', 'graphic-disc', 'graphic-team', 'graphic-round']) assert.ok(names.includes(c), `${brand.primary}: no ${c} layer`)
    const bad = layers.filter((l) => l.see || l.ratio < l.need)
    assert.deepEqual(bad, [], `${brand.primary}: unreadable text`)
    assert.deepEqual(mock.writes, [])
    assert.equal(mock.commands.length, 0, `${brand.primary}: a command was sent`)
    await p.context().close()
  }

  // Plain: no logo, no Sponsors, no venue: no strip, no gap, nothing about a venue in the Graphic or the caption.
  {
    const { page: p, mock } = await open({ variant: 'plain' })
    await ready(p, 1)
    const caption = await alt(p)
    assert.doesNotMatch(caption, /Sponsored|Tamghas Arena/)
    assert.match(caption, /\(13 Nov 2033\)\. $|\(13 Nov 2033\)\.$/)
    const f = await p.locator('.graphic-classic').evaluate((el) => ({ strip: el.querySelectorAll('.graphic-sponsors').length, logo: el.querySelectorAll('.graphic-logo').length,
      when: el.querySelector('.graphic-when').textContent, fits: el.scrollHeight <= el.clientHeight }))
    assert.deepEqual([f.strip, f.logo, f.fits], [0, 0, true])
    assert.match(f.when, /13 Nov 2033\)$/)
    assert.deepEqual(mock.writes, [])
    await p.context().close()
  }

  // Shootout: the penalties line on the Graphic and in the caption.
  {
    const { page: p } = await open()
    await ready(p, 2)
    assert.equal(await p.locator('.graphic-pens').textContent(), '4–3 on penalties')
    assert.match(await alt(p), /^Full time: Red Tigers 2, Eight Eagles 2\. Red Tigers win 4–3 on penalties\. Final, Gulmi Cup\. Goals: /)
    await p.context().close()
  }

  // Many goals for one side: as many as fit, then "+N more"; the caption keeps all twelve. A long Team and Tournament name wraps and clamps to two lines.
  {
    const { page: p } = await open()
    await ready(p, 3)
    const f = await p.locator('.graphic-classic').evaluate((el) => ({ items: [...el.querySelectorAll('.graphic-goals ul:first-child li')].map((li) => li.textContent), fits: el.scrollHeight <= el.clientHeight }))
    assert.ok(f.fits && f.items.length >= 3 && f.items.length < 13, `goal rows: ${f.items.length}`)
    assert.match(f.items.at(-1), /^\+\d+ more$/)
    assert.equal(Number(f.items.at(-1).match(/\d+/)[0]) + f.items.length - 1, 12, 'goals lost')
    assert.equal((await alt(p)).match(/RTM RTM Player/g).length, 12)
    await p.context().close()
    const { page: q } = await open({ long: true })
    await ready(q, 1)
    const l = await q.locator('.graphic-classic').evaluate((el) => ({ fits: el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth,
      teams: [...el.querySelectorAll('.graphic-team')].map((n) => [n.offsetHeight, n.scrollWidth <= n.clientWidth]), eyebrow: el.querySelector('.graphic-eyebrow span').offsetHeight }))
    assert.ok(l.fits, 'a long name overflows the canvas')
    assert.ok(l.teams.every(([h, w]) => h <= 2 * 40 * 1.05 + 2 && w), `team names: ${JSON.stringify(l.teams)}`)
    assert.ok(l.eyebrow <= 2 * 28 + 2, `eyebrow: ${l.eyebrow}`)
    await q.context().close()
  }

  // Share with file support: the share sheet gets the PNG and the caption, nothing is saved; cancelling shows nothing.
  {
    const { page: p, mock } = await open({ init: () => {
      window.__shared = []
      navigator.canShare = (d) => !!d.files?.length
      navigator.share = async (d) => { window.__shared.push({ names: d.files.map((f) => `${f.name}:${f.type}:${f.size}`), text: d.text }); if (window.__cancel) throw new DOMException('cancelled', 'AbortError') }
    } })
    await ready(p, 1)
    const caption = await alt(p)
    await button(p, 'Share this Graphic').click()
    await p.waitForFunction(() => window.__shared.length === 1)
    const s = await p.evaluate(() => window.__shared[0])
    assert.match(s.names[0], /^RTM-v-RE8\.png:image\/png:\d{4,}$/)
    assert.equal(s.text, caption)
    assert.equal(await status(p).innerText(), '', 'a notice after a successful share')
    await p.evaluate(() => { window.__cancel = true })
    await button(p, 'Share this Graphic').click()
    await p.waitForFunction(() => window.__shared.length === 2)
    assert.equal(await status(p).innerText(), '', 'a notice after cancelling')
    assert.equal(await p.getByText('Image saved', { exact: false }).count(), 0)
    assert.deepEqual(mock.writes, [])
    await p.context().close()
  }

  // No share sheet (a laptop) and a blocked clipboard: Share saves the PNG and shows the caption as text.
  {
    const { page: p } = await open({ init: () => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('blocked')) } }) } })
    await ready(p, 1)
    const caption = await alt(p)
    const [d] = await Promise.all([p.waitForEvent('download'), button(p, 'Share this Graphic').click()])
    assert.equal(d.suggestedFilename(), 'RTM-v-RE8.png')
    await status(p).filter({ hasText: 'Image saved. Copy the caption below.' }).waitFor()
    assert.equal(await p.locator('.graphic-caption').innerText(), caption)
    await p.context().close()
  }

  // Failure: the assertive message and a retry that works.
  {
    const { page: p } = await open({ init: () => { window.tslGraphicFail = true } })
    await p.goto(`${base}/t/${T}/m/${mid(1)}/pack`)
    const alert = p.locator('.graphic-card').first().getByRole('alert').filter({ hasText: "Couldn't make this Graphic. Try again." })
    await alert.waitFor({ timeout: 30000 })
    assert.equal(await button(p, 'Download this Graphic').count(), 0)
    await p.waitForFunction(() => document.querySelectorAll('.graphic-card [role="alert"]').length === 6, null, { timeout: 30000 })
    await p.evaluate(() => { window.tslGraphicFail = false })
    await button(p, 'Try making the graphic again').click()
    await button(p, 'Download this Graphic').waitFor({ timeout: 30000 })
    assert.equal(await alert.count(), 0)
    // A Player card retries on its own.
    await p.getByRole('button', { name: 'Try making the goal Graphic for RTM Player 1 5′ again', exact: true }).click()
    await button(p, 'Download the goal Graphic for RTM Player 1 5′').waitFor({ timeout: 30000 })
    await p.context().close()
  }

  // Player Graphics (Story 5.3): goals in minute order then the Awards; a cut-out only through the consent gate; own and unknown goals text-only; captions, file names, size.
  {
    const { page: p, mock } = await open()
    await p.goto(`${base}/t/${T}/m/${mid(4)}/pack`)
    await p.waitForFunction(() => [...document.querySelectorAll('.graphic-card button')].filter((b) => /^Download the /.test(b.textContent)).length === 6, null, { timeout: 60000 })
    const cards = await p.locator('.graphic-card').evaluateAll((cs) => cs.map((c) => ({ head: c.querySelector('h2').textContent, alt: c.querySelector('.graphic-thumb').getAttribute('aria-label') })))
    assert.deepEqual(cards.map((c) => c.head), ['Result Graphic', 'Goal Graphic for Roshan Adhikari 12′', 'Goal Graphic for Own goal (RE8) 20′', 'Goal Graphic for Goal (Eight Eagles) 27′',
      'Goal Graphic for RTM Player 2 33′', 'Man of the Match Graphic for Roshan Adhikari', 'Fair Player Graphic for Dilson Sunar'])
    const D = '\\w+ · \\w+ \\d+, 20\\d\\d BS \\(13 Nov 2033\\), Tamghas Arena\\.'
    const S4 = 'Red Tigers 3, Eight Eagles 1'
    assert.match(cards[1].alt, new RegExp(`^Goal: Roshan Adhikari \\(Red Tigers\\) 12′\\. ${S4}\\. Final, Gulmi Cup\\. ${D}$`))
    assert.match(cards[2].alt, new RegExp(`^Goal: Own goal \\(RE8\\) 20′\\. ${S4}\\. Final, Gulmi Cup\\. ${D}$`))
    assert.match(cards[3].alt, new RegExp(`^Goal: Goal \\(Eight Eagles\\) 27′\\. ${S4}\\. Final, Gulmi Cup\\. ${D}$`))
    assert.match(cards[4].alt, new RegExp(`^Goal: RTM Player 2 \\(Red Tigers\\) 33′\\. ${S4}\\. Final, Gulmi Cup\\. ${D}$`))
    assert.match(cards[5].alt, new RegExp(`^Man of the Match: Roshan Adhikari \\(Red Tigers\\)\\. ${S4}, Final, Gulmi Cup\\. ${D}$`))
    assert.match(cards[6].alt, new RegExp(`^Fair Player: Dilson Sunar \\(Eight Eagles\\)\\. ${S4}, Final, Gulmi Cup\\. ${D}$`))
    const roots = await p.locator('.graphic-player').evaluateAll((rs) => rs.map((el) => {
      const t = (sel) => el.querySelector(sel)?.textContent ?? null
      const bottom = (sel) => { const n = el.querySelector(sel); return n.offsetTop + n.offsetHeight }
      const cut = el.querySelector('.graphic-cutout')
      return { w: el.offsetWidth, h: el.offsetHeight, fits: el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth,
        word: t('.graphic-word'), wordFits: el.querySelector('.graphic-word').offsetWidth <= 1080, label: t('.graphic-tag'), minute: t('.graphic-minute'), name: t('.graphic-pname'), team: t('.graphic-pteam'),
        assist: t('.graphic-assist'), mini: t('.graphic-mini'), made: t('.graphic-made'), cut: cut ? { src: cut.src, ok: cut.complete && cut.naturalWidth > 0, bottom: cut.offsetTop + cut.offsetHeight, mask: getComputedStyle(cut).maskImage || getComputedStyle(cut).webkitMaskImage } : null,
        imgs: [...el.querySelectorAll('img')].map((i) => i.className || i.parentElement.className), svgs: el.querySelectorAll('svg').length, clear: el.querySelector('.graphic-info').offsetTop >= bottom('.graphic-round'),
        sponsorSizes: [...el.querySelectorAll('.graphic-plate span')].map((n) => parseFloat(getComputedStyle(n).fontSize)), madePx: parseFloat(getComputedStyle(el.querySelector('.graphic-made')).fontSize),
        text: el.innerText.toLowerCase() }
    }))
    for (const r of roots) {
      assert.deepEqual([r.w, r.h, r.fits, r.wordFits, r.clear], [1080, 1350, true, true, true], `canvas: ${JSON.stringify(r)}`)
      assert.ok(r.madePx >= 24 && r.made === 'Made with Test Platform' && r.sponsorSizes.every((x) => x >= 28))
      assert.ok(r.imgs.every((c) => /graphic-(logo|plate)|^$/.test(c) || c === 'graphic-cutout'), `an extra picture: ${r.imgs}`)
      assert.equal(r.svgs, 0)
      assert.doesNotMatch(r.text, /photo|consent|picture|image/, 'the card says something about a photo')
    }
    const [roshan, own, unknown, noConsent, mom, fair] = roots
    // Cut-out: the signed URL from the gate, bottom-anchored, shoulders faded.
    assert.deepEqual([roshan.word, roshan.label, roshan.minute, roshan.name, roshan.team, roshan.assist, roshan.mini], ['GOAL', 'Goal', '12′', 'Roshan Adhikari', 'Red Tigers', 'Assist: RTM Player 2', 'RTM 3–1 RE8'])
    assert.ok(roshan.cut.ok && roshan.cut.src.includes('/object/sign/player-photos/') && roshan.cut.bottom === 1350 && /linear-gradient/.test(roshan.cut.mask), `cut-out: ${JSON.stringify(roshan.cut)}`)
    assert.ok(mom.cut?.ok, 'Man of the Match without the cut-out')
    // Without a cut-out: same Template, nothing in its place.
    for (const r of [own, unknown, noConsent, fair]) assert.equal(r.cut, null)
    assert.deepEqual([own.name, own.team, own.minute, own.assist, own.word], ['Own goal (RE8)', null, '20′', null, 'GOAL'])
    assert.deepEqual([unknown.name, unknown.team, unknown.minute], ['Goal (Eight Eagles)', null, '27′'])
    assert.deepEqual([noConsent.name, noConsent.team, noConsent.word], ['RTM Player 2', 'Red Tigers', 'GOAL'])
    assert.deepEqual([mom.word, mom.label, mom.name, mom.team, mom.minute], ['ADHIKARI', 'Man of the Match', 'Roshan Adhikari', 'Red Tigers', null])
    assert.deepEqual([fair.word, fair.label, fair.name, fair.team], ['SUNAR', 'Fair Player', 'Dilson Sunar', 'Eight Eagles'])
    // The gate: one read of the consent view, short-lived signing of only the path it gave, nothing written.
    assert.ok(mock.views.length >= 1 && mock.signed.length >= 1)
    for (const b of mock.signed) assert.ok(b.expiresIn <= 900 && b.paths.every((x) => x === `${T}/roshan.webp`), `signing: ${JSON.stringify(b)}`)
    assert.deepEqual(mock.writes, [], 'a Storage upload or an app write')
    assert.equal(mock.commands.length, 0)
    // Download: PNG 1080x1350 with the file names; the caption is copied.
    for (const [name, file] of [['goal Graphic for Roshan Adhikari 12′', 'RTM-adhikari-12.png'], ['goal Graphic for Own goal (RE8) 20′', 'RTM-own-goal-20.png'], ['goal Graphic for Goal (Eight Eagles) 27′', 'RE8-goal-27.png'],
      ['Man of the Match Graphic for Roshan Adhikari', 'RTM-man-of-the-match.png'], ['Fair Player Graphic for Dilson Sunar', 'RE8-fair-player.png']]) {
      const [d] = await Promise.all([p.waitForEvent('download'), button(p, `Download the ${name}`).click()])
      assert.equal(d.suggestedFilename(), file)
      const buf = readFileSync(await d.path())
      if (process.env.GRAPHIC_SAVE) writeFileSync(`${process.env.GRAPHIC_SAVE}-${file}`, buf)
      assert.deepEqual(pngSize(buf), [1080, 1350])
      assert.ok(buf.length > 5000)
    }
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), cards[6].alt)
    assert.deepEqual(mock.writes, [])
    await p.context().close()
  }

  // Post-match pack (Story 5.4): every Graphic in pack order, cards and missed penalties on the Player Template, captions, the combined caption, Share all in both modes.
  {
    const { page: p, mock } = await open()
    await p.goto(`${base}/t/${T}/m/${mid(5)}/pack`)
    await p.getByRole('button', { name: 'Share all Graphics' }).waitFor()
    await p.waitForFunction(() => document.querySelectorAll('.graphic-card button').length >= 18 && !document.querySelector('.graphic-card [aria-busy="true"]'), null, { timeout: 90000 })
    const cards = await p.locator('.graphic-card').evaluateAll((cs) => cs.map((c) => ({ head: c.querySelector('h2').textContent, alt: c.querySelector('.graphic-thumb').getAttribute('aria-label'),
      word: c.querySelector('.graphic-word')?.textContent, tag: c.querySelector('.graphic-tag')?.textContent, name: c.querySelector('.graphic-pname')?.textContent, team: c.querySelector('.graphic-pteam')?.textContent ?? null })))
    assert.deepEqual(cards.map((c) => c.head), ['Result Graphic', 'Goal Graphic for RTM Player 2 4′', 'Goal Graphic for RE8 Player 1 17′', 'Yellow card Graphic for RTM Player 3 8′',
      'Red card Graphic for RE8 Player 2 22′', 'Yellow card Graphic for Yellow card (Eight Eagles) 30′', 'Missed penalty Graphic for Roshan Adhikari 25′'.replace('Roshan Adhikari', 'RTM Player 1'),
      'Man of the Match Graphic for RTM Player 2', 'Fair Player Graphic for RE8 Player 1'])
    const D = '\\w+ · \\w+ \\d+, 20\\d\\d BS \\(15 Nov 2033\\), Tamghas Arena\\.'
    assert.match(cards[3].alt, new RegExp(`^Yellow card: RTM Player 3 \\(Red Tigers\\) 8′\\. Red Tigers v Eight Eagles, Final, Gulmi Cup\\. ${D}$`))
    assert.match(cards[4].alt, new RegExp(`^Red card: RE8 Player 2 \\(Eight Eagles\\) 22′\\. Red Tigers v Eight Eagles, Final, Gulmi Cup\\. ${D}$`))
    assert.match(cards[5].alt, new RegExp(`^Yellow card: Yellow card \\(Eight Eagles\\) 30′\\. Red Tigers v Eight Eagles, Final, Gulmi Cup\\. ${D}$`))
    assert.match(cards[6].alt, new RegExp(`^Missed penalty: RTM Player 1 \\(Red Tigers\\) 25′\\. Red Tigers v Eight Eagles, Final, Gulmi Cup\\. ${D}$`))
    assert.deepEqual([cards[3].word, cards[3].tag, cards[4].tag, cards[6].word, cards[6].tag], ['CARD', 'Yellow card', 'Red card', 'MISSED', 'Missed penalty'])
    assert.deepEqual([cards[5].name, cards[5].team], ['Yellow card (Eight Eagles)', null], 'a card with no Player is text only')
    assert.equal(await p.locator('.graphic-cutout').count(), 0, 'a cut-out without consent')
    // Every kind has Graphics here, so no "why" line; the pack order is the page order.
    assert.equal(await p.getByText(/^No (goals|cards|missed|Man|Fair)/).count(), 0)
    assert.equal(await p.getByRole('button', { name: 'Share all Graphics' }).isEnabled(), true)
    // Share all with a share sheet: one share, nine PNGs, one combined caption; cancelling shows nothing.
    await p.evaluate(() => {
      window.__shared = []
      navigator.canShare = (d) => !!d.files?.length
      navigator.share = async (d) => { window.__shared.push({ names: d.files.map((f) => f.name), types: d.files.map((f) => f.type), text: d.text }); if (window.__cancel) throw new DOMException('cancelled', 'AbortError') }
    })
    await button(p, 'Share all Graphics').click()
    await p.waitForFunction(() => window.__shared.length === 1)
    const s = await p.evaluate(() => window.__shared[0])
    assert.equal(s.names.length, 9)
    assert.ok(s.types.every((t) => t === 'image/png'))
    assert.equal(s.names[0], 'RTM-v-RE8.png')
    assert.equal(s.text, cards.map((c) => c.alt).join('\n\n'))
    await p.evaluate(() => { window.__cancel = true })
    await button(p, 'Share all Graphics').click()
    await p.waitForFunction(() => window.__shared.length === 2)
    assert.equal(await p.locator('main > .home-panel > [role="status"], .home-panel > [role="status"]').first().innerText(), '')
    assert.equal(await p.getByText('Images saved', { exact: false }).count(), 0)
    // No multi-share (a laptop): nine downloads, the combined caption copied.
    await p.evaluate(() => { navigator.canShare = undefined })
    const dl = []
    p.on('download', (d) => dl.push(d.suggestedFilename()))
    await button(p, 'Share all Graphics').click()
    await p.getByText('Images saved. Caption copied.').waitFor()
    for (let i = 0; i < 40 && dl.length < 9; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(new Set(dl).size, 9, `downloads: ${dl}`)
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), s.text)
    assert.deepEqual(mock.writes, [], 'a Storage upload or an app write')
    assert.equal(mock.commands.length, 0)
    await p.context().close()
  }

  // Pack: clipboard blocked -> the combined caption as selectable text.
  {
    const { page: p } = await open({ init: () => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('blocked')) } }) } })
    await p.goto(`${base}/t/${T}/m/${mid(1)}/pack`)
    await p.waitForFunction(() => document.querySelectorAll('.graphic-card button').length >= 12, null, { timeout: 90000 })
    await button(p, 'Share all Graphics').click()
    await p.getByText('Images saved. Copy the caption below.').waitFor()
    assert.equal((await p.locator('.home-panel > .graphic-caption').innerText()).split('\n\n').length, 6)
    await p.context().close()
  }

  // Empty kinds: the Result card and five "why" lines, in pack order.
  {
    const { page: p } = await open()
    await p.goto(`${base}/t/${T}/m/${mid(6)}/pack`)
    await button(p, 'Download this Graphic').waitFor({ timeout: 30000 })
    assert.equal(await p.locator('.graphic-card').count(), 1)
    assert.deepEqual(await p.locator('.home-panel > p.meta').allInnerTexts().then((t) => t.filter((x) => x.startsWith('No '))),
      ['No goals in this Match', 'No cards in this Match', 'No missed penalties', 'No Man of the Match chosen', 'No Fair Player chosen'])
    await p.context().close()
  }

  // One card fails: its own assertive message and retry, the cards after it still get made, Share all waits until the retry works.
  {
    const { page: p } = await open({ init: () => { window.__n = 0 } })
    await p.addInitScript(() => { Object.defineProperty(window, 'tslGraphicFail', { configurable: true, get() { window.__n = (window.__n ?? 0) + 1; return window.__n === 3 && !window.__fixed } , set() {} }) })
    await p.goto(`${base}/t/${T}/m/${mid(1)}/pack`)
    await p.locator('.graphic-card [role="alert"]').waitFor({ timeout: 60000 })
    await p.waitForFunction(() => [...document.querySelectorAll('.graphic-card button')].filter((b) => /^Download /.test(b.textContent)).length === 5, null, { timeout: 60000 })
    assert.equal(await p.locator('.graphic-card [role="alert"]').count(), 1)
    assert.equal(await button(p, 'Share all Graphics').isDisabled(), true)
    await p.evaluate(() => { window.__fixed = true })
    await p.getByRole('button', { name: /^Try making the .* again$/ }).click()
    await p.waitForFunction(() => !document.querySelector('.graphic-card [role="alert"]') && document.querySelectorAll('.graphic-card button').length >= 12, null, { timeout: 60000 })
    await p.waitForFunction(() => !document.querySelector('.ui-primary:disabled'), null, { timeout: 30000 })
    await p.context().close()
  }

  // Order and freshness: PNGs are made one at a time, result first; a deleted goal is gone when the pack is opened again (nothing cached).
  {
    const { page: p } = await open()
    await p.goto(`${base}/t/${T}/m/${mid(1)}/pack`)
    await button(p, 'Download this Graphic').waitFor({ timeout: 30000 })
    await p.waitForFunction(() => document.querySelectorAll('.graphic-card button').length >= 12, null, { timeout: 90000 })
    assert.equal(await p.locator('.graphic-card').count(), 6)
    const saved = events[mid(1)].splice(0, 1)
    await p.goto(`${base}/t/${T}/m/${mid(1)}/pack`)
    await p.waitForFunction(() => document.querySelectorAll('.graphic-card h2').length === 5, null, { timeout: 30000 })
    events[mid(1)].unshift(...saved)
    await p.context().close()
  }

  // Entry points: the finished Match card and the Match page link to the pack; the Graphics tab lists finished Matches, newest first.
  {
    const { page: p } = await open()
    await p.goto(`${base}/t/${T}/m/${mid(4)}`)
    const link = p.getByRole('link', { name: 'Open the post-match pack' })
    await link.waitFor()
    assert.equal(await p.locator('.graphic-card').count(), 0)
    await link.click()
    await p.waitForURL(`**/t/${T}/m/${mid(4)}/pack`)
    await p.context().close()
  }

  // Unset Awards leave no card: a Match without Man of the Match or Fair Player has only the goals (here 5 and the Result card).
  {
    const { page: p } = await open()
    await p.goto(`${base}/t/${T}/m/${mid(1)}/pack`)
    await p.waitForFunction(() => [...document.querySelectorAll('.graphic-card button')].filter((b) => /^Download the /.test(b.textContent)).length === 5, null, { timeout: 60000 })
    assert.equal(await p.locator('.graphic-card').count(), 6)
    assert.equal(await p.locator('.graphic-card').getByText(/Man of the Match|Fair Player/).count(), 0)
    await p.context().close()
  }

  // Contrast: gold and white and the hard sweep; every Player text layer, the word and "Made with" included, on at least a 95% opaque fill read as its worst blend.
  for (const brand of COLOURS) {
    const { page: p, mock } = await open({ brand })
    await p.goto(`${base}/t/${T}/m/${mid(4)}/pack`)
    await p.waitForFunction(() => [...document.querySelectorAll('.graphic-card button')].filter((b) => /^Download the /.test(b.textContent)).length === 6, null, { timeout: 60000 })
    const layers = await audit(p, '.graphic-player')
    const names = new Set(layers.map((l) => l.cls))
    for (const c of ['graphic-word', 'graphic-tag', 'graphic-minute', 'graphic-pname', 'graphic-pteam', 'graphic-assist', 'graphic-mini', 'graphic-when', 'graphic-made', 'graphic-round']) assert.ok(names.has(c), `${brand.primary}: no ${c} layer`)
    assert.deepEqual(layers.filter((l) => l.see || l.ratio < l.need), [], `${brand.primary}: unreadable Player text`)
    assert.deepEqual(mock.writes, [])
    await p.context().close()
  }

  // The gate is the only reader of photos: no Graphic source file (cards, Templates, graphics data) names a photo column, the consent table, the view or the bucket.
  {
    const dir = 'src/features/graphics'
    const files = [...readdirSync(dir, { recursive: true }).filter((f) => /\.tsx?$/.test(f)).map((f) => `${dir}/${f}`), 'src/domain/graphics.ts']
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /photo_path|photo_consent|player_photo_public|player-photos|photoBucket|photoPath|\.storage\b|createSignedUrl|registration'/i, `${f} reads photos outside the gate`)
    const gate = readFileSync('src/domain/playerPhotos.ts', 'utf8')
    assert.ok(/player_photo_public/.test(gate) && /createSignedUrls/.test(gate))
    assert.ok(files.some((f) => /Player\.tsx$/.test(f)))
  }

  // Story 5.5, the Graphics tab: Official Draw, Fixtures (a card per day, parts over 8), Results (latest first, shootout), group tables in the server's order, the League's one
  // table, the "Available once..." cards, the entry link, layout at three widths, and nothing uploaded or written.
  {
    const T4 = [...TEAMS, { id: tid(3), name: 'Blue Bats', code: 'BLU', kit: '#00aaff' }, { id: tid(4), name: 'Green Ghosts', code: 'GRN', kit: '#00aa00' }]
    const slots = [[1, 1, 1], [1, 2, 2], [2, 1, 3], [2, 2, 4]].map(([grp, pos, t]) => ({ id: `99999999-0000-4000-8000-00000000000${t}`, grp, pos, team_id: tid(t) }))
    const row = (n, t, home, away, stage, round, kick_off, status, extra = {}) => ({ id: mid(n), stage, round, label: null, ord: n, home_team_id: tid(home), away_team_id: tid(away), home_src: null, away_src: null,
      kick_off, status, version: 1, hg: null, ag: null, home_pens: null, away_pens: null, ...extra })
    const lm = [
      ...Array.from({ length: 10 }, (_, i) => row(10 + i, 0, 1, 2, 'group', 'Group A', `2033-11-13T${String(8 + i).padStart(2, '0')}:00:00+05:45`, 'scheduled')),
      row(30, 0, 3, 4, 'group', 'Group B', '2033-11-12T09:00:00+05:45', 'scheduled'),
      row(31, 0, 3, 4, 'group', 'Group B', null, 'scheduled'),
      row(40, 0, 1, 2, 'group', 'Group A', '2033-11-10T10:00:00+05:45', 'finished', { hg: 3, ag: 2 }),
      row(41, 0, 3, 4, 'knockout', 'Final', '2033-11-11T10:00:00+05:45', 'finished', { hg: 2, ag: 2, home_pens: 4, away_pens: 3 }),
      row(42, 0, 1, 2, 'group', 'Group A', '2033-11-11T12:00:00+05:45', 'finished', { hg: 1, ag: 0 }),
    ]
    const st = (grp, pos, t, p, w, d, l, gd, pts) => ({ grp, pos, team_id: tid(t), p, w, d, l, gf: 0, ga: 0, gd, pts, group_done: false, provisional: false, shootout_with: null })
    const rows = [st(1, 1, 1, 2, 2, 0, 0, 2, 6), st(1, 2, 2, 2, 0, 0, 2, -2, 0), st(2, 1, 4, 1, 0, 1, 0, 0, 1), st(2, 2, 3, 1, 0, 1, 0, 0, 1)]
    const list = { teams: T4, slots, matches: lm, rows, published: true }
    const { page: p, mock } = await open({ list })
    await p.goto(`${base}/t/${T}`)
    await p.getByRole('tab', { name: 'Graphics' }).click()
    await p.waitForFunction(() => [...document.querySelectorAll('.graphics-grid .graphic-card button')].filter((b) => /^Download the /.test(b.textContent)).length === 10, null, { timeout: 90000 })
    const heads = await p.locator('.graphics-grid .graphic-card h2').allTextContents()
    assert.equal(heads.length, 11)
    const want = [/^Official Draw Graphic$/, /^Fixtures Graphic for .*12 Nov 2033\)$/, /^Fixtures Graphic for .*13 Nov 2033\), Part 1 of 2$/, /^Fixtures Graphic for .*13 Nov 2033\), Part 2 of 2$/,
      /^Results Graphic for .*11 Nov 2033\)$/, /^Results Graphic for .*10 Nov 2033\)$/, /^Group A table Graphic$/, /^Group B table Graphic$/, /^Top scorers Graphic$/, /^Bracket Graphic$/, /^Champions Graphic$/]
    want.forEach((re, i) => assert.match(heads[i], re, `card ${i}: ${heads[i]}`))
    const alts = await p.locator('.graphics-grid .graphic-thumb').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    assert.match(alts[0], /^Official draw, Gulmi Cup Season 2\. Group A: Red Tigers, Eight Eagles\. Group B: Blue Bats, Green Ghosts\. \w+ · .*\d{4}.*\)\.$/)
    assert.match(alts[1], /^Fixtures, Gulmi Cup, .*\(12 Nov 2033\): 09:00 BLU v GRN \(Group B\)\. Latest Venue\.$/)
    assert.match(alts[2], /\(13 Nov 2033\), Part 1 of 2: 08:00 RTM v RE8 \(Group A\); 09:00 RTM v RE8 \(Group A\);/)
    assert.equal(alts[2].split('; ').length, 8)
    assert.equal(alts[3].split('; ').length, 2)
    assert.ok(alts[1].indexOf('09:00') > 0 && !alts.slice(1, 4).join().includes('GRN v BLU'), 'a Match without a kick-off or in the wrong place')
    assert.match(alts[4], /^Results, Gulmi Cup, .*\(11 Nov 2033\): 10:00 BLU 2–2 GRN \(4–3 pens\) \(Final\); 12:00 RTM 1–0 RE8 \(Group A\)\. Latest Venue\.$/)
    assert.match(alts[5], /: 10:00 RTM 3–2 RE8 \(Group A\)\./)
    assert.equal(alts[6], 'Group A table after match day 2: 1 Red Tigers 6 pts (2, 2, 0, 0, +2); 2 Eight Eagles 0 pts (2, 0, 0, 2, -2).')
    // Level on points: the server's order (GRN first although BLU sorts first), and no Match finished in the group means day 0.
    assert.equal(alts[7], 'Group B table after match day 0: 1 Green Ghosts 1 pts (1, 0, 1, 0, 0); 2 Blue Bats 1 pts (1, 0, 1, 0, 0).')
    const g = await p.locator('.graphic-list').evaluateAll((els) => els.map((el) => ({ fits: el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth, size: [el.offsetWidth, el.offsetHeight],
      text: el.innerText, facts: [...el.querySelectorAll('.graphic-line, .graphic-foot')].map((n) => parseFloat(getComputedStyle(n).fontSize)), dots: el.querySelectorAll('.graphic-dot').length,
      made: el.querySelector('.graphic-made').textContent, sub: el.querySelector('.graphic-sub').textContent })))
    g.forEach((x, i) => { assert.deepEqual([x.fits, x.size], [true, [1080, 1350]], `list ${i} overflows`); assert.ok(x.facts.every((f) => f >= 36), `list ${i} facts: ${x.facts}`); assert.equal(x.made, 'Made with Test Platform') })
    assert.equal(g[0].dots, 4)
    assert.match(g[0].text, /GROUP A\s+RTM\s*Red Tigers/i)
    assert.match(g[4].text, /BLU\s*2–2 \(4–3 pens\)\s*GRN/)
    assert.match(g[6].text, /Level on points: Head-to-head points, Head-to-head goal difference, Shootout between the tied Teams, Overall goal difference, Goals scored/)
    assert.ok(g[7].text.indexOf('GRN') < g[7].text.indexOf('BLU'), 'the server order was changed')
    assert.equal(g[6].sub, 'After match day 2')
    assert.equal(g[7].sub, 'After match day 0')
    assert.deepEqual((await audit(p, '.graphic-list')).filter((l) => l.see || l.ratio < l.need), [], 'unreadable list text')
    // The Draw, Fixtures and table cards come before the Post-match packs.
    assert.ok(await p.locator('.graphics-grid').first().evaluate((el) => el.nextElementSibling.textContent === 'Season awards'))
    assert.equal(await p.locator('.graphics-grid').last().evaluate((el) => el.nextElementSibling.textContent), 'Post-match packs')
    // Download: a PNG of exactly 1080x1350, named for the Graphic.
    const [d] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Download the Official Draw Graphic', exact: true }).click()])
    assert.equal(d.suggestedFilename(), 'official-draw.png')
    assert.deepEqual(pngSize(readFileSync(await d.path())), [1080, 1350])
    // A Fixture moved to another day shows on that day's card the next time the card renders.
    lm.find((m) => m.id === mid(10)).kick_off = '2033-11-12T15:00:00+05:45'
    await p.reload()
    await p.waitForFunction(() => [...document.querySelectorAll('.graphics-grid .graphic-card button')].filter((b) => /^Download the /.test(b.textContent)).length === 10, null, { timeout: 90000 })
    const moved = await p.locator('.graphics-grid .graphic-thumb').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    assert.match(moved[1], /09:00 BLU v GRN \(Group B\); 15:00 RTM v RE8 \(Group A\)\./)
    assert.equal(moved[2].split('; ').length, 8)
    assert.equal(moved[2].includes('08:00'), false)
    // Layout: one column at 390px, two at 768px, content at most 960px at 1280px.
    const cols = async () => p.locator('.graphics-grid').first().evaluate((el) => ({ cols: getComputedStyle(el).gridTemplateColumns.split(' ').length, home: document.querySelector('.home').offsetWidth }))
    assert.equal((await cols()).cols, 1)
    await p.setViewportSize({ width: 768, height: 1000 })
    assert.equal((await cols()).cols, 2)
    await p.setViewportSize({ width: 1280, height: 1000 })
    assert.ok((await cols()).home <= 960 + 2, 'content wider than 960px')
    assert.deepEqual(mock.writes, [], 'a Storage upload or an app write')
    assert.equal(mock.commands.length, 0, 'a command was sent')
    await p.context().close()
  }

  // The Draw board's "Draw complete" links to the Graphics tab.
  {
    const slots = [[1, 1, 1], [1, 2, 2], [2, 1, 3], [2, 2, 4]].map(([grp, pos, t]) => ({ id: `99999999-0000-4000-8000-00000000000${t}`, grp, pos, team_id: tid(t) }))
    const T4 = [...TEAMS, { id: tid(3), name: 'Blue Bats', code: 'BLU', kit: '#00aaff' }, { id: tid(4), name: 'Green Ghosts', code: 'GRN', kit: '#00aa00' }]
    const { page: p } = await open({ list: { teams: T4, slots, matches: [], rows: [], published: false } })
    await p.goto(`${base}/t/${T}`)
    await p.getByRole('button', { name: 'Open the draw Graphic', exact: true }).click()
    assert.equal(await p.getByRole('tab', { name: 'Graphics' }).getAttribute('aria-selected'), 'true')
    await p.locator('.graphics-grid .graphic-card h2', { hasText: 'Official Draw Graphic' }).waitFor()
    await p.getByText('Available once a goal is scored').first().waitFor()
    // Nothing is placed yet: the cards say what they need.
    const needs = await p.locator('.graphics-grid .graphic-card .meta').allTextContents()
    assert.deepEqual(needs.filter((t) => t.startsWith('Available')), ['Available once fixtures are published', 'Available once a Match is finished', 'Available once fixtures are published', 'Available once a goal is scored', 'Available once fixtures are published'])
    await p.context().close()
    const q = await open({ list: { teams: T4, slots: [], matches: [], rows: [], published: false } })
    await q.page.goto(`${base}/t/${T}`)
    await q.page.getByRole('tab', { name: 'Graphics' }).click()
    await q.page.getByText('Available once the Draw is complete').waitFor()
    assert.equal(await q.page.getByText('Available once a Match is finished').count(), 1)
    await q.page.context().close()
  }

  // League: one league table card and no Draw or group cards.
  {
    const T4 = [...TEAMS]
    const lm = [{ id: mid(50), stage: 'league', round: 'League', label: null, ord: 1, home_team_id: tid(1), away_team_id: tid(2), home_src: null, away_src: null, kick_off: '2033-11-10T10:00:00+05:45',
      status: 'finished', version: 1, hg: 2, ag: 1, home_pens: null, away_pens: null }]
    const rows = [{ grp: 0, pos: 1, team_id: tid(1), p: 1, w: 1, d: 0, l: 0, gf: 2, ga: 1, gd: 1, pts: 3, group_done: false, provisional: false, shootout_with: null },
      { grp: 0, pos: 2, team_id: tid(2), p: 1, w: 0, d: 0, l: 1, gf: 1, ga: 2, gd: -1, pts: 0, group_done: false, provisional: false, shootout_with: null }]
    const { page: p, mock } = await open({ list: { structure: 'league', teams: T4, slots: [], matches: lm, rows, published: true } })
    await p.goto(`${base}/t/${T}`)
    await p.getByRole('tab', { name: 'Graphics' }).click()
    await p.waitForFunction(() => [...document.querySelectorAll('.graphics-grid .graphic-card button')].filter((b) => /^Download the /.test(b.textContent)).length === 3, null, { timeout: 60000 })
    const heads = await p.locator('.graphics-grid .graphic-card h2').allTextContents()
    assert.equal(heads.length, 5)
    assert.equal(heads[0], 'Fixtures Graphics')
    assert.equal(await p.getByText('No Matches left to play').count(), 1)
    assert.match(heads[1], /^Results Graphic for /)
    assert.equal(heads[2], 'League table Graphic')
    assert.deepEqual(heads.slice(3), ['Top scorers Graphic', 'Champions Graphic'])
    assert.equal(await p.getByText('Official Draw').count(), 0)
    // Champions: every league Match is finished, so the table leader.
    assert.equal(await p.locator('.graphics-grid .graphic-thumb').last().getAttribute('aria-label'), 'Champions, Gulmi Cup Season 2: Red Tigers.')
    assert.equal(await p.locator('.graphics-grid .graphic-thumb').nth(1).getAttribute('aria-label'), 'League table after match day 1: 1 Red Tigers 3 pts (1, 1, 0, 0, +1); 2 Eight Eagles 0 pts (1, 0, 0, 1, -1).')
    assert.deepEqual(mock.writes, [])
    await p.context().close()
  }

  // Story 5.6: top scorers (12 scorers, a 3-way tie, top 10), the bracket (source labels, a Team advanced on pens), the Season awards (set, change behind a Confirm sheet, cut-out only
  // for a consented Player, a tied Top Scorer text-only), champions (unplayed, played, League), nothing uploaded or written.
  {
    const T4 = [...TEAMS, { id: tid(3), name: 'Blue Bats', code: 'BLU', kit: '#00aaff' }, { id: tid(4), name: 'Green Ghosts', code: 'GRN', kit: '#00aa00' }]
    const sq = [0, 1].flatMap((i) => squad(i).map((x) => ({ team_id: tid(i + 1), shirt_number: x.shirt, player: { id: x.player_id, name: x.name } })))
    const sc = (t, n, goals) => ({ player_id: pid(t, n), team_id: tid(t), goals })
    const km = (n, round, label, home, away, hsrc, asrc, status, extra = {}) => ({ id: mid(n), stage: 'knockout', round, label, ord: n, home_team_id: home, away_team_id: away, home_src: hsrc, away_src: asrc,
      kick_off: null, status, version: 1, hg: null, ag: null, home_pens: null, away_pens: null, ...extra })
    const sd = (n, h, a) => ({ match_id: mid(n), home_team_id: h, away_team_id: a, home_src: null, away_src: null, home_resolved: h, away_resolved: a })
    const done = (p, n) => p.waitForFunction((k) => [...document.querySelectorAll('.graphics-grid .graphic-card button')].filter((b) => /^Download the /.test(b.textContent)).length === k, n, { timeout: 90000 })
    const thumbs = (p) => p.locator('.graphics-grid .graphic-thumb').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    const lists = (p) => p.locator('.graphic-list').evaluateAll((els) => els.map((el) => ({ fits: el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth
      && [...el.querySelectorAll('.graphic-listbody, .graphic-bracket, .graphic-ties')].every((n) => n.scrollHeight <= n.clientHeight + 1), size: [el.offsetWidth, el.offsetHeight],
      facts: [...el.querySelectorAll('.graphic-line')].map((n) => parseFloat(getComputedStyle(n).fontSize)), dots: el.querySelectorAll('.graphic-dot').length,
      ranks: [...el.querySelectorAll('.graphic-rank')].map((n) => Number(n.textContent)), names: [...el.querySelectorAll('.graphic-sname')].map((n) => n.textContent),
      titles: [...el.querySelectorAll('.graphic-bracket .graphic-gtitle')].map((t) => t.textContent),
      slots: [...el.querySelectorAll('.graphic-tie .graphic-line')].map((n) => [...n.children].map((c) => c.textContent).join('|')),
      crest: el.querySelector('.graphic-champdisc') && { text: el.querySelector('.graphic-champdisc').textContent, bg: getComputedStyle(el.querySelector('.graphic-champdisc')).backgroundColor,
        name: el.querySelector('.graphic-cname').textContent, score: el.querySelector('.graphic-cscore')?.textContent ?? null } })))
    const scorers = [sc(1, 1, 5), sc(2, 1, 3), sc(1, 9, 3), sc(1, 2, 3), sc(1, 3, 2), sc(2, 2, 2), sc(2, 3, 1), sc(1, 4, 1), sc(1, 5, 1), sc(2, 4, 1), sc(2, 5, 1), sc(2, 6, 1)]
    const ko = [km(60, 'QF', 'QF1', tid(1), tid(2), null, null, 'finished', { hg: 1, ag: 1, home_pens: 5, away_pens: 4 }), km(61, 'QF', 'QF2', tid(3), tid(4), null, null, 'scheduled'),
      km(62, 'SF', 'SF1', null, null, 'Winner QF1', 'Winner QF2', 'scheduled'), km(63, 'Final', 'Final', null, null, 'Winner SF1', 'Winner SF2', 'scheduled')]
    // QF1 went to a shootout: the server's resolution puts RTM in SF1's home slot.
    const sides = [sd(60, tid(1), tid(2)), sd(61, tid(3), tid(4)), sd(62, tid(1), null), sd(63, null, null)]
    const awards = []
    const { page: p, mock } = await open({ list: { teams: T4, slots: [], matches: ko, rows: [], published: true, scorers, squad: sq, awards, sides } })
    await p.goto(`${base}/t/${T}`)
    await p.getByRole('tab', { name: 'Graphics' }).click()
    await done(p, 3)
    const alts = await thumbs(p)
    assert.equal(alts[0], 'Top scorers, Gulmi Cup Season 2: 1 RTM Player 1 (RTM) 5; 2 RE8 Player 1 (RE8) 3; 2 Roshan Adhikari (RTM) 3; 2 RTM Player 2 (RTM) 3; 5 RE8 Player 2 (RE8) 2; 5 RTM Player 3 (RTM) 2; '
      + '7 RE8 Player 3 (RE8) 1; 7 RE8 Player 4 (RE8) 1; 7 RE8 Player 5 (RE8) 1; 7 RE8 Player 6 (RE8) 1.')
    assert.equal(alts[1], 'Road to the final, Gulmi Cup Season 2: QF: RTM 1–1 (5–4 pens) RE8; QF: BLU v GRN; SF: RTM v Winner QF2; Final: Winner SF1 v Winner SF2.')
    assert.equal(alts[2], 'Top Scorer, Gulmi Cup Season 2: RTM Player 1 (Red Tigers), 5 goals.')
    const [top, br] = await lists(p)
    for (const x of [top, br]) {
      assert.deepEqual([x.fits, x.size], [true, [1080, 1350]], 'a list Graphic overflows')
      assert.ok(x.facts.every((f) => f >= 36), `facts: ${x.facts}`)
    }
    // 12 scorers: the top 10, ties sharing a rank and listed by name, the 12th and 11th left off.
    assert.deepEqual(top.ranks, [1, 2, 2, 2, 5, 5, 7, 7, 7, 7])
    assert.equal(top.dots, 10)
    assert.deepEqual(top.names.slice(0, 4), ['RTM Player 1', 'RE8 Player 1', 'Roshan Adhikari', 'RTM Player 2'])
    // The bracket: a column per round in order, source labels where no Team is known, the shootout in the score, and the winner of QF1 in SF1 from the server.
    assert.deepEqual(br.titles, ['QF', 'SF', 'Final'])
    assert.deepEqual(br.slots, ['RTM|1 (5)', 'RE8|1 (4)', 'BLU|', 'GRN|', 'RTM|', 'Winner QF2|', 'Winner SF1|', 'Winner SF2|'])
    assert.deepEqual((await audit(p, '.graphic-list')).filter((l) => l.see || l.ratio < l.need), [], 'unreadable list text')
    assert.equal(await p.getByText('Available once the final is played').count(), 1)
    // Season awards: the Top Scorer is derived; the other two are picked.
    await p.getByText('Top Scorer: RTM Player 1 (RTM), 5 goals').waitFor()
    assert.equal(await p.getByText('Not chosen yet').count(), 2)
    assert.equal(await p.locator('.graphic-player .graphic-cutout').count(), 0, 'a cut-out for an unconsented Player')
    const pickAward = async (name, who) => {
      await button(p, `Pick ${name}`).or(button(p, `Change ${name}`)).click()
      await p.getByRole('dialog').getByRole('heading', { name: `Who is the ${name}?` }).waitFor()
      if (name === 'Best Goalkeeper' && who === 'Dilson Sunar') assert.deepEqual(await p.getByRole('dialog').getByRole('heading', { level: 3 }).allTextContents(), ['Red Tigers', 'Eight Eagles'])
      await p.getByRole('dialog').getByRole('button', { name: new RegExp(`^${who}`) }).click()
    }
    const sent = async (n) => { for (let i = 0; i < 50 && mock.commands.filter((c) => c.cmd === 'set_season_award').length < n; i++) await new Promise((r) => setTimeout(r, 100)); return mock.commands.filter((c) => c.cmd === 'set_season_award') }
    await pickAward('Best Goalkeeper', 'Dilson Sunar')
    let cmds = await sent(1)
    assert.deepEqual([cmds[0].season_id, cmds[0].award, cmds[0].player_id, cmds[0].expected_version], ['22222222-0000-4000-8000-000000000010', 'best_goalkeeper', pid(2, 9), undefined], 'a first pick carries a version')
    await p.locator('.graphics-grid .graphic-card h2', { hasText: 'Best Goalkeeper Graphic for Dilson Sunar' }).waitFor()
    await pickAward('Player of the Tournament', 'Roshan Adhikari')
    await sent(2)
    await button(p, 'Download the Player of the Tournament Graphic for Roshan Adhikari').waitFor({ timeout: 60000 })
    const card = (t) => p.locator('.graphic-card', { has: p.locator('h2', { hasText: t }) })
    assert.equal(await card('Best Goalkeeper Graphic').locator('.graphic-cutout').count(), 0, 'a cut-out without consent')
    assert.match(await card('Player of the Tournament Graphic').locator('.graphic-cutout').getAttribute('src'), /roshan\.webp/)
    const all = await thumbs(p)
    assert.ok(all.includes('Best Goalkeeper, Gulmi Cup Season 2: Dilson Sunar (Eight Eagles).'))
    assert.ok(all.includes('Player of the Tournament, Gulmi Cup Season 2: Roshan Adhikari (Red Tigers).'))
    // Changing a set award asks first, old then new; Cancel changes nothing, Confirm sends the change at the version read.
    await pickAward('Player of the Tournament', 'Dilson Sunar')
    const dlg = p.getByRole('dialog')
    assert.match(await dlg.locator('.ui-sheet-change').textContent(), /Roshan Adhikari.*Dilson Sunar/s)
    await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
    await p.waitForFunction(() => !document.querySelector('dialog[open]'))
    assert.equal((await sent(2)).length, 2, 'Cancel sent a change')
    await pickAward('Player of the Tournament', 'Dilson Sunar')
    await dlg.getByRole('button', { name: 'Change Player of the Tournament', exact: true }).click()
    cmds = await sent(3)
    assert.deepEqual([cmds[2].award, cmds[2].player_id, cmds[2].expected_version], ['player_of_tournament', pid(2, 9), 1])
    await p.locator('.graphic-card h2', { hasText: 'Player of the Tournament Graphic for Dilson Sunar' }).waitFor()
    assert.equal(mock.commands.filter((c) => c.cmd === 'set_season_award').length, 3)
    assert.deepEqual(mock.writes, [], 'a Storage upload or an app write')
    await p.context().close()

    // A tied Top Scorer is one text-only Graphic naming both; the final is played, so champions show the winner and the score.
    const final = [km(70, 'Final', 'Final', tid(1), tid(2), null, null, 'finished', { hg: 1, ag: 1, home_pens: 3, away_pens: 4 })]
    const two = await open({ list: { teams: T4, slots: [], matches: final, rows: [], published: true, scorers: [sc(1, 9, 3), sc(2, 1, 3)], squad: sq, awards: [], sides: [sd(70, tid(1), tid(2))] } })
    await two.page.goto(`${base}/t/${T}`)
    await two.page.getByRole('tab', { name: 'Graphics' }).click()
    await done(two.page, 4)
    const t2 = await thumbs(two.page)
    assert.equal(t2[1], 'Road to the final, Gulmi Cup Season 2: Final: RTM 1–1 (3–4 pens) RE8.')
    assert.equal(t2[2], 'Champions, Gulmi Cup Season 2: Eight Eagles.')
    assert.equal(t2[3], 'Top Scorer, Gulmi Cup Season 2: RE8 Player 1 (Eight Eagles) and Roshan Adhikari (Red Tigers), 3 goals.')
    assert.match(t2[0], /1 RE8 Player 1 \(RE8\) 3; 1 Roshan Adhikari \(RTM\) 3\.$/)
    const ch = (await lists(two.page)).find((x) => x.crest)
    assert.deepEqual([ch.fits, ch.crest], [true, { text: 'RE8', bg: 'rgb(0, 0, 255)', name: 'Eight Eagles', score: '1–1 (3–4 pens)' }])
    assert.equal(await two.page.locator('.graphic-player .graphic-cutout').count(), 0, 'a tie is text-only')
    assert.equal(await two.page.locator('.graphic-player .graphic-word').textContent(), 'TIED')
    assert.deepEqual([two.mock.views.length, two.mock.signed.length, two.mock.writes.length], [0, 0, 0], 'photos read or something written for a tie')
    assert.deepEqual((await audit(two.page, '.graphic-list')).filter((l) => l.see || l.ratio < l.need), [], 'unreadable champions text')
    await two.page.context().close()

    // A full bracket (round of 16 to the final) still fits the canvas at fact size.
    const full = [...Array.from({ length: 8 }, (_, i) => km(100 + i, 'R16', `R16-${i + 1}`, tid(1), tid(2), null, null, 'finished', { hg: 2, ag: 1 })),
      ...Array.from({ length: 4 }, (_, i) => km(110 + i, 'QF', `QF${i + 1}`, null, null, `Winner R16-${2 * i + 1}`, `Winner R16-${2 * i + 2}`, 'scheduled')),
      km(120, 'SF', 'SF1', null, null, 'Winner QF1', 'Winner QF2', 'scheduled'), km(121, 'SF', 'SF2', null, null, 'Winner QF3', 'Winner QF4', 'scheduled'),
      km(122, 'Final', 'Final', null, null, 'Winner SF1', 'Winner SF2', 'scheduled')]
    const four = await open({ list: { teams: T4, slots: [], matches: full, rows: [], published: true, scorers: [], squad: sq, awards: [], sides: full.map((m) => sd(Number(m.id.slice(-3)), m.home_team_id, m.away_team_id)) } })
    await four.page.goto(`${base}/t/${T}`)
    await four.page.getByRole('tab', { name: 'Graphics' }).click()
    await done(four.page, 1)
    const fb = (await lists(four.page))[0]
    assert.deepEqual([fb.fits, fb.titles], [true, ['R16', 'QF', 'SF', 'Final']])
    assert.ok(fb.facts.every((f) => f >= 36))
    await four.page.context().close()

    // A League is not decided until every league Match is finished.
    const lg = (n, status) => ({ id: mid(n), stage: 'league', round: 'League', label: null, ord: n, home_team_id: tid(1), away_team_id: tid(2), home_src: null, away_src: null, kick_off: null,
      status, version: 1, hg: status === 'finished' ? 1 : null, ag: status === 'finished' ? 0 : null, home_pens: null, away_pens: null })
    const three = await open({ list: { structure: 'league', teams: TEAMS, slots: [], matches: [lg(80, 'finished'), lg(81, 'scheduled')], rows: [], published: true, squad: sq, awards: [], sides: [] } })
    await three.page.goto(`${base}/t/${T}`)
    await three.page.getByRole('tab', { name: 'Graphics' }).click()
    await three.page.getByText('Available once every league Match is played').waitFor()
    assert.equal(await three.page.getByText('Available once a goal is scored').count(), 2, 'the Top scorers card and the Season awards line')
    await three.page.context().close()
  }

  // Story 5.7, Templates: Split and Minimal for every Graphic kind of 5.1 to 5.6 (1080x1350, every text layer readable, "Made with" at 24px or more, nothing written), the
  // Minimal leader mark, the picker in Settings → Graphics (previews from real or sample data, the kind switch, Use this template, offline, keyboard, reduced motion).
  {
    const MADE = 'Made with Test Platform'
    /** Every Graphic root on the page: size, no overflow, "Made with" text and size, the right Template, and every text layer readable. */
    const verify = async (p, tpl, n, label) => {
      const roots = await p.locator('.graphic-classic, .graphic-player').evaluateAll((els) => els.filter((el) => !el.closest('.picker-slide')).map((el) => ({ t: el.dataset.template,
        w: el.offsetWidth, h: el.offsetHeight, fits: el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth, made: el.querySelector('.graphic-made')?.textContent,
        px: parseFloat(getComputedStyle(el.querySelector('.graphic-made')).fontSize), op: getComputedStyle(el.querySelector('.graphic-made')).opacity })))
      assert.equal(roots.length, n, `${label}: ${roots.length} Graphics`)
      for (const r of roots) assert.deepEqual([r.t, r.w, r.h, r.fits, r.made, r.px >= 24, r.op], [tpl, 1080, 1350, true, MADE, true, '1'], `${label}: ${JSON.stringify(r)}`)
      const bad = [...await audit(p, '.graphic-classic'), ...await audit(p, '.graphic-player')].filter((l) => l.see || l.ratio < l.need)
      assert.deepEqual(bad, [], `${label}: unreadable text`)
    }
    const sd = (n, h, a) => ({ match_id: mid(n), home_team_id: h, away_team_id: a, home_src: null, away_src: null, home_resolved: h, away_resolved: a })
    const T4 = [...TEAMS, { id: tid(3), name: 'Blue Bats', code: 'BLU', kit: '#00aaff' }, { id: tid(4), name: 'Green Ghosts', code: 'GRN', kit: '#00aa00' }]
    const sq = [0, 1].flatMap((i) => squad(i).map((x) => ({ team_id: tid(i + 1), shirt_number: x.shirt, player: { id: x.player_id, name: x.name } })))
    const slots = [[1, 1, 1], [1, 2, 2], [2, 1, 3], [2, 2, 4]].map(([grp, pos, t]) => ({ id: `99999999-0000-4000-8000-00000000000${t}`, grp, pos, team_id: tid(t) }))
    const row = (n, home, away, stage, round, kick_off, status, extra = {}) => ({ id: mid(n), stage, round, label: null, ord: n, home_team_id: tid(home), away_team_id: tid(away), home_src: null, away_src: null,
      kick_off, status, version: 1, hg: null, ag: null, home_pens: null, away_pens: null, ...extra })
    const lm = [row(10, 1, 2, 'group', 'Group A', '2033-11-13T08:00:00+05:45', 'scheduled'), row(30, 3, 4, 'group', 'Group B', '2033-11-12T09:00:00+05:45', 'scheduled'),
      row(40, 1, 2, 'group', 'Group A', '2033-11-10T10:00:00+05:45', 'finished', { hg: 3, ag: 2 }),
      row(41, 3, 4, 'knockout', 'Final', '2033-11-11T10:00:00+05:45', 'finished', { hg: 2, ag: 2, home_pens: 4, away_pens: 3 })]
    const st = (grp, pos, t, p, w, d, l, gd, pts) => ({ grp, pos, team_id: tid(t), p, w, d, l, gf: 0, ga: 0, gd, pts, group_done: false, provisional: false, shootout_with: null })
    const rows = [st(1, 1, 1, 1, 1, 0, 0, 1, 3), st(1, 2, 2, 1, 0, 0, 1, -1, 0), st(2, 1, 4, 0, 0, 0, 0, 0, 0), st(2, 2, 3, 0, 0, 0, 0, 0, 0)]
    const scorers = [{ player_id: pid(1, 1), team_id: tid(1), goals: 3 }, { player_id: pid(2, 1), team_id: tid(2), goals: 2 }]
    const everyKind = () => ({ teams: T4, slots, matches: lm, rows, published: true, scorers, squad: sq, sides: [sd(40, tid(1), tid(2)), sd(41, tid(3), tid(4))],
      awards: [{ id: 'a1000000-0000-4000-8000-000000000000', award: 'player_of_tournament', player_id: pid(1, 1), version: 1 }] })

    for (const tpl of ['split', 'minimal']) {
      // The pack of a Match with goals, an own goal, a Man of the Match and a Fair Player: the Result and every Player Graphic.
      const { page: p, mock } = await open({ template: tpl })
      await p.goto(`${base}/t/${T}/m/${mid(4)}/pack`)
      await p.waitForFunction(() => [...document.querySelectorAll('.graphic-card button')].filter((b) => /^Download the /.test(b.textContent)).length === 6, null, { timeout: 60000 })
      await verify(p, tpl, 7, `${tpl} pack`)
      const d = await download(p)
      assert.deepEqual(pngSize(d.buf), [1080, 1350], `${tpl}: the PNG size`)
      if (process.env.GRAPHIC_SAVE) writeFileSync(`${process.env.GRAPHIC_SAVE}.${tpl}.png`, d.buf)
      assert.deepEqual(mock.writes, [], `${tpl}: something was written`)
      await p.context().close()

      // The Graphics tab: Official Draw, Fixtures, Results, tables, top scorers, bracket, champions and the Season award, all in the Template.
      const tab = await open({ template: tpl, list: everyKind() })
      await tab.page.goto(`${base}/t/${T}`)
      await tab.page.getByRole('tab', { name: 'Graphics' }).click()
      await tab.page.waitForFunction(() => document.querySelectorAll('.graphics-grid .graphic-card button').length >= 9
        && document.querySelectorAll('.graphics-grid .graphic-placeholder').length === 0, null, { timeout: 120000 })
      const heads = await tab.page.locator('.graphics-grid .graphic-card h2').allTextContents()
      for (const re of [/^Official Draw/, /^Fixtures/, /^Results/, /table Graphic$/, /^Top scorers/, /^Bracket/, /^Champions/, /^Player of the Tournament/]) assert.ok(heads.some((h) => re.test(h)), `${tpl}: no ${re} in ${heads}`)
      await verify(tab.page, tpl, heads.filter((h) => !/^Available/.test(h)).length, `${tpl} tab`)
      assert.deepEqual(tab.mock.writes, [], `${tpl} tab: something was written`)
      await tab.page.context().close()
    }

    // Split with hard colours (a yellow home kit against a navy away kit, and the sweep), Minimal once: ink per half passes everywhere.
    for (const [tpl, brand] of [['split', { primary: '#f6c453', secondary: '#ffffff', kits: ['#ffff00', '#0a1a3f'] }], ...COLOURS.map((c) => ['split', c]), ['minimal', COLOURS[0]]]) {
      const { page: p } = await open({ template: tpl, brand })
      await ready(p, 2)
      await verify(p, tpl, 5, `${tpl} ${brand.kits}`)
      if (tpl === 'split') {
        const halves = await p.locator('.graphic-split .graphic-half').evaluateAll((els) => els.map((e) => e.textContent))
        assert.deepEqual(halves, ['RTMRed Tigers', 'RE8Eight Eagles'])
      }
      await p.context().close()
    }

    // Long names (a 2-line Tournament name, long Team names, a venue and 3 Sponsors): the Result stays 1080x1350 with no overflow and "Made with" inside the canvas.
    for (const tpl of ['split', 'minimal']) {
      const { page: p } = await open({ template: tpl, long: true, three: true })
      await ready(p, 1)
      const f = await p.locator('.graphic-classic').evaluate((el) => {
        const made = el.querySelector('.graphic-made').getBoundingClientRect()
        const root = el.getBoundingClientRect()
        return { size: [el.offsetWidth, el.offsetHeight], fits: el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth, plates: el.querySelectorAll('.graphic-plate').length,
          made: made.bottom <= root.bottom && made.height > 0, text: el.querySelector('.graphic-made').textContent }
      })
      assert.deepEqual([f.size, f.fits, f.plates, f.made, f.text], [[1080, 1350], true, 3, true, MADE], `${tpl} long names: ${JSON.stringify(f)}`)
      await p.context().close()
    }

    // Minimal: the leader is marked by weight 800 against 600 and a ▲; a shootout decides a level score; nothing is marked for a draw.
    {
      const { page: p } = await open({ template: 'minimal' })
      for (const [n, lead] of [[1, 0], [2, 0], [6, null]]) {
        await ready(p, n)
        const f = await p.locator('.graphic-minimal').evaluate((el) => ({ w: [...el.querySelectorAll('.graphic-mscore')].map((s) => getComputedStyle(s).fontWeight), mark: [...el.querySelectorAll('.graphic-mlead')].map((s) => s.textContent),
          score: [...el.querySelectorAll('.graphic-mscore')].map((s) => s.textContent) }))
        if (lead === null) assert.deepEqual([f.w, f.mark], [['600', '600'], ['', '']], 'a draw is marked')
        else assert.deepEqual([f.w, f.mark], [['800', '600'], ['▲', '']], `match ${n}`)
      }
      await p.context().close()
    }

    // The picker: three previews of the Tournament's own Match (or sample Teams before there is one), a kind switch, Use this template at once, offline, keyboard, reduced motion.
    {
      const { page: p, mock } = await open({ init: () => { window.__shared = [] } })
      await p.goto(`${base}/t/${T}/settings`)
      await button(p, 'Choose a graphics template').click()
      await p.waitForURL(`**/t/${T}/settings/graphics`)
      const slides = p.locator('.picker-slide')
      await p.waitForFunction(() => document.querySelectorAll('.picker-slide .graphic-classic').length === 3 && document.querySelector('.picker-slide .graphic-code, .picker-slide .graphic-disc'))
      assert.deepEqual(await slides.locator('h2').allTextContents(), ['Classic', 'Split', 'Minimal'])
      assert.deepEqual(await slides.evaluateAll((els) => els.map((e) => e.querySelector('.graphic-classic').dataset.template)), ['classic', 'split', 'minimal'])
      assert.ok((await p.locator('.picker-slide .graphic-classic').first().textContent()).includes('Red Tigers'), 'not from the Tournament\'s Match')
      assert.deepEqual(await p.locator('.picker-slide .graphic-made').allTextContents(), [MADE, MADE, MADE])
      assert.equal(await p.locator('.picker-inuse').count(), 1)
      assert.equal(await slides.first().locator('.picker-inuse').textContent(), '✓ In use')
      assert.equal(await p.getByRole('button', { name: 'Use this template', exact: true }).count(), 2)
      // The kind switch re-renders every preview.
      for (const [name, sel] of [['Goal', '.graphic-player'], ['Fixtures', '.graphic-list'], ['Table', '.graphic-list'], ['Result', '.graphic-classic']]) {
        await p.getByRole('button', { name, exact: true }).click()
        await p.waitForFunction((s) => document.querySelectorAll(`.picker-slide ${s}`).length === 3, sel)
      }
      // Keyboard: arrows move between previews, the name list jumps, and the row snaps.
      const at = () => p.evaluate(() => document.activeElement?.getAttribute('aria-label'))
      await slides.first().focus()
      await p.keyboard.press('ArrowRight')
      assert.equal(await at(), 'Split template')
      await p.keyboard.press('ArrowRight')
      await p.keyboard.press('ArrowRight')
      assert.equal(await at(), 'Minimal template')
      await p.keyboard.press('ArrowLeft')
      assert.equal(await at(), 'Split template')
      await button(p, 'Show Minimal template').click()
      assert.equal(await at(), 'Minimal template')
      assert.equal(await p.locator('.picker-row').evaluate((r) => getComputedStyle(r).scrollSnapType), 'x mandatory')
      assert.equal(await p.locator('.picker-row').evaluate((r) => getComputedStyle(r).scrollBehavior), 'smooth')
      await p.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      assert.equal(await p.locator('.picker-row').evaluate((r) => getComputedStyle(r).scrollBehavior), 'auto', 'smooth scrolling under reduced motion')
      // Use this template: sent at once with the Tournament's version, no Confirm sheet; Split is in use.
      await slides.nth(1).getByRole('button', { name: 'Use this template' }).click()
      await p.waitForFunction(() => document.querySelectorAll('.picker-slide')[1].querySelector('.picker-inuse'))
      assert.equal(await p.getByRole('dialog').count(), 0, 'a Confirm sheet')
      for (let i = 0; i < 40 && !mock.commands.some((c) => c.cmd === 'set_template'); i++) await new Promise((r) => setTimeout(r, 100))
      const sent = mock.commands.filter((c) => c.cmd === 'set_template')
      assert.equal(sent.length, 1)
      assert.deepEqual([sent[0].tournament_id, sent[0].template, sent[0].expected_version], [T, 'split', 1])
      assert.equal(await p.locator('.picker-inuse').count(), 1)
      // Offline: the choice queues, shows as in use and the Save status says what is waiting.
      mock.drop = true
      await p.context().setOffline(true)
      await slides.nth(2).getByRole('button', { name: 'Use this template' }).click()
      await p.getByText('Offline · 1 change waiting to send', { exact: false }).first().waitFor()
      assert.ok(await slides.nth(2).locator('.picker-inuse').count(), 'Minimal is not shown as in use while queued')
      assert.deepEqual(mock.writes, [], 'a Storage upload or an app write')
      await p.context().close()
    }
    // Before the Draw, with no Match at all: sample Teams in every preview.
    {
      const { page: p } = await open({ list: { teams: [], slots: [], matches: [], rows: [], published: false, squad: [], awards: [] } })
      await p.goto(`${base}/t/${T}/settings/graphics`)
      await p.waitForFunction(() => document.querySelectorAll('.picker-slide .graphic-classic').length === 3)
      for (const t of await p.locator('.picker-slide .graphic-classic').allTextContents()) assert.match(t, /Red Tigers.*RTM|RTM.*Red Tigers/s)
      assert.match(await p.locator('.picker-slide .graphic-classic').first().textContent(), /Blue Eagles/)
      await p.getByRole('button', { name: 'Goal', exact: true }).click()
      await p.waitForFunction(() => document.querySelectorAll('.picker-slide .graphic-player').length === 3)
      await p.context().close()
    }
  }

  // Venue: set in Settings → Dates, editable after the Season starts (the dates lock), refused past 80 characters, cleared when blanked.
  {
    const { page: p, mock } = await open({ variant: 'plain' })
    await p.goto(`${base}/t/${T}/settings/dates`)
    const venue = p.getByLabel('Venue (optional)')
    await venue.waitFor()
    assert.equal(await p.getByLabel('Season starts').isDisabled(), true, 'dates editable after start')
    assert.equal(await venue.isDisabled(), false, 'venue locked after start')
    await venue.fill('x'.repeat(81))
    await venue.blur()
    await p.getByText('Use 1 to 80 characters for the venue, on one line.').waitFor()
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(mock.commands.filter((c) => c.cmd === 'set_season_venue').length, 0, 'a too-long venue was sent')
    await venue.fill('  Tamghas Arena ')
    await venue.blur()
    for (let i = 0; i < 40 && !mock.commands.some((c) => c.cmd === 'set_season_venue'); i++) await new Promise((r) => setTimeout(r, 100))
    const sent = mock.commands.filter((c) => c.cmd === 'set_season_venue')
    assert.equal(sent.length, 1)
    assert.deepEqual([sent[0].season_id, sent[0].venue, sent[0].expected_version], [S, 'Tamghas Arena', 3])
    assert.equal(mock.commands.filter((c) => c.cmd === 'set_season_dates').length, 0, 'dates were sent')
    await p.context().close()
  }
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
