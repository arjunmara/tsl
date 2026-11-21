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
const g = (n) => `e${n}000000-0000-4000-8000-000000000000`
// M1: 3-2 with an own goal and an unknown scorer (newest first, as the server sends them). M2: 2-2, shootout 4-3.
const events = {
  [mid(1)]: [goal(g(5), tid(1), pid(1, 2), 31), goal(g(4), tid(2), null, 20), goal(g(3), tid(1), null, 14, { own_goal: true }), goal(g(2), tid(2), pid(2, 1), 9), goal(g(1), tid(1), pid(1, 1), 5)],
  [mid(3)]: Array.from({ length: 12 }, (_, i) => goal(`e${20 - i}000000-0000-4000-8000-000000000000`, tid(1), pid(1, (i % 3) + 1), 12 - i)),
  // M4: 3-1. Consented cut-out (Roshan, with an assist), an own goal, an unknown scorer, and a scorer without consent.
  [mid(4)]: [goal(g(14), tid(1), pid(1, 2), 33), goal(g(13), tid(2), null, 27), goal(g(12), tid(1), null, 20, { own_goal: true }), goal(g(11), tid(1), pid(1, 9), 12, { assist_id: pid(1, 2) })],
  [mid(2)]: [goal(g(9), tid(2), pid(2, 3), 38), goal(g(8), tid(1), pid(1, 3), 30), goal(g(7), tid(2), pid(2, 1), 12), goal(g(6), tid(1), pid(1, 1), 3)],
}
const matches = [
  { n: 1, kick_off: '2033-11-13T10:00:00+05:45', hg: 3, ag: 2, home_pens: null, away_pens: null },
  { n: 2, kick_off: '2033-11-14T10:00:00+05:45', hg: 2, ag: 2, home_pens: 4, away_pens: 3 },
  { n: 3, kick_off: null, hg: 12, ag: 0, home_pens: null, away_pens: null },
  { n: 4, kick_off: '2033-11-13T10:00:00+05:45', hg: 3, ag: 1, home_pens: null, away_pens: null },
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
    home_team_id: tid(1), away_team_id: tid(2), home_pens: m.home_pens, away_pens: m.away_pens, mom_player_id: id === mid(4) ? pid(1, 9) : null, fair_player_id: id === mid(4) ? pid(2, 9) : null },
    rules, clock: frozen, score: { home: 0, away: 0 }, events: events[id], holder: true, held: true, on_air: false, teams }
}

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const READS = new Set(['console_match', 'server_now', 'standings', 'match_sides', 'takeover_requests', 'scoring_state'])

/** variant 'full': logo, brand colours, two Sponsors and a venue; 'plain': none of them. A Season in the started state. brand: { primary, secondary, kits } overrides the colours. */
async function open({ variant = 'full', init = '', long = false, brand = null } = {}) {
  const mock = { writes: [], commands: [], signed: [], views: [] }
  const season = { id: S, number: 1, status: 'started', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
    starts_on: '2033-11-07', ends_on: '2033-11-21', registration_deadline: '2033-11-03', structure: 'groups_knockout', group_count: 2, teams_per_group: 4, qualifiers_per_group: 2,
    venue: variant === 'full' ? 'Tamghas Arena' : null }
  const sponsors = variant === 'full'
    ? [{ id: 'a1', caption: 'Alpha Co', logo_path: `${T}/a1.webp`, ad_paths: [], version: 1, sort: 0 }, { id: 'b2', caption: 'Beta Ltd', logo_path: `${T}/b2.webp`, ad_paths: [], version: 1, sort: 1 }] : []
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
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') {
      // The full variant has a later Season with another venue: the Graphic reads the venue of the Match's own Season (S).
      const later = { ...season, id: '22222222-0000-4000-8000-000000000010', number: 2, venue: 'Latest Venue' }
      return json(route, [{ id: T, name: long ? LONG : 'Gulmi Cup', brand_primary: brand?.primary ?? (variant === 'full' ? '#f6c453' : '#0a1a3f'), brand_secondary: brand?.secondary ?? '#f58220', logo_path: variant === 'full' ? `${T}/logo.webp` : null, version: 1, season: variant === 'full' ? [season, later] : [season] }])
    }
    if (path === '/rest/v1/season') return json(route, { venue: new URL(req.url()).searchParams.get('id') === `eq.${S}` ? season.venue : 'Latest Venue' })
    if (path === '/rest/v1/player_photo_public') {
      // What the consent view gives: a path only for a consented cut-out (Roshan); others come back null. Anyone else's photo is never in the answer.
      mock.views.push(req.url())
      return json(route, [{ player_id: pid(1, 9), photo_path: `${T}/roshan.webp` }, { player_id: pid(2, 9), photo_path: null }, { player_id: pid(1, 2), photo_path: null }])
    }
    if (path === '/rest/v1/sponsor') return json(route, sponsors)
    if (path === '/rest/v1/team') return json(route, TEAMS.map((t) => ({ id: t.id, name: t.name, code: t.code, kit_colour: t.kit, status: 'approved', registration_link: [], version: 1 })))
    if (path === '/rest/v1/match') return json(route, matches)
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (req.method() !== 'GET' && !path.startsWith('/rest/v1/rpc/')) mock.writes.push(`${req.method()} ${path}`)
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    if (req.method() !== 'GET' && !READS.has(cmd)) mock.commands.push({ cmd, ...a })
    if (req.method() !== 'GET' && !READS.has(cmd) && !/^(set_season_venue|set_setup_step)$/.test(cmd)) mock.writes.push(`${req.method()} ${path}`)
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
const ready = async (p, n) => { await p.goto(`${base}/t/${T}/m/${mid(n)}`); await button(p, 'Download this Graphic').waitFor({ timeout: 30000 }) }
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
    await p.goto(`${base}/t/${T}/m/${mid(1)}`)
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
    await p.goto(`${base}/t/${T}/m/${mid(4)}`)
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

  // Unset Awards leave no card: a Match without Man of the Match or Fair Player has only the goals (here 5 and the Result card).
  {
    const { page: p } = await open()
    await p.goto(`${base}/t/${T}/m/${mid(1)}`)
    await p.waitForFunction(() => [...document.querySelectorAll('.graphic-card button')].filter((b) => /^Download the /.test(b.textContent)).length === 5, null, { timeout: 60000 })
    assert.equal(await p.locator('.graphic-card').count(), 6)
    assert.equal(await p.locator('.graphic-card').getByText(/Man of the Match|Fair Player/).count(), 0)
    await p.context().close()
  }

  // Contrast: gold and white and the hard sweep; every Player text layer, the word and "Made with" included, on at least a 95% opaque fill read as its worst blend.
  for (const brand of COLOURS) {
    const { page: p, mock } = await open({ brand })
    await p.goto(`${base}/t/${T}/m/${mid(4)}`)
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
