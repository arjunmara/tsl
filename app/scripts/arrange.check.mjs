// Story 3.3 arrange check: Arrange mode (drag, Move up / Move down, focus), kick-off form (BS and AD, Season dates), Publish (blocked,
// ok, grouped by round, Published pill), edits after publishing, offline queue, conflict hand-back. Real Chrome, Supabase mocked.
// `npm run check:arrange`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const outDir = 'node_modules/.arrange-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4198 } })
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
const mid = (n) => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`
const CODES = ['RTM', 'TUF', 'GFC', 'BYC', 'HFC']
const teams = CODES.map((c, i) => ({ id: tid(i + 1), name: `${c} United`, code: c, kit_colour: '#1d4ed8', status: 'approved', registration_link: [], version: 1 }))
// Four League Fixtures: RTM v TUF, GFC v BYC, HFC v RTM, TUF v GFC, in rounds 1, 1, 2, 2.
const pairs = [[1, 2, 'Round 1'], [3, 4, 'Round 1'], [5, 1, 'Round 2'], [2, 3, 'Round 2']]
const rows = (kick) => pairs.map(([h, a, round], i) => ({ id: mid(i + 1), stage: 'league', round, label: null, ord: i + 1, home_team_id: tid(h), away_team_id: tid(a),
  home_src: null, away_src: null, kick_off: kick ? `2026-11-1${i}T09:00:00Z` : null, version: 1 }))

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/** mock.matches / mock.published: the server's state; mock.next: answers to give the next commands; mock.calls: every command body. */
async function fresh({ kick = false } = {}) {
  const season = { id: S, number: 1, status: 'registration', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
    starts_on: '2026-11-10', ends_on: '2026-11-24', registration_deadline: '2026-11-03', structure: 'league', group_count: null, teams_per_group: null, qualifiers_per_group: null }
  const mock = { matches: rows(kick), published: false, calls: [], next: [] }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    }
    if (path === '/rest/v1/team') return json(route, teams)
    if (path === '/rest/v1/draw_slot') return json(route, [])
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/season') return json(route, [{ fixtures_published_at: mock.published ? '2026-11-12T00:00:00Z' : null }])
    if (path === '/rest/v1/match') return json(route, mock.matches)
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    const forced = mock.next.shift()
    if (forced) return json(route, forced)
    const by = (id) => mock.matches.find((m) => m.id === id)
    if (cmd === 'swap_fixtures') {
      const x = by(a.match_a)
      const y = by(a.match_b)
      assert.equal(x.version, a.version_a, 'swap sent a stale version')
      assert.equal(y.version, a.version_b, 'swap sent a stale version')
      ;[x.ord, y.ord, x.version, y.version] = [y.ord, x.ord, x.version + 1, y.version + 1]
      mock.matches.sort((p, q) => p.ord - q.ord)
    } else if (cmd === 'set_kick_off') {
      const m = by(a.match_id)
      assert.equal(m.version, a.expected_version, 'kick-off sent a stale version')
      ;[m.kick_off, m.version] = [a.kick_off, m.version + 1]
    } else if (cmd === 'publish_fixtures') mock.published = true
    return json(route, { ok: true, code: null, message: 'ok', version: 2 })
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${base}/t/${T}`)
  await page.getByRole('tab', { name: 'Matches' }).click()
  return { context, mock, page }
}

const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const button = (page, name) => page.getByRole('button', { name, exact: true })
const text = (page, t) => page.getByText(t, { exact: true })
const order = (page) => page.locator('.match-arrange .match-sides, .match-card .match-sides').allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, ' ')))


