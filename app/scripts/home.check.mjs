// Story 1.12 home check: the Tournament home (App bar, Tab bar, remembered tab) and Settings sections in real Chrome,
// every UI row of the spec's I/O matrix. Supabase is mocked by route interception: the tournament read, the presets and
// every command (recorded, answered ok with the row's next version). The app is built with a fake Supabase URL into
// node_modules/.home-dist. `npm run check:home`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const T2 = '22222222-0000-4000-8000-000000000002'
const T3 = '22222222-0000-4000-8000-000000000003'
const outDir = 'node_modules/.home-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_TURNSTILE_SITE_KEY
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4184 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const email = 'org@example.com'
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email, exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: '2026-11-08T00:00:00Z', app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}

const FUTSAL = { key: 'futsal', label: 'Futsal', sort: 1, confirmed: true, futsal_rules: true, periods: 2, period_minutes: 20, clock: 'stopped',
  half_time_minutes: 15, extra_time: true, extra_time_periods: 2, extra_time_minutes: 5, shootout: true, substitutions: 'rolling',
  max_substitutions: null, foul_warning: 5, timeouts_per_period: 1, power_play_minutes: 2, starters: 5, max_bench: 9 }
const tournament = (id, name, setupStep) => ({
  id, name, brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1,
  season: [{ id: `${id.slice(0, -1)}9`, number: 1, status: 'setup', setup_step: setupStep, version: 1, description: '', rules: '', photo_consent: '',
    starts_on: null, ends_on: null, registration_deadline: null, format_preset: null, starters: null, max_bench: null, staff_roles: ['manager', 'coach'],
    structure: null, group_count: null, teams_per_group: null, qualifiers_per_group: null, points_win: 3, points_draw: 1, points_loss: 0,
    tiebreaks: ['h2h_points', 'h2h_goal_difference', 'h2h_shootout', 'goal_difference', 'goals_scored'] }],
})

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/** A signed-in context; mock.calls: every command body (cmd: its name); mock.down: Supabase unreachable. */
async function fresh({ viewport = { width: 390, height: 844 }, setupStep = 3, blockTabStorage = false } = {}) {
  const done = tournament(T3, 'Done Cup', 7)
  done.season[0].status = 'registration'
  const mock = { rows: [tournament(T, 'Gulmi Cup', setupStep), tournament(T2, 'Hill Cup', 0), done], calls: [], down: false }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) =>
    route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') return json(route, mock.rows)
    if (path === '/rest/v1/format_preset') return json(route, [FUTSAL])
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    const row = a.season_id ? mock.rows.flatMap((t) => t.season).find((s) => s.id === a.season_id) : mock.rows.find((t) => t.id === a.tournament_id)
    if (row && cmd !== 'set_setup_step') {
      row.version++
      for (const [k, v] of Object.entries(a)) if (k in row && v != null && k !== 'version') row[k] = v
    }
    return json(route, { ok: true, code: null, message: 'Done.', ...(row ? { version: row.version } : {}) })
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  if (blockTabStorage) {
    await context.addInitScript(() => {
      const get = Storage.prototype.getItem
      const set = Storage.prototype.setItem
      Storage.prototype.getItem = function (k) { if (String(k).startsWith('tsl-tab:')) throw new Error('blocked'); return get.call(this, k) }
      Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('tsl-tab:')) throw new Error('blocked'); return set.call(this, k, v) }
    })
  }
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, mock, page }
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
const tab = (page, name) => page.getByRole('tab', { name, exact: true })
const selected = async (page) => page.getByRole('tab', { selected: true }).textContent()
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const noScroll = async (page, w) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), w, `horizontal scroll at ${w}px`)

