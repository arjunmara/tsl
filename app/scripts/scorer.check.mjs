// Story 4.1 Scorer check: a phone opens /score#<token> (Turnstile, anonymous sign-in under its own key, label, number, waiting),
// the Organiser's Settings -> Scorers polls and shows three number buttons; right number approves, wrong rejects, expiry, revoke,
// dead link, deep link for an anonymous session. Real Chrome, Supabase mocked by route interception. `npm run check:scorer`.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ORG = '00000000-0000-4000-8000-000000000001'
const ANON = '00000000-0000-4000-8000-0000000000a1'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const outDir = 'node_modules/.scorer-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4197 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')
const sha = (t) => createHash('sha256').update(t).digest('hex')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session(id, anonymous) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const email = anonymous ? '' : 'org@example.com'
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, email, exp, role: 'authenticated', aud: 'authenticated', is_anonymous: anonymous })}.sig`
  const user = { id, aud: 'authenticated', role: 'authenticated', email, is_anonymous: anonymous, app_metadata: {}, user_metadata: {},
    identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z', ...(anonymous ? {} : { email_confirmed_at: '2026-11-08T00:00:00Z' }) }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: `rt-${id}`, user }
}
const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/** One shared fake server (mock) used by an Organiser context and a phone context. */
const mock = { linked: null, devices: [], calls: [], nextNumber: 47, signups: 0, deadLink: false }
async function ctx({ organiser }) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  await context.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({
    contentType: 'text/javascript', body: `window.turnstile = { render(el, o) { setTimeout(() => o.callback('tok')); return 'w' }, remove() {} }`,
  }))
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (new URL(req.url()).pathname === '/auth/v1/signup') mock.signups++
    return json(route, organiser ? session(ORG, false) : session(ANON, true))
  })
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1,
        season: [{ id: S, number: 1, status: 'registration', setup_step: 7, version: 1 }] }])
    }
    if (path === '/rest/v1/season') return json(route, [{ scorer_token_hash: mock.linked || null }])
    if (path === '/rest/v1/scorer_device') {
      return json(route, mock.devices.map((d) => ({ id: d.id, label: d.label, status: d.status, expires_at: d.expires_at, number_hash: sha(`${d.id}:${d.number}`) })))
    }
    const a = JSON.parse(req.postData() ?? '{}')
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    if (cmd === 'scorer_status') {
      return json(route, mock.devices.filter((d) => d.user === ANON).reverse().map((d) => ({ id: d.id, season_id: S, label: d.label, expires_at: d.expires_at,
        status: d.status === 'pending' && Date.parse(d.expires_at) <= Date.now() ? 'expired' : d.status })))
    }
    if (cmd === 'scorer_matches') return json(route, [])
    if (cmd === 'request_scorer_approval') {
      if (mock.deadLink || !mock.linked || a.token !== TOKEN) return json(route, { ok: false, code: 'link_dead', message: 'No.' })
      for (const d of mock.devices) if (d.user === ANON && d.status === 'pending') d.status = 'rejected'
      const d = { id: `33333333-0000-4000-8000-${String(mock.devices.length + 1).padStart(12, '0')}`, label: a.label, status: 'pending', user: ANON,
        number: mock.nextNumber, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() }
      mock.devices.push(d)
      return json(route, { ok: true, code: null, status: 'pending', device_id: d.id, number: d.number, expires_at: d.expires_at })
    }
    if (cmd === 'create_scorer_link') return (mock.linked = a.token_hash, json(route, { ok: true, code: null, message: 'made' }))
    if (cmd === 'revoke_scorer_link') return (mock.linked = null, json(route, { ok: true, code: null, message: 'ok' }))
    if (cmd === 'approve_scorer_device') {
      const d = mock.devices.find((x) => x.id === a.device_id)
      if (Date.parse(d.expires_at) <= Date.now()) return json(route, { ok: false, code: 'request_expired', message: 'No.' })
      if (d.number !== a.number) return (d.status = 'rejected', json(route, { ok: false, code: 'number_mismatch', message: 'No.' }))
      d.status = 'approved'
      return json(route, { ok: true, code: null, message: 'ok' })
    }
    if (cmd === 'revoke_scorer_device') return (mock.devices.find((x) => x.id === a.device_id).status = 'revoked', json(route, { ok: true, code: null, message: 'ok' }))
    return json(route, { ok: true, code: null, message: 'ok' })
  })
  if (organiser) await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session(ORG, false)))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, page }
}
const text = (page, t) => page.getByText(t, { exact: true })
const button = (page, name) => page.getByRole('button', { name, exact: true })
const calls = (name) => mock.calls.filter((c) => c.cmd === name)

try {
  const org = await ctx({ organiser: true })
  const phone = await ctx({ organiser: false })
  const op = org.page
  const pp = phone.page

  // Create the link: share sheet with the link, "Revoke Scorer link" listed.
  await op.goto(`${base}/t/${T}/settings/scorers`)
  await text(op, 'No Scorer link works yet.').waitFor()
  await button(op, 'Create Scorer link').click()
  await text(op, 'Scorer link made. Any older link no longer works for new requests.').waitFor()
  const link = await op.locator('#scorer-link').inputValue()
  assert.match(link, new RegExp(`/score#[A-Za-z0-9_-]{43}$`))
  await button(op, 'Share Scorer link').waitFor()
  await button(op, 'Revoke Scorer link').waitFor()
  assert.equal(calls('create_scorer_link')[0].token_hash.length, 64)

  // Phone: dead link first (token not the live one), then the real one.
  await pp.goto(`${base}/score#${'B'.repeat(43)}`)
  await pp.getByLabel('Name this phone').fill("Bikash's phone")
  await button(pp, 'Ask for approval').click()
  await text(pp, 'This link no longer works. Ask the organiser for a new one.').waitFor()
  mock.linked = sha(TOKEN)
  await pp.goto(`${base}/score#${TOKEN}`)
  await pp.getByLabel('Name this phone').fill("Bikash's phone")
  assert.equal(mock.signups, 1)
  await button(pp, 'Ask for approval').click()
  assert.equal(await pp.getByTestId('score-number').innerText(), '47')
  await text(pp, 'Waiting for the organiser to approve this phone.').waitFor()
  await text(pp, 'Expires in 10 min').waitFor()
  assert.equal(await pp.locator('a, nav, [role="tab"]').count(), 0, 'navigation on the Scorer page')
  assert.deepEqual(await pp.evaluate(() => Object.keys(localStorage).filter((k) => /auth/.test(k))), ['tsl-score-auth'])

  // Organiser: the prompt appears by polling, three 64px buttons "Approve N" with the right one among them.
  const names = async () => (await op.getByRole('button', { name: /^Approve \d\d$/ }).allTextContents())
  for (const t = Date.now(); (await names()).length !== 3; await op.waitForTimeout(100)) if (Date.now() - t > 9000) assert.fail('prompt not shown')
  assert.ok((await names()).includes('47'))
  const box = await op.getByRole('button', { name: 'Approve 47' }).boundingBox()
  assert.ok(box.height >= 64, `number button ${box.height}px`)
  // A wrong number rejects; the phone shows Ask again.
  const wrong = (await names()).find((n) => n !== '47')
  await op.getByRole('button', { name: `Approve ${wrong}` }).click()
  await text(op, "That number didn't match. Ask them to send a new request.").waitFor()
  await pp.getByRole('button', { name: /^Ask again/ }).waitFor({ timeout: 9000 })
  // Ask again: new number, approve it.
  mock.nextNumber = 63
  await pp.getByRole('button', { name: /^Ask again/ }).click()
  await pp.getByLabel('Name this phone').fill("Bikash's phone")
  await button(pp, 'Ask for approval').click()
  assert.equal(await pp.getByTestId('score-number').innerText(), '63')
  await op.getByRole('button', { name: 'Approve 63' }).waitFor({ timeout: 9000 })
  await op.getByRole('button', { name: 'Approve 63' }).click()
  await text(pp, 'No Match to score yet.').waitFor({ timeout: 9000 })
  await button(op, "Revoke Bikash's phone").waitFor()

  // Expiry: the request goes stale; the phone says so and offers Ask again.
  mock.nextNumber = 21
  const old = mock.devices.at(-1)
  old.status = 'approved'
  const stale = { ...old, id: '33333333-0000-4000-8000-0000000000ff', user: ANON, status: 'pending', number: 21, label: 'Late phone', expires_at: new Date(Date.now() - 1000).toISOString() }
  mock.devices.push(stale)
  const keep = (id) => pp.evaluate(([k, v]) => localStorage.setItem(k, v), [`tsl-scorer-device:${TOKEN}`, id])
  await keep(stale.id)
  await pp.reload()
  await text(pp, 'This request expired.').waitFor()
  await pp.getByRole('button', { name: /^Ask again/ }).waitFor()
  mock.devices.pop()
  await keep(old.id)

  // Revoke the device: the phone's next poll shows the dead-link words.
  await pp.reload()
  await text(pp, 'No Match to score yet.').waitFor()
  await button(op, "Revoke Bikash's phone").click()
  await op.getByRole('dialog').getByRole('button', { name: "Revoke Bikash's phone" }).click()
  await text(pp, 'This link no longer works. Ask the organiser for a new one.').waitFor({ timeout: 9000 })

  // Revoke the link.
  await button(op, 'Revoke Scorer link').click()
  await op.getByRole('dialog').getByRole('button', { name: 'Revoke Scorer link' }).click()
  await text(op, 'No Scorer link works yet.').waitFor()

  // Deep link: an anonymous session on another route sees nothing, with no navigation.
  const deep = await browser.newContext({ serviceWorkers: 'block' })
  await deep.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  await deep.route(`${SUPA}/**`, (r) => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: cors })
    : r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(session(ANON, true)) }))
  await deep.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session(ANON, true)))
  const dp = await deep.newPage()
  await dp.goto(`${base}/t/${T}`)
  await text(dp, "This tournament isn't available.").waitFor().catch(async () => {
    assert.equal(await dp.locator('button, a, nav').count(), 0, `buttons on the Unavailable screen: ${await dp.locator('main').innerText()}`)
  })
  assert.equal(await dp.locator('button, a, nav').count(), 0, 'navigation for an anonymous session')
  await deep.close()
  await org.context.close()
  await phone.context.close()
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
