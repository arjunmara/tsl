// Story 3.5 start check: the Start card (ready, needs approval with Team links, Draw incomplete, unpublished), the Confirm sheet and its
// focus, the start, offline, a refused start, the card gone and the Settings lock after start. Real Chrome, Supabase mocked by route interception.
// `npm run check:start`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const outDir = 'node_modules/.start-dist'
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
const teamRow = (n, status) => ({ id: tid(n), name: `Team ${n}`, code: `T0${n}`, kit_colour: '#1d4ed8', status, registration_link: [], version: 1 })
const ready = { ready: true, teams: [], reason: 'Ready to start: 8 Teams approved, Draw recorded.' }

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/** mock.check: what start_check answers; mock.started: the Season's status flips on start_season; mock.refuse: a start_blocked answer. */
async function fresh({ check = ready, status = 'registration' } = {}) {
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
    if (path === '/rest/v1/tournament') {
      const season = { id: S, number: 7, status: mock.status, setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
        starts_on: '2033-11-07', ends_on: '2033-11-21', registration_deadline: '2033-11-03', structure: 'knockout', group_count: 2, teams_per_group: 4, qualifiers_per_group: 2 }
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    }
    if (path === '/rest/v1/team') return json(route, [1, 2, 3].map((n) => teamRow(n, 'approved')))
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/rpc/start_check') return json(route, mock.check)
    if (path === '/rest/v1/season') return json(route, [{ fixtures_published_at: '2026-11-12T00:00:00Z' }])
    if (!req.postData()) return json(route, [])
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    if (cmd !== 'start_season') return json(route, { ok: true, code: null, message: 'ok' })
    if (mock.refuse) return json(route, mock.refuse)
    mock.status = 'started'
    return json(route, { ok: true, code: null, message: 'The tournament has started.' })
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
const starts = (mock) => mock.calls.filter((c) => c.cmd === 'start_season')

try {
  // --- Blocked rows: the reason in words, the button disabled, Teams linked.
  for (const [reason, codes] of [
    ["Can't start yet: no Teams approved.", []],
    ["Can't start yet: 1 Team still needs approval (T01)", ['T01']],
    ["Can't start yet: 2 Teams aren't in the Draw (T02, T03)", ['T02', 'T03']],
    ["Can't start yet: publish the Fixtures first.", []],
  ]) {
    const { context, page } = await fresh({ check: { ready: false, reason, teams: codes.map((c) => ({ id: tid(Number(c.slice(2))), code: c })) } })
    const card = page.locator('.start-card [role="status"]')
    await card.getByText(reason, { exact: false }).waitFor()
    assert.equal((await card.innerText()).replace(/\s+/g, ' '), reason)
    assert.equal(await button(page, 'Start tournament').isDisabled(), true, reason)
    assert.equal(await card.getAttribute('aria-live'), 'polite')
    assert.equal(await card.locator('a').count(), codes.length)
    for (const c of codes) assert.equal(await card.getByRole('link', { name: c, exact: true }).getAttribute('href'), `/t/${T}/teams/${tid(Number(c.slice(2)))}`)
    await context.close()
  }
  // --- A Team link opens its page.
  {
    const { context, page } = await fresh({ check: { ready: false, reason: "Can't start yet: 1 Team still needs approval (T01)", teams: [{ id: tid(1), code: 'T01' }] } })
    await page.getByRole('link', { name: 'T01', exact: true }).click()
    await page.waitForURL(`**/t/${T}/teams/${tid(1)}`)
    await context.close()
  }
  // --- Ready: Confirm sheet; Cancel keeps registration and returns focus to the button.
  {
    const { context, mock, page } = await fresh()
    await text(page, ready.reason).waitFor()
    await button(page, 'Start tournament').click()
    const sheet = page.getByRole('dialog', { name: 'Start Season 7?' })
    await sheet.waitFor()
    assert.match(await sheet.innerText(), /Registration\s*→\s*(to\s*)?Started/)
    await sheet.getByText("Teams and the Draw lock and you can't go back to registration.", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H2', 'focus on the title')
    await button(page, 'Cancel').click()
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Start tournament')
    assert.equal(starts(mock).length, 0)
    assert.equal(mock.status, 'registration')
    // Offline: no button, and the reason in words.
    await context.setOffline(true)
    await text(page, 'Starting the tournament needs a signal.').waitFor()
    assert.equal(await button(page, 'Start tournament').count(), 0)
    await context.setOffline(false)
    // Start: one command; the card goes and the status reads Started.
    await button(page, 'Start tournament').click()
    await button(page, 'Start').click()
    await page.locator('.start-card').waitFor({ state: 'detached' })
    assert.equal(starts(mock).length, 1)
    await page.getByText('Season 7 · Started').waitFor()
    // Settings: the setup sections say why they are locked and their fields are disabled.
    await page.getByRole('button', { name: 'Open settings' }).click()
    await page.getByRole('button', { name: 'Change dates' }).click()
    await text(page, "This can't change once the season has started.").waitFor()
    assert.ok(await page.locator('fieldset[disabled] input').count() > 0, 'dates are disabled')
    await context.close()
  }
  // --- A refused start is said with the server's reason.
  {
    const { context, mock, page } = await fresh()
    mock.refuse = { ok: false, code: 'start_blocked', message: "Can't start yet: 1 Team still needs approval (T01)" }
    await button(page, 'Start tournament').click()
    await button(page, 'Start').click()
    await page.getByRole('alert').getByText("Can't start yet: 1 Team still needs approval (T01)").waitFor()
    assert.equal(mock.status, 'registration')
    await context.close()
  }
  // --- Started Season: no card.
  {
    const { context, page } = await fresh({ status: 'started' })
    await page.getByText('Season 7 · Started').waitFor()
    assert.equal(await page.locator('.start-card').count(), 0)
    await context.close()
  }
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
