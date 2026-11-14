// Story 3.6 confirm check: after the Season starts, kick-off moves, Fixture swaps (buttons and drag) and Squad changes ask first on a
// Confirm sheet (before -> after, "This is logged.") and send `confirmed`; Cancel sends nothing and the field shows its saved value;
// removals focus Cancel; an offline confirmed change replays with no second sheet; before start nothing asks; the description saves
// with no sheet while the rules stay locked. Real Chrome, Supabase mocked. `npm run check:confirm`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const TEAM = '55555555-0000-4000-8000-000000000001'
const PL = '99999999-0000-4000-8000-000000000001'
const outDir = 'node_modules/.confirm-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4199 } })
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
const CODES = ['RTM', 'RE8', 'DAB', 'TFC']
const teams = CODES.map((c, i) => ({ id: tid(i + 1), name: `${c} United`, code: c, kit_colour: '#1d4ed8', status: 'approved', registration_link: [], version: 1 }))
// RTM v RE8 and DAB v TFC, kicking off 08:10 and 10:00 Kathmandu time on 2026-11-14.
const rows = () => [[1, 2, '02:25'], [3, 4, '04:15']].map(([h, a, z], i) => ({ id: mid(i + 1), stage: 'league', round: 'Round 1', label: null, ord: i + 1,
  home_team_id: tid(h), away_team_id: tid(a), home_src: null, away_src: null, kick_off: `2026-11-14T${z}:00Z`, version: 1 }))

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

async function fresh({ status = 'started' } = {}) {
  const season = { id: S, number: 1, status, setup_step: 7, version: 3, description: 'Old words', rules: 'Fair play.', photo_consent: 'Photos may be posted.',
    starts_on: '2026-11-10', ends_on: '2026-11-24', registration_deadline: '2026-11-03', structure: 'league', group_count: null, teams_per_group: null,
    qualifiers_per_group: null, starters: 2, max_bench: 1, staff_roles: ['manager', 'coach'] }
  const mock = { matches: rows(), player: { name: 'Ram Thapa', shirt: 7, version: 1 }, removed: false, calls: [], down: false }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const url = new URL(req.url())
    const path = url.pathname
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    }
    if (path === '/rest/v1/team') {
      const id = url.searchParams.get('id')?.replace('eq.', '')
      return json(route, teams.filter((t) => !id || t.id === id).map((t) => ({ ...t, tournament: { name: 'Gulmi Cup' }, season })))
    }
    if (path === '/rest/v1/squad_entry') {
      if (url.searchParams.get('team_id') !== `eq.${TEAM}` || mock.removed) return json(route, [])
      const p = mock.player
      return json(route, [{ team_id: TEAM, shirt_number: p.shirt, player: { id: PL, name: p.name, date_of_birth: '2000-01-01', version: p.version, photo_path: null,
        is_cutout: null, photo_consent: [{ season_id: S, consent_given: false, given_by: null }] } }])
    }
    if (path === '/rest/v1/season') return json(route, [{ fixtures_published_at: '2026-11-12T00:00:00Z' }])
    if (path === '/rest/v1/match') return json(route, mock.matches)
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/rpc/start_check') return json(route, { ready: false, teams: [], reason: 'x' })
    if (path === '/rest/v1/rpc/standings' || path === '/rest/v1/rpc/match_sides') return json(route, [])
    if (req.method() === 'GET' || !req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    if (cmd === 'swap_fixtures') {
      const [x, y] = [a.match_a, a.match_b].map((id) => mock.matches.find((m) => m.id === id))
      ;[x.ord, y.ord, x.version, y.version] = [y.ord, x.ord, x.version + 1, y.version + 1]
      mock.matches.sort((p, q) => p.ord - q.ord)
    } else if (cmd === 'set_kick_off') {
      const m = mock.matches.find((x) => x.id === a.match_id)
      ;[m.kick_off, m.version] = [a.kick_off, m.version + 1]
    } else if (cmd === 'edit_player') {
      if (a.shirt_number) mock.player.shirt = a.shirt_number
      mock.player.version++
    } else if (cmd === 'remove_player') mock.removed = true
    return json(route, { ok: true, code: null, message: 'ok', version: 2 })
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, mock, page }
}

