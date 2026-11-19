// Story 5.1 check: the Result Graphic of a finished Match in the Classic Template: layout and fixed rules, the caption, Share (share sheet with the PNG and caption, cancel), Download
// (PNG of exactly 1080x1350 plus the copied caption, or the caption as text when the clipboard is blocked), the failure message with a working retry, zero Storage uploads and zero
// `app` writes, and the Venue field (editable after start, 80 characters). Real Chrome, Supabase mocked by route interception. `npm run check:graphic`.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
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
const squad = (i) => Array.from({ length: 8 }, (_, n) => ({ player_id: pid(i + 1, n + 1), name: `${TEAMS[i].code} Player ${n + 1}`, shirt: n + 1 }))
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

const goal = (id, team, player, minute, extra = {}) => ({ id, kind: 'goal', period: 1, minute, entered_at: new Date(Date.now() - 600000 + minute * 1000).toISOString(), home: null, away: null,
  team_id: team, player_id: player, assist_id: null, own_goal: false, version: 1, ...extra })
const g = (n) => `e${n}000000-0000-4000-8000-000000000000`
// M1: 3-2 with an own goal and an unknown scorer (newest first, as the server sends them). M2: 2-2, shootout 4-3.
const events = {
  [mid(1)]: [goal(g(5), tid(1), pid(1, 2), 31), goal(g(4), tid(2), null, 20), goal(g(3), tid(1), null, 14, { own_goal: true }), goal(g(2), tid(2), pid(2, 1), 9), goal(g(1), tid(1), pid(1, 1), 5)],
  [mid(3)]: Array.from({ length: 12 }, (_, i) => goal(`e${20 - i}000000-0000-4000-8000-000000000000`, tid(1), pid(1, (i % 3) + 1), 12 - i)),
  [mid(2)]: [goal(g(9), tid(2), pid(2, 3), 38), goal(g(8), tid(1), pid(1, 3), 30), goal(g(7), tid(2), pid(2, 1), 12), goal(g(6), tid(1), pid(1, 1), 3)],
}
const matches = [
  { n: 1, kick_off: '2033-11-13T10:00:00+05:45', hg: 3, ag: 2, home_pens: null, away_pens: null },
  { n: 2, kick_off: null, hg: 2, ag: 2, home_pens: 4, away_pens: 3 },
  { n: 3, kick_off: null, hg: 12, ag: 0, home_pens: null, away_pens: null },
].map((m) => ({ id: mid(m.n), stage: m.n === 1 ? 'group' : 'knockout', round: m.n === 1 ? 'Group A' : 'Final', label: null, ord: m.n, home_team_id: tid(1), away_team_id: tid(2),
  home_src: null, away_src: null, status: 'finished', version: 2, ...m }))
const rules = { starters: 3, max_bench: 9, periods: 2, extra_time_periods: 0, period_minutes: 20, extra_time_minutes: 5, substitutions: 'rolling' }
const frozen = { running: false, anchor_at: new Date().toISOString(), elapsed_ms: 2400000, period: 2, interval: false }
const LONG = 'Extraordinarily Long Name For A Futsal Side That Goes On And On Forever Ok'
function consoleFor(id, long) {
  const m = matches.find((x) => x.id === id)
  const teams = TEAMS.map((t, i) => ({ team_id: t.id, name: long ? `${t.name} ${LONG}`.slice(0, 80) : t.name, code: t.code, registered_kit: t.kit, side: i === 0 ? 'home' : 'away', squad: squad(i),
    lineup: { starters: [1, 2, 3].map((n) => pid(i + 1, n)), bench: [4, 5].map((n) => pid(i + 1, n)), kit_colour: t.kit, version: 1 } }))
  return { match: { id, season_id: S, tournament_id: T, stage: m.stage, round: m.round, label: null, kick_off: m.kick_off, status: 'finished', season_status: 'started', version: 2,
    home_team_id: tid(1), away_team_id: tid(2), home_pens: m.home_pens, away_pens: m.away_pens, mom_player_id: null, fair_player_id: null },
    rules, clock: frozen, score: { home: 0, away: 0 }, events: events[id], holder: true, held: true, on_air: false, teams }
}

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const READS = new Set(['console_match', 'server_now', 'standings', 'match_sides', 'takeover_requests', 'scoring_state'])

/** variant 'full': logo, brand colours, two Sponsors and a venue; 'plain': none of them. A Season in the started state. */
async function open({ variant = 'full', init = '', long = false } = {}) {
  const mock = { writes: [], commands: [] }
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
      return json(route, [{ id: T, name: long ? LONG : 'Gulmi Cup', brand_primary: variant === 'full' ? '#f6c453' : '#0a1a3f', brand_secondary: '#f58220', logo_path: variant === 'full' ? `${T}/logo.webp` : null, version: 1, season: variant === 'full' ? [season, later] : [season] }])
    }
    if (path === '/rest/v1/season') return json(route, { venue: new URL(req.url()).searchParams.get('id') === `eq.${S}` ? season.venue : 'Latest Venue' })
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
    if (cmd === 'console_match') return json(route, consoleFor(a.p_match_id, long))
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
const status = (p) => p.locator('.graphic-card [role="status"]')
const ready = async (p, n) => { await p.goto(`${base}/t/${T}/m/${mid(n)}`); await button(p, 'Download this Graphic').waitFor({ timeout: 30000 }) }
const alt = (p) => p.locator('.graphic-thumb').getAttribute('aria-label')
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)]
const download = async (p) => {
  const [d] = await Promise.all([p.waitForEvent('download'), button(p, 'Download this Graphic').click()])
  return { name: d.suggestedFilename(), buf: readFileSync(await d.path()) }
}
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
    const alert = p.getByRole('alert').filter({ hasText: "Couldn't make this Graphic. Try again." })
    await alert.waitFor({ timeout: 30000 })
    assert.equal(await button(p, 'Download this Graphic').count(), 0)
    await p.evaluate(() => { window.tslGraphicFail = false })
    await button(p, 'Try making the graphic again').click()
    await button(p, 'Download this Graphic').waitFor({ timeout: 30000 })
    assert.equal(await alert.count(), 0)
    await p.context().close()
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