try {
  // --- Arrange: handles and buttons, no Move up on the first, no Move down on the last, 48px high and 8px apart.
  {
    const { context, mock, page } = await fresh()
    await button(page, 'Arrange fixtures').click()
    assert.equal(await page.locator('.match-arrange').count(), 4)
    assert.equal(await page.locator('.match-arrange').first().getByRole('button', { name: /^Move up/ }).count(), 0)
    assert.equal(await page.locator('.match-arrange').last().getByRole('button', { name: /^Move down/ }).count(), 0)
    assert.equal(await page.getByRole('button', { name: /^Move up/ }).count(), 3)
    const second = page.locator('.match-arrange').nth(1)
    const up = await second.getByRole('button', { name: /^Move up/ }).boundingBox()
    const down = await second.getByRole('button', { name: /^Move down/ }).boundingBox()
    assert.ok(up.height >= 48 && down.height >= 48, 'buttons under 48px')
    assert.ok(Math.abs(down.x - (up.x + up.width) - 8) < 1.5, `buttons ${down.x - (up.x + up.width)}px apart`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')

    // Move down on card 3: one swap with card 4, and focus stays on the moved card.
    await page.locator('.match-arrange').nth(2).getByRole('button', { name: /^Move down/ }).click()
    await until(page, async () => (await order(page))[3]?.startsWith('HFC'), 'card 3 moved down')
    const s = calls(mock, 'swap_fixtures')
    assert.equal(s.length, 1)
    assert.deepEqual([s[0].match_a, s[0].version_a, s[0].match_b, s[0].version_b], [mid(3), 1, mid(4), 1])
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.match-arrange')?.textContent.includes('HFC')), true, 'focus left the moved card')
    // Keyboard: Enter on Move up of the moved card (now last) swaps it back.
    await page.keyboard.press('Enter')
    await until(page, async () => calls(mock, 'swap_fixtures').length === 2, 'keyboard swap')
    await until(page, async () => (await order(page))[2]?.startsWith('HFC'), 'moved back')

    // Drag card 1 by its handle onto card 2: one swap.
    const h = await page.locator('.match-arrange').first().locator('.match-handle').boundingBox()
    const t = await page.locator('.match-arrange').nth(1).boundingBox()
    await page.mouse.move(h.x + 20, h.y + 20)
    await page.mouse.down()
    await page.mouse.move(h.x + 20, h.y + 60, { steps: 5 })
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 10 })
    await page.mouse.up()
    await until(page, async () => calls(mock, 'swap_fixtures').length === 3, 'drag swap')
    assert.deepEqual([calls(mock, 'swap_fixtures')[2].match_a, calls(mock, 'swap_fixtures')[2].match_b].sort(), [mid(1), mid(2)])
    await until(page, async () => (await order(page))[0]?.startsWith('GFC'), 'dragged')
    await button(page, 'Finish arranging').click()
    assert.equal(await page.locator('.match-arrange').count(), 0)
    await context.close()
  }
  // --- Kick-off: out-of-season refused in words; a good one saves with the version and shows BS and AD on the card.
  {
    const { context, mock, page } = await fresh()
    assert.equal(await button(page, 'Publish fixtures').isDisabled(), true)
    await text(page, '4 Matches have no kick-off time.').waitFor()
    await page.locator('.match-card').first().click()
    await page.getByLabel('Kick-off date').fill('2026-12-30')
    await page.getByLabel('Kick-off time').fill('15:45')
    await button(page, 'Save kick-off').click()
    await page.getByText(/^Pick a date between .* and .*\.$/).first().waitFor()
    assert.equal(calls(mock, 'set_kick_off').length, 0)
    await page.getByLabel('Kick-off date').fill('2026-11-14')
    await text(page, 'Saturday · Kartik 28, 2083 BS (14 Nov 2026)').waitFor()
    await button(page, 'Save kick-off').click()
    await text(page, 'Kick-off saved').waitFor()
    const k = calls(mock, 'set_kick_off')
    assert.equal(k.length, 1)
    assert.deepEqual([k[0].match_id, k[0].expected_version, k[0].kick_off], [mid(1), 1, '2026-11-14T15:45:00+05:45'])
    await page.getByRole('button', { name: 'Back to the Matches' }).click()
    await page.locator('.match-card', { hasText: /Saturday · Kartik 28, 2083 BS \(14 Nov 2026\) · 15:45/ }).waitFor()
    await text(page, '3 Matches have no kick-off time.').waitFor()
    await context.close()
  }
  // --- Publish: ok, grouped by round with the Published pill; edits after publishing save with no Confirm sheet; no re-suggest.
  {
    const { context, mock, page } = await fresh({ kick: true })
    await button(page, 'Publish fixtures').click()
    await text(page, 'Published').first().waitFor()
    assert.equal(calls(mock, 'publish_fixtures').length, 1)
    assert.deepEqual(await page.locator('.fixtures h3').allInnerTexts(), ['Round 1', 'Round 2'])
    assert.equal(await button(page, 'Publish fixtures').count() + await button(page, 'Suggest fixtures again').count(), 0)
    await button(page, 'Arrange fixtures').click()
    await page.locator('.match-arrange').first().getByRole('button', { name: /^Move down/ }).click()
    await until(page, async () => calls(mock, 'swap_fixtures').length === 1, 'swap after publish')
    assert.equal(await page.getByRole('dialog').count(), 0, 'a Confirm sheet appeared')
    await context.close()
  }
  // --- Publish refused on the server: said in words.
  {
    const { context, mock, page } = await fresh({ kick: true })
    mock.next.push({ ok: false, code: 'kickoff_missing', message: 'x' })
    await button(page, 'Publish fixtures').click()
    await text(page, 'Every Match needs a kick-off time before you publish. Reload the page.').waitFor()
    await context.close()
  }
  // --- Offline: a swap and a kick-off queue and show as done; they are sent when the signal returns.
  {
    const { context, mock, page } = await fresh()
    await button(page, 'Arrange fixtures').click()
    await page.locator('.match-arrange').first().waitFor()
    mock.down = true
    await context.setOffline(true)
    await page.locator('.match-arrange').first().getByRole('button', { name: /^Move down/ }).click()
    await until(page, async () => (await order(page))[1]?.startsWith('RTM'), 'offline swap shown')
    assert.equal(calls(mock, 'swap_fixtures').length, 0)
    mock.down = false
    await context.setOffline(false)
    await until(page, async () => calls(mock, 'swap_fixtures').length === 1, 'queued swap sent')
    await context.close()
  }
  // --- Conflict: the hand-back sheet; nothing applies until chosen; Send my version resends with the current versions.
  {
    const { context, mock, page } = await fresh()
    await button(page, 'Arrange fixtures').click()
    mock.next.push({ ok: false, code: 'version_conflict', message: 'x', conflict: { current_version: 2, current: { ord_a: 2, ord_b: 1 },
      resend: { version_a: 2, version_b: 2 }, changed_by: 'Sita', changed_at: '2026-11-10T04:15:00Z' } })
    await page.locator('.match-arrange').first().getByRole('button', { name: /^Move down/ }).click()
    await until(page, async () => mock.next.length === 0, 'conflict answered')
    mock.matches.forEach((m) => (m.version = 2)) // the other phone's edit
    await button(page, 'Review this change').click()
    await page.getByRole('dialog').getByText('Someone else changed this first').waitFor()
    assert.equal((await order(page))[0].startsWith('RTM'), true, 'the swap applied before a choice')
    await button(page, 'Send my version').click()
    await until(page, async () => calls(mock, 'swap_fixtures').length === 2, 'resent')
    const again = calls(mock, 'swap_fixtures')[1]
    assert.deepEqual([again.version_a, again.version_b], [2, 2])
    await context.close()
  }
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
