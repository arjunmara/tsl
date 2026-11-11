// Story 3.1 chit Draw check: the Matches tab empty state, the Draw board (groups or numbered bracket), tap-then-place and
// drag, sending a Team back, a taken slot, "Place the rest at random", "Draw complete", offline placements and the
// Keep theirs / Use mine hand-back. Every UI row of the spec's I/O matrix, in real Chrome with Supabase mocked by route
// interception. `npm run check:draw`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'
import { drawColumns, overlayDraw } from '../src/domain/drawBoard.ts'

// Pure parts first.
const gk = { structure: 'groups_knockout', group_count: 2, teams_per_group: 4 }
assert.deepEqual(drawColumns(gk, 8).map((c) => [c.grp, c.title, c.size]), [[1, 'Group A', 4], [2, 'Group B', 4]])
assert.deepEqual(drawColumns({ structure: 'knockout' }, 6).map((c) => [c.grp, c.size]), [[0, 6]])
assert.deepEqual(drawColumns({ structure: 'league' }, 6), [])
const place = (n, t, grp, pos) => ({ name: 'place_team_in_draw', args: { season_id: 'S', slot_id: n, team_id: t, grp, pos } })
assert.deepEqual(overlayDraw([{ id: 'a', grp: 1, pos: 1, teamId: 'x' }], [place('b', 'y', 1, 1), place('c', 'x', 1, 2), place('d', 'z', 1, 3),
  { name: 'unplace_team_from_draw', args: { season_id: 'S', team_id: 'x' } }], 'S').map((s) => s.teamId), ['z'])

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const outDir = 'node_modules/.draw-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4196 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email: 'org@example.com', exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'org@example.com', email_confirmed_at: '2026-11-08T00:00:00Z',
    app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}
const tid = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`
const CODES = ['RTM', 'TUF', 'GFC', 'BYC', 'HFC', 'NSC', 'PUN', 'AFC']
const teamRow = (id, name, code, status) => ({ id, name, code, kit_colour: '#1d4ed8', status, registration_link: [] })
const approvedTeams = () => CODES.map((c, i) => teamRow(tid(i + 1), `${c} United`, c, 'approved'))
const extra = () => [teamRow(tid(20), 'Sent FC', 'SNT', 'submitted'), teamRow(tid(21), 'Back FC', 'RET', 'returned'), teamRow(tid(22), 'Gone FC', 'WDR', 'withdrawn')]

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/** mock.slots: draw_slot rows; mock.calls: every command body; mock.answers[cmd]: answers to give first; mock.down: unreachable. */
async function fresh({ structure = 'groups_knockout', teams = [...approvedTeams(), ...extra()], slots = [] } = {}) {
  const season = { id: S, number: 1, status: 'registration', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
    starts_on: '2033-11-07', ends_on: '2033-11-21', registration_deadline: '2033-11-03', structure, group_count: 2, teams_per_group: 4, qualifiers_per_group: 2 }
  const mock = { teams, slots, answers: {}, calls: [], down: false }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    }
    if (path === '/rest/v1/team') return json(route, mock.teams.map((t) => ({ ...t, version: 1 })))
    if (path === '/rest/v1/draw_slot') return json(route, mock.slots)
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    const given = mock.answers[cmd]?.shift()
    if (given) return json(route, given)
    if (cmd === 'place_team_in_draw') mock.slots.push({ id: a.slot_id, grp: a.grp, pos: a.pos, team_id: a.team_id })
    if (cmd === 'unplace_team_from_draw') mock.slots = mock.slots.filter((s) => s.team_id !== a.team_id)
    if (cmd === 'place_rest_at_random') {
      const free = []
      for (let g = 1; g <= 2; g++) for (let p = 1; p <= 4; p++) if (!mock.slots.some((s) => s.grp === g && s.pos === p)) free.push([g, p])
      for (const t of mock.teams.filter((x) => x.status === 'approved' && !mock.slots.some((s) => s.team_id === x.id))) {
        const [grp, pos] = free.pop()
        mock.slots.push({ id: crypto.randomUUID(), grp, pos, team_id: t.id })
      }
    }
    return json(route, { ok: true, code: null, message: 'Done.' })
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${base}/t/${T}`)
  await page.getByRole('tab', { name: 'Matches' }).click()
  return { context, mock, page }
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
const text = (page, t) => page.getByText(t, { exact: true })
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const slot = (page, name) => page.getByRole('button', { name: new RegExp(`^${name}`) })
const chip = (page, code) => page.locator('.draw-chip', { hasText: code })
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const status = (page) => page.locator('.draw [role="status"]').first()

