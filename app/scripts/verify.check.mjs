// Story 2.7 scan viewer check: an Organiser opens a Submitted Team, taps "View document" on a Player card and sees the
// scan inside the card (about 144px, file name, alt "[document type] for [Player], uploaded [date]"), taps it for full
// resolution with two-finger zoom inside the card (no new page or pop-up), with the document number and "Mark verified";
// verifying sends verify_eligibility and the card collapses to the saved-green "Verified" line and pill. A scan that
// can't be signed says so; a paper record without a scan can be verified. (The Team manager never sees the viewer:
// check:eligibility.) Real Chrome, Supabase mocked by route interception. `npm run check:verify`.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const TEAM = '55555555-0000-4000-8000-000000000001'
const P1 = '91111111-0000-4000-8000-000000000001'
const P2 = '91111111-0000-4000-8000-000000000002'
const R1 = 'b1111111-0000-4000-8000-000000000001'
const R2 = 'b1111111-0000-4000-8000-000000000002'
const SCAN = `${T}/${TEAM}/${P1}/c2111111-0000-4000-8000-000000000001.webp`
const outDir = 'node_modules/.verify-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4193 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email: 'org@example.com', exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'org@example.com', email_confirmed_at: '2026-11-08T00:00:00Z',
    app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}
// An 800×1000 scan: full resolution is wider than the phone.
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#ddd"/></svg>'

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/** A signed-in Organiser of T with a Submitted Team: Bisho (EMIS record with a scan) and Gita (paper record, no scan). */
async function fresh() {
  const season = { id: S, number: 1, status: 'registration', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
    starts_on: '2026-11-07', ends_on: '2026-11-21', registration_deadline: '2026-11-03', starters: 2, max_bench: 1, staff_roles: ['manager', 'coach'] }
  const mock = {
    records: [
      { id: R1, player_id: P1, document_type: 'emis', document_number: '430010248', scan_name: 'emis-bisho.jpg', scan_path: SCAN,
        scan_uploaded_at: '2026-11-09T06:00:00Z', verified_at: null, version: 3 },
      { id: R2, player_id: P2, document_type: 'birth_certificate', document_number: '12-34', scan_name: null, scan_path: null,
        scan_uploaded_at: null, verified_at: null, version: 1 },
    ],
    calls: [], answers: {}, signs: [], signFail: 0,
  }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 }, hasTouch: true })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data, s = 200) => route.fulfill({ status: s, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/storage/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = decodeURIComponent(new URL(req.url()).pathname.replace('/storage/v1/object/sign/eligibility-scans/', ''))
    if (req.method() === 'POST') {
      mock.signs.push({ path, ...JSON.parse(req.postData() ?? '{}') })
      if (mock.signFail) return (mock.signFail--, json(route, { statusCode: '400', error: 'not_found', message: 'Object not found' }, 400))
      return json(route, { signedURL: `/object/sign/eligibility-scans/${path}?token=t` })
    }
    return route.fulfill({ status: 200, headers: cors, contentType: 'image/svg+xml', body: svg })
  })
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    }
    if (path === '/rest/v1/team') {
      return json(route, [{ id: TEAM, name: 'Paper Sheet FC', code: 'PSF', kit_colour: null, status: 'submitted', version: 2, registration_link: [],
        tournament: { name: 'Gulmi Cup' }, season }])
    }
    if (path === '/rest/v1/squad_entry') {
      return json(route, [[P1, 'Bisho Basnet', 4], [P2, 'Gita Rana', 5]].map(([id, name, shirt]) => ({ team_id: TEAM, shirt_number: shirt,
        player: { id, name, date_of_birth: '1990-01-01', version: 1, photo_path: null, is_cutout: null, photo_consent: [] } })))
    }
    if (path === '/rest/v1/eligibility_record') return json(route, mock.records)
    if (path === '/rest/v1/staff' || path === '/rest/v1/sponsor') return json(route, [])
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    const a = JSON.parse(req.postData() ?? '{}')
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    const given = mock.answers[cmd]?.shift()
    if (given) return json(route, given)
    if (cmd === 'verify_eligibility') {
      const r = mock.records.find((x) => x.player_id === a.player_id)
      Object.assign(r, { verified_at: '2026-11-11T05:00:00Z', version: r.version + 1 })
      return json(route, { ok: true, code: null, message: 'Verified.', version: r.version })
    }
    return json(route, { ok: true, code: null, message: 'Done.' })
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${base}/t/${T}/teams/${TEAM}`)
  await page.getByText('Players · 2', { exact: true }).waitFor()
  return { context, mock, page }
}

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const card = (page, name) => page.locator('details.squad-card', { hasText: name })
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}

try {
  // --- View, full resolution with pinch-zoom inside the card, then Mark verified: the card collapses to Verified.
  {
    const { context, mock, page } = await fresh()
    const c = card(page, 'Bisho Basnet')
    await c.locator('summary').click()
    assert.equal(await button(c, 'Mark verified').count(), 0, 'Mark verified before the scan was viewed')
    const url = page.url()
    await button(c, 'View document').click()
    const img = c.locator('.scan-figure img')
    await img.waitFor()
    assert.deepEqual(mock.signs, [{ path: SCAN, expiresIn: 300 }], 'scan not signed for five minutes')
    assert.match(await img.getAttribute('alt'), /^EMIS number for Bisho Basnet, uploaded Kartik 23, 2083 BS \(9 Nov 2026\)$/)
    await until(page, () => img.evaluate((i) => i.complete && i.naturalWidth > 0), 'scan not loaded')
    assert.equal(Math.round((await img.boundingBox()).height), 144, 'scan not about 144px')
    await c.locator('.scan-figure figcaption').getByText('emis-bisho.jpg', { exact: true }).waitFor()
    await c.getByText('430010248', { exact: true }).waitFor()
    // Full resolution inside the card: same page, no dialog, scrolls in its box; the page never scrolls sideways.
    await button(c, 'Show the document at full resolution').click()
    await until(page, async () => Math.round((await img.boundingBox()).width) === 800, 'not full resolution')
    const box = c.locator('.scan-zoom')
    assert.equal(await box.evaluate((b) => getComputedStyle(b).overflow + '|' + getComputedStyle(b).touchAction), 'auto|pan-x pan-y')
    assert.ok(await box.evaluate((b) => b.closest('details.squad-card') !== null), 'full scan outside the card')
    assert.equal(page.url(), url, 'viewer opened a page')
    assert.equal(await page.getByRole('dialog').count(), 0, 'viewer opened a pop-up')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
    // Two fingers spread apart: the scan grows inside its box.
    const b = await box.boundingBox()
    const cx = b.x + b.width / 2
    const cy = b.y + Math.min(b.height, 300) / 2
    const cdp = await context.newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }] })
    for (const d of [45, 60, 75, 90]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - d, y: cy }, { x: cx + d, y: cy }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await until(page, async () => (await img.boundingBox()).width > 1200, 'pinch did not zoom the scan')
    assert.equal(await page.evaluate(() => visualViewport.scale), 1, 'pinch zoomed the page')
    // Mark verified: versioned on the record; the card says what was kept, in saved green, with the pill.
    await button(c, 'Mark verified').click()
    await until(page, async () => calls(mock, 'verify_eligibility').length === 1, 'verify_eligibility not sent')
    const v = calls(mock, 'verify_eligibility')[0]
    assert.deepEqual([v.team_id, v.player_id, v.expected_version], [TEAM, P1, 3])
    const done = c.getByText('Verified. Scan deleted; EMIS number kept.', { exact: true })
    await done.waitFor()
    const saved = await page.evaluate(() => {
      const d = document.createElement('i')
      d.style.color = 'var(--saved)'
      document.body.append(d)
      return getComputedStyle(d).color
    })
    assert.equal(await done.evaluate((x) => getComputedStyle(x).color), saved, 'not saved green')
    await c.locator('.ui-pill').getByText('Verified', { exact: true }).waitFor()
    assert.equal(await c.locator('.eligibility').locator('.scan-figure, select, input').count(), 0, 'scan or inputs left after verifying')
    assert.equal(await button(c, 'View document').count(), 0)
    await context.close()
  }

  // --- A scan that can't be signed says so in the card; a paper record without a scan is verified from its number.
  {
    const { context, mock, page } = await fresh()
    mock.signFail = 1
    const c = card(page, 'Bisho Basnet')
    await c.locator('summary').click()
    await button(c, 'View document').click()
    await c.getByText("Couldn't open the document. Check the signal, then tap View document again.", { exact: true }).waitFor()
    await button(c, 'View document').click()
    await c.locator('.scan-figure img').waitFor()
    const g = card(page, 'Gita Rana')
    await g.locator('summary').click()
    assert.equal(await button(g, 'View document').count(), 0)
    await g.getByText('12-34', { exact: true }).waitFor()
    mock.answers.verify_eligibility = [{ ok: false, code: 'document_incomplete', message: 'Add the document type and number first.' }]
    await button(g, 'Mark verified').click()
    await g.getByText('Add the document type and number first.', { exact: true }).waitFor()
    await button(g, 'Mark verified').click()
    await g.getByText('Verified. Scan deleted; Birth certificate number kept.', { exact: true }).waitFor()
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