try {
  // --- Open home: App bar (logo circle, name, Season line, icon buttons), three equal tabs with Matches selected,
  // "Continue setup" on Matches, no Save status while nothing is pending. My tournaments' card opens it.
  {
    const { context, page } = await fresh()
    await page.goto(base + '/')
    await button(page, 'Open Gulmi Cup').click()
    await page.waitForURL((u) => u.pathname === `/t/${T}`)
    const bar = page.locator('header.home-bar')
    await bar.getByRole('heading', { name: 'Gulmi Cup' }).waitFor()
    assert.equal((await bar.locator('summary').textContent()).trim(), 'Season 1 · Setup ▾')
    const logo = await bar.locator('.home-logo').evaluate((el) => [el.getBoundingClientRect().width, getComputedStyle(el).borderRadius, el.textContent])
    assert.deepEqual([logo[0], logo[2]], [32, 'G'], 'logo not a 32px initial')
    assert.ok(parseFloat(logo[1]) >= 16, 'logo not round')
    await bar.getByRole('button', { name: 'Open settings', exact: true }).waitFor()
    await bar.getByRole('button', { name: 'Back to My tournaments', exact: true }).waitFor()
    assert.equal(await page.locator('.save-bar').count(), 1, 'more than one Save status')
    assert.ok(await page.locator('.home-bar .save-bar-empty').count(), 'Save status shown with nothing pending')
    assert.equal(await page.getByRole('tab').count(), 3)
    assert.equal(await selected(page), 'Matches')
    assert.deepEqual(await page.getByRole('tab').evaluateAll((ts) => ts.map((t) => t.getAttribute('aria-selected'))), ['true', 'false', 'false'])
    const look = await page.getByRole('tab').evaluateAll((ts) => ts.map((t) => {
      const s = getComputedStyle(t)
      return [Math.round(t.getBoundingClientRect().width), s.fontWeight, s.boxShadow !== 'none']
    }))
    assert.ok(look.every(([w]) => Math.abs(w - look[0][0]) <= 1), 'tabs not equal')
    assert.deepEqual(look.map(([, w, u]) => [w, u]), [['800', true], ['600', false], ['600', false]], 'tab weights or underline')
    const panel = page.getByRole('tabpanel')
    await panel.getByText('Setup of Season 1 is at step 4 of 7.', { exact: true }).waitFor()
    await panel.getByRole('button', { name: 'Continue setup' }).waitFor()
    // Season switcher opens and says what it holds.
    await bar.locator('summary').click()
    await bar.getByText("Season 1 is this Tournament's current Season.", { exact: true }).waitFor()
    await noScroll(page, 390)
    // Phone: the Tab bar sits right under the App bar.
    const [hb, tb] = [await bar.boundingBox(), await page.getByRole('tablist').boundingBox()]
    assert.ok(tb.y >= hb.y + hb.height && tb.y - (hb.y + hb.height) < 32, 'Tab bar not under the App bar')
    await panel.getByRole('button', { name: 'Continue setup' }).click()
    await page.waitForURL((u) => u.pathname === `/t/${T}/setup/4`)
    await page.goto(base + `/t/${T}`)
    await bar.getByRole('button', { name: 'Back to My tournaments' }).click()
    await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
    // Registration open: the Matches tab says what comes next, no setup.
    await button(page, 'Open Done Cup').click()
    await page.getByRole('tabpanel').getByText('Record the draw once registration closes.', { exact: true }).waitFor()
    assert.equal(await button(page, 'Continue setup').count(), 0, 'Continue setup after setup')
    await context.close()
  }

  // --- Remember tab per Tournament, keyboard tabs (roving focus), Matches default for another Tournament.
  {
    const { context, page } = await fresh()
    await page.goto(base + `/t/${T}`)
    await tab(page, 'Teams').click()
    await page.getByText('Add your Teams to send each one its Registration link.', { exact: true }).waitFor()
    await page.reload()
    await tab(page, 'Teams').waitFor()
    assert.equal(await selected(page), 'Teams', 'tab not remembered')
    assert.deepEqual(await page.getByRole('tab').evaluateAll((ts) => ts.map((t) => t.tabIndex)), [-1, 0, -1], 'roving tabindex')
    await tab(page, 'Teams').focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await selected(page), 'Graphics')
    assert.ok(await tab(page, 'Graphics').evaluate((el) => el === document.activeElement), 'ArrowRight did not move focus')
    await page.keyboard.press('ArrowRight')
    assert.equal(await selected(page), 'Matches', 'ArrowRight did not wrap')
    await page.keyboard.press('End')
    assert.equal(await selected(page), 'Graphics')
    await page.keyboard.press('Home')
    assert.equal(await selected(page), 'Matches')
    await page.keyboard.press('ArrowLeft')
    assert.equal(await selected(page), 'Graphics', 'ArrowLeft did not wrap')
    await page.goto(base + `/t/${T2}`)
    await tab(page, 'Matches').waitFor()
    assert.equal(await selected(page), 'Matches', 'another Tournament did not start on Matches')
    await context.close()
  }

  // --- Storage blocked: the home still opens on Matches and tabs still switch.
  {
    const { context, page } = await fresh({ blockTabStorage: true })
    await page.goto(base + `/t/${T}`)
    await tab(page, 'Matches').waitFor()
    assert.equal(await selected(page), 'Matches')
    await tab(page, 'Graphics').click()
    assert.equal(await selected(page), 'Graphics')
    await context.close()
  }

  // --- Settings edit: the section is the wizard step without Next; a changed number sends only itself, no
  // set_setup_step; an invalid one says why and isn't sent; Back returns to the Settings list.
  {
    const { context, mock, page } = await fresh()
    await page.goto(base + `/t/${T}`)
    await button(page, 'Open settings').click()
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
    const list = await page.locator('.home-list .ui-button').allTextContents()
    assert.deepEqual(list, ['Change name and logo', 'Change description and rules', 'Change dates', 'Change Format', 'Change Line-up rules',
      'Change Structure'])
    await page.locator('.home-list .card', { hasText: 'Sponsors' }).getByText('Adding Sponsors comes in the next update.').waitFor()
    await button(page, 'Change Structure').click()
    await page.getByRole('heading', { name: 'Settings · Structure' }).waitFor()
    assert.equal(await button(page, 'Next').count(), 0, 'Next shown in Settings')
    // A table needs a Structure: pick League (saved on change), then edit points.
    await page.getByRole('radio', { name: 'League' }).check()
    const win = page.getByLabel('Points for a win', { exact: true })
    await win.fill('12')
    await win.press('Tab')
    await page.getByText('Use a whole number from 0 to 9.', { exact: true }).waitFor()
    await win.fill('4')
    await win.press('Tab')
    await until(page, () => calls(mock, 'set_structure').length === 2, 'points not sent')
    const sent = calls(mock, 'set_structure').map(({ command_id: _c, cmd: _n, season_id: _s, expected_version: _v, ...x }) => x)
    assert.deepEqual(sent, [{ structure: 'league' }, { points_win: 4 }])
    await button(page, 'Back to settings').click()
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
    await page.waitForTimeout(300)
    assert.equal(calls(mock, 'set_setup_step').length, 0, 'Settings sent set_setup_step')
    assert.equal(calls(mock, 'set_structure').length, 2, 'Back resent')
    // The wizard step shows the same values.
    await page.goto(base + `/t/${T}/settings/structure`)
    assert.equal(await page.getByLabel('Points for a win', { exact: true }).inputValue(), '4')
    await button(page, 'Back to settings').click()
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
    // Every section's Back returns to Settings, sending no step.
    for (const [label, heading] of [['Change name and logo', 'Name & logo'], ['Change Format', 'Format'], ['Change Line-up rules', 'Line-up rules'],
      ['Change dates', 'Dates']]) {
      await button(page, label).click()
      await page.getByRole('heading', { name: `Settings · ${heading}` }).waitFor()
      await button(page, 'Back to settings').click()
      await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
    }
    assert.equal(calls(mock, 'set_setup_step').length, 0, 'a section sent set_setup_step')
    // Opened from the list, a section's Back steps back in history, so the browser's Back never reopens a section.
    await page.goBack()
    await until(page, () => !/\/settings\/\w/.test(new URL(page.url()).pathname), 'browser Back reopened a section')
    await page.goto(base + `/t/${T}/settings`)
    await button(page, 'Back to tournament home').click()
    await page.waitForURL((u) => u.pathname === `/t/${T}`)
    await context.close()
  }

  // --- Section past progress: setup at step 1, Settings → Line-up rules opens (no redirect to step 1). Enter in the
  // Tournament name in Settings neither navigates nor sends a step; leaving it saves the name.
  {
    const { context, mock, page } = await fresh({ setupStep: 1 })
    await page.goto(base + `/t/${T}/settings/lineup`)
    await page.getByRole('heading', { name: 'Settings · Line-up rules' }).waitFor()
    assert.equal(await page.getByLabel('Starters', { exact: true }).inputValue(), '', 'no preset picked yet: no default')
    assert.equal(new URL(page.url()).pathname, `/t/${T}/settings/lineup`)
    await page.goto(base + `/t/${T}/settings/name`)
    const name = page.getByLabel('Tournament name')
    await name.waitFor()
    await name.fill('Gulmi Gold Cup')
    await name.press('Enter')
    await name.press('Tab')
    await until(page, () => calls(mock, 'set_tournament_branding').length === 1, 'name not saved')
    assert.equal(new URL(page.url()).pathname, `/t/${T}/settings/name`, 'Enter navigated')
    assert.equal(calls(mock, 'set_setup_step').length, 0, 'Enter sent a step')
    assert.equal(calls(mock, 'set_tournament_branding')[0].name, 'Gulmi Gold Cup')
    await page.goto(base + `/t/${T}/settings/sponsors`)
    await page.waitForURL((u) => u.pathname === `/t/${T}/settings`)
    await context.close()
  }

  // --- Pending change: offline edits in Settings sections; the Save status shows once, on the section page and inside the
  // App bar of the Settings list and of the home. The home opens offline from its last read, with the queued name.
  {
    const { context, mock, page } = await fresh()
    await page.goto(base + `/t/${T}`)
    await page.getByRole('tab', { name: 'Matches' }).waitFor()
    await button(page, 'Open settings').click()
    await button(page, 'Change description and rules').click()
    await page.getByLabel('Rules', { exact: true }).waitFor()
    await context.setOffline(true)
    mock.down = true
    await page.getByLabel('Rules', { exact: true }).fill('Fair play.')
    await page.getByLabel('Rules', { exact: true }).press('Tab')
    const waiting = (n) => `Offline · ${n} ${n === 1 ? 'change' : 'changes'} waiting to send. They'll send when the signal is back.`
    await page.locator('.save-bar').getByText(waiting(1), { exact: true }).waitFor()
    assert.equal(await page.locator('.save-bar').count(), 1, 'Save status not once on a section')
    await button(page, 'Back to settings').click()
    await page.locator('header.home-bar .save-bar').getByText(waiting(1), { exact: true }).waitFor()
    assert.equal(await page.locator('.save-bar').count(), 1, 'Save status twice on Settings')
    await button(page, 'Change name and logo').click()
    await page.getByLabel('Tournament name').fill('Gulmi Offline Cup')
    await page.getByLabel('Tournament name').press('Tab')
    await button(page, 'Back to settings').click()
    await button(page, 'Back to tournament home').click()
    await page.locator('header.home-bar .save-bar').getByText(waiting(2), { exact: true }).waitFor()
    assert.equal(await page.locator('.save-bar').count(), 1, 'Save status twice on home')
    await page.locator('header.home-bar').getByRole('heading', { name: 'Gulmi Offline Cup' }).waitFor()
    await tab(page, 'Matches').waitFor()
    mock.down = false
    await context.setOffline(false)
    await until(page, () => calls(mock, 'set_season_rules').length > 0, 'rules not sent')
    await context.close()
  }

  // --- Unknown id: not a UUID or not on the server; offline first load says why and offers to try again.
  {
    const { context, mock, page } = await fresh()
    for (const p of ['/t/not-a-uuid', '/t/22222222-0000-4000-8000-000000000007', '/t/not-a-uuid/settings', '/t/22222222-0000-4000-8000-000000000007/settings',
      '/t/22222222-0000-4000-8000-000000000007/settings/dates']) {
      await page.goto(base + p)
      await page.getByText("This tournament isn't available.", { exact: true }).waitFor()
    }
    await page.goto(base + '/')
    await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
    await context.setOffline(true)
    mock.down = true
    await page.evaluate((t) => history.pushState({}, '', `/t/${t}`), T)
    await page.evaluate(() => dispatchEvent(new PopStateEvent('popstate')))
    await page.getByText("Can't reach the server. Check your signal and try again.", { exact: true }).waitFor({ timeout: 15000 })
    mock.down = false
    await context.setOffline(false)
    await button(page, 'Try loading again').click()
    await page.getByRole('tab', { name: 'Matches' }).waitFor()
    await context.close()
  }

  // --- Widths: tablet lists in two columns; laptop content at most 960px, centred; no horizontal scroll anywhere.
  {
    const { context, page } = await fresh({ viewport: { width: 800, height: 900 } })
    await page.goto(base + `/t/${T}/settings`)
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
    const [a, b] = await page.locator('.home-list > li').evaluateAll((ls) => ls.slice(0, 2).map((l) => l.getBoundingClientRect().toJSON()))
    assert.ok(Math.abs(a.y - b.y) < 1 && b.x > a.x, 'tablet: not two columns')
    await noScroll(page, 800)
    await page.setViewportSize({ width: 390, height: 844 })
    const [c, d] = await page.locator('.home-list > li').evaluateAll((ls) => ls.slice(0, 2).map((l) => l.getBoundingClientRect().toJSON()))
    assert.ok(d.y > c.y, 'phone: not one column')
    await noScroll(page, 390)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(base + `/t/${T}`)
    await tab(page, 'Matches').waitFor()
    const box = await page.locator('main.home').boundingBox()
    assert.ok(box.width <= 960, `content ${box.width}px wide`)
    assert.ok(Math.abs(box.x - (1280 - box.x - box.width)) <= 1, 'content not centred')
    await noScroll(page, 1280)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