try {
  // --- Empty state, then the board: Group A and B as 4 slots each, 8 approved chips; others are not chips.
  {
    const { context, mock, page } = await fresh()
    await text(page, 'Record the draw once registration closes.').waitFor()
    await button(page, 'Record the draw').click()
    for (const g of ['Group A', 'Group B']) {
      await page.getByRole('region', { name: g, exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: new RegExp(`^${g} slot \\d, empty`) }).count(), 4)
    }
    assert.equal(await page.locator('.draw-chip').count(), 8)
    for (const c of ['SNT', 'RET', 'WDR']) assert.equal(await chip(page, c).count(), 0, c)
    assert.equal(await page.locator('.draw-slot').first().evaluate((e) => getComputedStyle(e).borderStyle), 'dashed')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
    assert.equal(mock.calls.length, 0)

    // --- Tap a chip: 3px ink outline, aria-pressed, polite words; tap an empty slot: placed with its own command.
    await chip(page, 'RTM').click()
    assert.equal(await chip(page, 'RTM').getAttribute('aria-pressed'), 'true')
    assert.equal(await chip(page, 'RTM').evaluate((e) => getComputedStyle(e).outlineWidth), '3px')
    await text(page, 'Placing RTM: tap a slot').waitFor()
    assert.equal(await status(page).getAttribute('aria-live'), 'polite')
    await slot(page, 'Group A slot 1').click()
    await until(page, async () => calls(mock, 'place_team_in_draw').length === 1, 'placement sent')
    const c = calls(mock, 'place_team_in_draw')[0]
    assert.deepEqual([c.season_id, c.team_id, c.grp, c.pos], [S, tid(1), 1, 1])
    assert.match(c.slot_id, /^[0-9a-f-]{36}$/)
    await slot(page, 'Group A slot 1: RTM').waitFor()
    assert.equal(await chip(page, 'RTM').count(), 0)

    // --- A taken slot refuses, in words, with nothing sent.
    await chip(page, 'TUF').click()
    await slot(page, 'Group A slot 1: RTM').click()
    await text(page, 'That slot is taken.').waitFor()
    assert.equal(calls(mock, 'place_team_in_draw').length, 1)

    // --- Drag a chip onto an empty slot; a filled slot does not accept the drop.
    await chip(page, 'GFC').dragTo(slot(page, 'Group B slot 2'))
    await until(page, async () => calls(mock, 'place_team_in_draw').length === 2, 'drop sent')
    assert.deepEqual([calls(mock, 'place_team_in_draw')[1].grp, calls(mock, 'place_team_in_draw')[1].pos], [2, 2])
    await chip(page, 'BYC').dragTo(slot(page, 'Group A slot 1: RTM'))
    await page.waitForTimeout(300)
    assert.equal(calls(mock, 'place_team_in_draw').length, 2)

    // --- Tap a placed Team (nothing picked: the drop cleared it): it goes back, as its own command.
    await slot(page, 'Group A slot 1: RTM').click()
    await until(page, async () => calls(mock, 'unplace_team_from_draw').length === 1, 'send back')
    assert.equal(calls(mock, 'unplace_team_from_draw')[0].team_id, tid(1))
    await slot(page, 'Group A slot 1, empty').waitFor()
    await chip(page, 'RTM').waitFor()

    // --- Seed (place first), then the rest at random: one command, nobody else moved; then Draw complete, politely.
    await button(page, 'Place the rest at random').click()
    await until(page, async () => calls(mock, 'place_rest_at_random').length === 1, 'random sent')
    await text(page, 'Draw complete').first().waitFor()
    assert.equal(await page.locator('.draw-chip').count(), 0)
    assert.equal(await page.locator('.draw-slot-filled').count(), 8)
    assert.equal(await button(page, 'Place the rest at random').count(), 0)
    await context.close()
  }

  // --- The last placement says "Draw complete" in the live region.
  {
    const slots = approvedTeams().slice(0, 7).map((t, i) => ({ id: crypto.randomUUID(), grp: i < 4 ? 1 : 2, pos: (i % 4) + 1, team_id: t.id }))
    const { context, page } = await fresh({ slots })
    await chip(page, 'AFC').click()
    await slot(page, 'Group B slot 4').click()
    await page.locator('.draw [role="status"]', { hasText: 'Draw complete' }).waitFor()
    await context.close()
  }

  // --- Knockout only: numbered bracket slots, same tap rules.
  {
    const { context, mock, page } = await fresh({ structure: 'knockout' })
    await button(page, 'Record the draw').click()
    assert.equal(await page.getByRole('button', { name: /^Bracket slot \d, empty/ }).count(), 8)
    await chip(page, 'RTM').click()
    await slot(page, 'Bracket slot 3').click()
    await until(page, async () => calls(mock, 'place_team_in_draw').length === 1, 'bracket placement')
    assert.deepEqual([calls(mock, 'place_team_in_draw')[0].grp, calls(mock, 'place_team_in_draw')[0].pos], [0, 3])
    await context.close()
  }

  // --- Offline: placements queue and show at once, then send in order when the signal returns.
  {
    const { context, mock, page } = await fresh()
    await button(page, 'Record the draw').click()
    mock.down = true
    await context.setOffline(true)
    await chip(page, 'RTM').click()
    await slot(page, 'Group A slot 1').click()
    await chip(page, 'TUF').click()
    await slot(page, 'Group A slot 2').click()
    await slot(page, 'Group A slot 2: TUF').waitFor()
    await slot(page, 'Group A slot 1: RTM').waitFor()
    assert.equal(await button(page, 'Place the rest at random').count(), 0)
    await text(page, 'Placing the rest at random needs a signal. Place Teams one by one meanwhile.').waitFor()
    mock.down = false
    await context.setOffline(false)
    await until(page, async () => calls(mock, 'place_team_in_draw').length === 2, 'queued placements not sent')
    assert.deepEqual(calls(mock, 'place_team_in_draw').map((x) => x.team_id), [tid(1), tid(2)])
    await context.close()
  }

  // --- A slot a co-organiser filled first: the hand-back offers Keep their version / Send my version; mine resends with their version.
  {
    const { context, mock, page } = await fresh()
    await button(page, 'Record the draw').click()
    mock.answers.place_team_in_draw = [{ ok: false, code: 'version_conflict', message: 'Someone else placed a Team in that slot first.',
      conflict: { current_version: 1, current: { team_id: tid(2) }, changed_by: 'asha', changed_at: '2026-11-11T10:00:00Z' } }]
    await chip(page, 'RTM').click()
    await slot(page, 'Group A slot 1').click()
    await button(page, 'Review this change').click()
    await button(page, 'Send my version').waitFor()
    await button(page, 'Keep their version').waitFor()
    await button(page, 'Send my version').click()
    await until(page, async () => calls(mock, 'place_team_in_draw').length === 2, 'resent')
    assert.equal(calls(mock, 'place_team_in_draw')[1].expected_version, 1)
    await context.close()
  }

  // --- A refusal (an unapproved Team) is said in words and dropped; started Season: read-only board.
  {
    const { context, mock, page } = await fresh()
    await button(page, 'Record the draw').click()
    mock.answers.place_team_in_draw = [{ ok: false, code: 'team_not_approved', message: 'No.' }]
    await chip(page, 'RTM').click()
    await slot(page, 'Group A slot 1').click()
    await text(page, 'Only approved Teams can be placed in the Draw. Reload the page.').waitFor()
    await context.close()
  }

  // --- No approved Team yet: the action says why it is off.
  {
    const { context, page } = await fresh({ teams: extra() })
    await text(page, 'Approve at least one Team first.').waitFor()
    assert.equal(await button(page, 'Record the draw').isDisabled(), true)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
