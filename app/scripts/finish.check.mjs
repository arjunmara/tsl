// Story 3.8 finish check: the Finish card (blocked reason, ready), the destructive Confirm sheet and its focus, the finish, offline, a
// refused finish, the card gone, and the finished Season read-only (no Arrange, no Settings saves). Real Chrome, Supabase mocked by route interception.
// `npm run check:finish`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const outDir = 'node_modules/.finish-dist'
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
const teamRow = (n, status) => ({ id: tid(n), name: `Team ${n}`, code: `T0${n}`, kit_colour: '#1d4ed8', status, registration_link: [], version: 1 })
const ready = { ready: true, reason: 'Ready to finish: every Match is finished.' }

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/** mock.check: what finish_check answers; the Season's status flips on finish_season; mock.refuse: a finish_blocked answer. */
async function fresh({ check = ready, status = 'started' } = {}) {
  const mock = { check, status, calls: [], refuse: null }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    const season = { id: S, number: 7, status: mock.status, setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
        starts_on: '2033-11-07', ends_on: '2033-11-21', registration_deadline: '2033-11-03', structure: 'knockout', group_count: 2, teams_per_group: 4, qualifiers_per_group: 2, starters: 2, max_bench: 1, staff_roles: ['manager'] }
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    }
    if (path === '/rest/v1/team') {
      const id = new URL(req.url()).searchParams.get('id')?.replace('eq.', '')
      return json(route, [1, 2, 3].map((n) => teamRow(n, 'approved')).filter((t) => !id || t.id === id).map((t) => ({ ...t, tournament: { name: 'Gulmi Cup' }, season })))
    }
    if (path === '/rest/v1/match') return json(route, mock.status !== 'finished' ? [] : [1, 2].map((n) => ({ id: tid(90 + n), stage: 'league', round: 'Round 1', label: null, ord: n,
      home_team_id: tid(1), away_team_id: tid(2), home_src: null, away_src: null, kick_off: '2026-11-14T02:25:00Z', version: 1, status: 'finished', hg: 1, ag: 0 })))
    if (path === '/rest/v1/squad_entry') return json(route, [])
    if (path === '/rest/v1/rpc/standings' || path === '/rest/v1/rpc/match_sides') return json(route, [])
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/rpc/finish_check') return json(route, mock.check)
    if (path === '/rest/v1/season') return json(route, [{ fixtures_published_at: '2026-11-12T00:00:00Z' }])
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    if (cmd !== 'finish_season') return json(route, { ok: true, code: null, message: 'ok' })
    if (mock.refuse) return json(route, mock.refuse)
    mock.status = 'finished'
    return json(route, { ok: true, code: null, message: 'The season has finished.' })
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
const finishes = (mock) => mock.calls.filter((c) => c.cmd === 'finish_season')

try {
  // --- Blocked rows: the reason in words, the button disabled.
  for (const reason of ["Can't finish yet: 3 Matches aren't finished.", "Can't finish yet: 1 Match isn't finished."]) {
    const { context, page } = await fresh({ check: { ready: false, reason } })
    const card = page.locator('.finish-card [role="status"]')
    await card.getByText(reason, { exact: true }).waitFor()
    assert.equal(await card.getAttribute('aria-live'), 'polite')
    assert.equal(await button(page, 'Finish season').isDisabled(), true, reason)
    await context.close()
  }
  // --- Ready: destructive sheet, focus on Cancel; Cancel keeps started; offline; finish.
  {
    const { context, mock, page } = await fresh()
    await text(page, ready.reason).waitFor()
    await button(page, 'Finish season').click()
    const sheet = page.getByRole('dialog', { name: 'Finish Season 7?' })
    await sheet.waitFor()
    assert.match(await sheet.innerText(), /Started\s*→\s*(to\s*)?Finished/)
    await sheet.getByText('Squads, Fixtures and results lock for good, and eligibility scans are deleted.', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'focus on Cancel')
    await button(page, 'Cancel').click()
    assert.equal(finishes(mock).length, 0)
    assert.equal(mock.status, 'started')
    await context.setOffline(true)
    await text(page, 'Finishing the season needs a signal.').waitFor()
    assert.equal(await button(page, 'Finish season').count(), 0)
    await context.setOffline(false)
    await button(page, 'Finish season').click()
    await page.getByRole('dialog', { name: 'Finish Season 7?' }).getByRole('button', { name: 'Finish season', exact: true }).click()
    await page.locator('.finish-card').waitFor({ state: 'detached' })
    assert.equal(finishes(mock).length, 1)
    await page.getByText('Season 7 · Finished').waitFor()
    await text(page, "This can't change because the season has finished.").first().waitFor()
    // Settings: setup sections are locked, the description too.
    await page.getByRole('button', { name: 'Open settings' }).click()
    await page.getByRole('button', { name: 'Change description and rules' }).click()
    await text(page, "This can't change because the season has finished.").waitFor()
    for (const t of await page.locator('textarea').all()) assert.equal(await t.isDisabled(), true, 'rules and description are disabled')
    await context.close()
  }
  // --- A refused finish is said with the server's reason.
  {
    const { context, mock, page } = await fresh()
    mock.refuse = { ok: false, code: 'finish_blocked', message: "Can't finish yet: 1 Match isn't finished." }
    await button(page, 'Finish season').click()
    await page.getByRole('dialog', { name: 'Finish Season 7?' }).getByRole('button', { name: 'Finish season', exact: true }).click()
    await page.getByRole('alert').getByText("Can't finish yet: 1 Match isn't finished.").waitFor()
    assert.equal(mock.status, 'started')
    await context.close()
  }
  // --- Finished Season: no card, no Arrange.
  {
    const { context, page } = await fresh({ status: 'finished' })
    await page.getByText('Season 7 · Finished').waitFor()
    assert.equal(await page.locator('.finish-card').count(), 0)
    assert.equal(await button(page, 'Arrange fixtures').count(), 0)
    await context.close()
  }
  // --- Finished Season: Match page, Team page, Draw and Sponsors are read-only and say why.
  {
    const { context, page } = await fresh({ status: 'finished' })
    const why = "This can't change because the season has finished."
    await page.goto(`${base}/t/${T}/m/${tid(91)}`)
    await text(page, why).waitFor()
    assert.equal(await button(page, 'Save kick-off').count(), 0)
    await page.goto(`${base}/t/${T}/teams/${tid(1)}`)
    await text(page, why).waitFor()
    assert.equal(await page.getByRole('button', { name: /add|remove/i }).count(), 0)
    await page.goto(`${base}/t/${T}`)
    await page.getByRole('tab', { name: 'Matches' }).click()
    await text(page, why).first().waitFor()
    assert.equal(await page.getByRole('button', { name: /record the draw|place|send back/i }).count(), 0)
    await page.getByRole('button', { name: 'Open settings' }).click()
    await page.getByRole('button', { name: 'Change Sponsors' }).click()
    await text(page, why).waitFor()
    assert.equal(await button(page, 'Add a Sponsor').isDisabled(), true, 'sponsors locked')
    await context.close()
  }
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