const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const text = (scope, t) => scope.getByText(t, { exact: true })
const sheet = (page) => page.getByRole('dialog')
const openTeam = async (page) => {
  await page.goto(`${base}/t/${T}`)
  await page.getByRole('tab', { name: 'Teams' }).click()
  await button(page, 'Open RTM United').click()
  await page.waitForURL((u) => u.pathname === `/t/${T}/teams/${TEAM}`)
  await page.locator('details.squad-card').first().click()
}
const shirt = (page) => page.locator('details.squad-card').first().getByLabel('Shirt number', { exact: true })
const setShirt = async (page, v) => {
  await shirt(page).fill(v)
  await shirt(page).blur()
}

try {
  // --- Kick-off after start: the sheet states before -> after and "This is logged."; Cancel sends nothing; Confirm sends `confirmed`.
  {
    const { context, mock, page } = await fresh()
    await page.goto(`${base}/t/${T}/m/${mid(1)}`)
    await button(page, 'Save kick-off').click()
    await page.waitForTimeout(300)
    assert.equal(await sheet(page).count(), 0, 'an unchanged kick-off asked')
    await page.getByLabel('Kick-off time').fill('09:30')
    await button(page, 'Save kick-off').click()
    await sheet(page).getByRole('heading', { name: 'Move RTM v RE8 from 8:10 to 9:30 AM, Saturday · Kartik 28, 2083 BS (14 Nov 2026)?' }).waitFor()
    await text(sheet(page), 'This is logged.').waitFor()
    await button(sheet(page), 'Cancel').click()
    assert.equal(calls(mock, 'set_kick_off').length, 0)
    await until(page, async () => (await page.getByLabel('Kick-off time').inputValue()) === '08:10', 'time back to saved')
    await page.getByLabel('Kick-off time').fill('09:30')
    await button(page, 'Save kick-off').click()
    await button(sheet(page), 'Move this kick-off').click()
    await text(page, 'Moved. Logged in the Activity log.').waitFor()
    const k = calls(mock, 'set_kick_off')
    assert.equal(k.length, 1)
    assert.equal(k[0].confirmed, true)
    await context.close()
  }
  // --- Swap after start: buttons and drag both ask; Cancel sends nothing.
  {
    const { context, mock, page } = await fresh()
    await page.goto(`${base}/t/${T}`)
    await page.getByRole('tab', { name: 'Matches' }).click()
    await button(page, 'Arrange fixtures').click()
    await page.locator('.match-arrange').first().getByRole('button', { name: /^Move down/ }).click()
    await sheet(page).getByRole('heading', { name: 'Swap RTM v RE8 and DAB v TFC?' }).waitFor()
    await text(sheet(page), 'This is logged.').waitFor()
    await button(sheet(page), 'Cancel').click()
    assert.equal(calls(mock, 'swap_fixtures').length, 0)
    await page.locator('.match-arrange').first().getByRole('button', { name: /^Move down/ }).click()
    await button(sheet(page), 'Swap these two Fixtures').click()
    await until(page, async () => calls(mock, 'swap_fixtures').length === 1, 'button swap sent')
    await text(page, 'Moved. Logged in the Activity log.').waitFor({ timeout: 4000 })
    const h = await page.locator('.match-arrange').first().locator('.match-handle').boundingBox()
    const t = await page.locator('.match-arrange').nth(1).boundingBox()
    await page.mouse.move(h.x + 20, h.y + 20)
    await page.mouse.down()
    await page.mouse.move(h.x + 20, h.y + 60, { steps: 5 })
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 10 })
    await page.mouse.up()
    await sheet(page).getByRole('heading', { name: 'Swap DAB v TFC and RTM v RE8?' }).waitFor()
    await page.waitForTimeout(300)
    await button(sheet(page), 'Swap these two Fixtures').click()
    await until(page, async () => calls(mock, 'swap_fixtures').length === 2, 'drag swap sent')
    await text(page, 'Moved. Logged in the Activity log.').waitFor({ timeout: 4000 })
    assert.equal(calls(mock, 'swap_fixtures').every((c) => c.confirmed === true), true)
    assert.equal(calls(mock, 'swap_fixtures').length, 2)
    await context.close()
  }
  // --- Squad after start: edit (Cancel puts 7 back; Confirm sends 9), remove (focus on Cancel; Enter closes), add.
  {
    const { context, mock, page } = await fresh()
    await openTeam(page)
    await setShirt(page, '9')
    await sheet(page).getByRole('heading', { name: "Change Ram Thapa's shirt number from 7 to 9?" }).waitFor()
    await text(sheet(page), 'This is logged.').waitFor()
    await button(sheet(page), 'Cancel').click()
    assert.equal(calls(mock, 'edit_player').length, 0)
    await until(page, async () => (await shirt(page).inputValue()) === '7', 'shirt back to 7')
    await setShirt(page, '9')
    await button(sheet(page), "Change Ram Thapa's shirt number").click()
    await text(page, 'Saved. Logged in the Activity log.').waitFor()
    assert.equal(calls(mock, 'edit_player')[0].confirmed, true)

    await button(page, 'Remove Ram Thapa from the Squad').click()
    await until(page, async () => (await page.evaluate(() => document.activeElement?.textContent)) === 'Cancel', 'focus on Cancel')
    await text(sheet(page), 'This is logged.').waitFor()
    await page.keyboard.press('Enter')
    await until(page, async () => (await sheet(page).count()) === 0, 'sheet closed by Enter on Cancel')
    assert.equal(calls(mock, 'remove_player').length, 0)
    await button(page, 'Remove Ram Thapa from the Squad').click()
    await button(sheet(page), 'Remove Ram Thapa').click()
    await until(page, async () => calls(mock, 'remove_player').length === 1, 'remove sent')
    assert.equal(calls(mock, 'remove_player')[0].confirmed, true)

    await page.getByLabel("Player's name", { exact: true }).last().fill('Hari Rana')
    await page.getByLabel('Shirt number', { exact: true }).last().fill('11')
    await page.getByLabel('Date of birth', { exact: true }).last().fill('2001-02-03')
    await button(page, 'Add this Player').click()
    await sheet(page).getByRole('heading', { name: 'Add Hari Rana to RTM?' }).waitFor()
    await button(sheet(page), 'Cancel').click()
    assert.equal(calls(mock, 'add_player').length, 0)
    assert.equal(await page.getByText('Hari Rana added.').count(), 0, 'a cancelled add said it was added')
    assert.equal(await page.getByLabel("Player's name", { exact: true }).last().inputValue(), 'Hari Rana', 'the form was cleared')
    await context.close()
  }
  // --- Offline: a confirmed change queues with `confirmed` and replays with no second sheet.
  {
    const { context, mock, page } = await fresh()
    await openTeam(page)
    mock.down = true
    await setShirt(page, '9')
    await button(sheet(page), "Change Ram Thapa's shirt number").click()
    await page.waitForTimeout(300)
    assert.equal(calls(mock, 'edit_player').length, 0)
    mock.down = false
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await until(page, async () => calls(mock, 'edit_player').length === 1, 'queued change replayed')
    assert.equal(calls(mock, 'edit_player')[0].confirmed, true)
    assert.equal(await sheet(page).count(), 0, 'a second sheet asked')
    await context.close()
  }
  // --- Before start: no sheet, no `confirmed`.
  {
    const { context, mock, page } = await fresh({ status: 'registration' })
    await openTeam(page)
    await setShirt(page, '9')
    await until(page, async () => calls(mock, 'edit_player').length === 1, 'edit sent')
    assert.equal(await sheet(page).count(), 0)
    assert.equal(calls(mock, 'edit_player')[0].confirmed, undefined)
    await context.close()
  }
  // --- Description after start: saves on leaving the field with no sheet; rules and the consent statement are locked.
  {
    const { context, mock, page } = await fresh()
    await page.goto(`${base}/t/${T}/settings/rules`)
    await page.getByLabel('Description', { exact: true }).fill('New words')
    await page.getByLabel('Description', { exact: true }).blur()
    await until(page, async () => calls(mock, 'set_season_rules').length === 1, 'description sent')
    assert.equal(await sheet(page).count(), 0)
    const c = calls(mock, 'set_season_rules')[0]
    assert.equal(c.description, 'New words')
    assert.equal(c.rules, undefined)
    assert.equal(await page.getByLabel('Rules', { exact: true }).isDisabled(), true)
    assert.equal(await page.getByLabel('Photo-consent statement', { exact: true }).isDisabled(), true)
    await context.close()
  }
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
