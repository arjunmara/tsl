// Story 1.5 auth check: every row of the spec's I/O matrix in real Chrome against vite preview,
// plus Story 1.6's create-tournament UI rows. Supabase /auth/v1/*, /rest/v1/* and Turnstile are mocked by route interception; the app is built for this check
// with a fake Supabase URL into node_modules/.auth-dist. `npm run check:auth`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

// Only domain imports Supabase.
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
const leaks = walk('src').filter((f) => !f.startsWith(join('src', 'domain')) && readFileSync(f, 'utf8').includes('@supabase'))
assert.deepEqual(leaks, [], '@supabase imported outside src/domain')

const SUPA = 'https://fake.supabase.co'
const SITE_KEY = '1x00000000000000000000AA' // Cloudflare's always-passes test key
const outDir = 'node_modules/.auth-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: SITE_KEY })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })

const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4181 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')
const STORAGE_KEY = 'sb-fake-auth-token'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const user = (email, confirmed) => ({
  id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email,
  email_confirmed_at: confirmed ? '2026-11-08T00:00:00Z' : null, app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z',
})
function session(email, { confirmed = true, expired = false } = {}) {
  const exp = Math.floor(Date.now() / 1000) + (expired ? -60 : 3600)
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user(email).id, email, exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user: user(email, confirmed) }
}

const browser = await chromium.launch({ channel: 'chrome' })
let calls = []
const called = (path) => calls.filter((c) => c.path === path)

/** A fresh context: Supabase and Turnstile mocked, optional stored session and init script. */
// rpc(body): the create_tournament answer, 'offline' to drop the request or 500; default ok.
// listRead(): 'error' (HTTP 500) or 'offline' for that tournament list read; default the list.
// seed: tournaments already in the list.
async function fresh({ stored, refreshDelay = 0, init, offlineVerifies = 0, rpc, listRead, seed = [] } = {}) {
  calls = []
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  // Turnstile: renders nothing; window.__pass() completes the check with token "tok".
  await context.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: `window.turnstile = { render(el, o) { window.__sitekey = o.sitekey; window.__pass = () => o.callback('tok'); return 'w' }, remove() { window.__pass = undefined } }`,
  }))
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
  await context.route(`${SUPA}/auth/v1/**`, async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const url = new URL(req.url())
    const path = url.pathname.replace('/auth/v1', '') + (url.searchParams.get('grant_type') ? `?${url.searchParams.get('grant_type')}` : '')
    const body = req.postData() ? JSON.parse(req.postData()) : {}
    calls.push({ path, body, url: req.url() })
    if (path === '/verify' && offlineVerifies-- > 0) return route.abort('internetdisconnected')
    const json = (status, data) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
    const bad = (code, msg, status = 400) => json(status, { code: status, error_code: code, msg })
    switch (path) {
      case '/signup': return json(200, body.email === 'taken@example.com' ? { ...user(body.email, true), identities: [] } : user(body.email, false))
      case '/resend':
      case '/recover': return body.gotrue_meta_security?.captcha_token ? json(200, {}) : bad('captcha_failed', 'captcha protection: request disallowed')
      case '/verify':
        if (body.token === '123456' || body.token_hash === 'good') return json(200, session(body.email ?? 'link@example.com'))
        return bad('otp_expired', 'Token has expired or is invalid', 403)
      case '/token?password':
        if (!body.gotrue_meta_security?.captcha_token) return bad('captcha_failed', 'captcha protection: request disallowed')
        if (body.email === 'unverified@example.com') return bad('email_not_confirmed', 'Email not confirmed')
        if (body.password === 'right-password') return json(200, session(body.email))
        return bad('invalid_credentials', 'Invalid login credentials')
      case '/token?refresh_token':
        await new Promise((r) => setTimeout(r, refreshDelay))
        return json(200, session('stored@example.com'))
      case '/user': return json(200, user(body.email ?? 'stored@example.com', true))
      case '/logout': return route.fulfill({ status: 204, headers: cors })
      default: return bad('unexpected_failure', `unmocked ${path}`, 500)
    }
  })
  // The app schema: create_tournament adds to the list the tournament read returns.
  const tournaments = [...seed]
  await context.route(`${SUPA}/rest/v1/**`, async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    const body = req.postData() ? JSON.parse(req.postData()) : {}
    calls.push({ path, body, url: req.url(), headers: req.headers() })
    const json = (data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
    const boom = () => route.fulfill({ status: 500, headers: cors, contentType: 'application/json', body: '{"code":"XX000","message":"boom"}' })
    if (path === '/rest/v1/tournament') {
      const r = listRead?.()
      if (r === 'offline') return route.abort('internetdisconnected')
      return r === 'error' ? boom() : json(tournaments)
    }
    if (path === '/rest/v1/rpc/create_tournament') {
      const r = rpc?.(body) ?? { ok: true, code: null, message: 'Tournament created.' }
      if (r === 'offline') return route.abort('internetdisconnected')
      if (r === 500) return boom()
      if (r.ok) tournaments.unshift({ id: body.tournament_id, name: body.name, season: [{ number: 1, status: 'setup' }] })
      return json(r)
    }
    return route.fulfill({ status: 500, headers: cors, body: `unmocked ${path}` })
  })
  if (stored) await context.addInitScript(([k, v]) => localStorage.setItem(k, v), [STORAGE_KEY, JSON.stringify(stored)])
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, page }
}

const path = (page) => new URL(page.url()).pathname
const waitPath = (page, p) => page.waitForURL((u) => u.pathname === p, { timeout: 5000 })
const button = (page, name) => page.getByRole('button', { name, exact: true })
/** Completes the (mocked) Turnstile check of the widget currently mounted. */
async function pass(page) {
  await page.waitForFunction(() => typeof window.__pass === 'function')
  await page.evaluate(() => window.__pass())
}
const sentToken = (p) => called(p).at(-1)?.body.gotrue_meta_security?.captcha_token
const alertText = async (page) => (await page.getByRole('alert').textContent()).trim()

async function signedIn(email = 'org@example.com', opts) {
  const { context, page } = await fresh({ stored: session(email), ...opts })
  await page.goto(base + '/')
  await page.getByText('No tournaments yet.').waitFor()
  return { context, page }
}

try {
  // --- Sign up without captcha: Primary disabled with the reason. Then sign up.
  {
    const { context, page } = await fresh()
    await page.goto(base + '/sign-up')
    const email = page.getByLabel('Email')
    const password = page.getByLabel('Password')
    assert.equal(await email.getAttribute('autocomplete'), 'email')
    assert.equal(await password.getAttribute('autocomplete'), 'new-password')
    assert.equal(await password.getAttribute('type'), 'password')
    await email.fill('new@example.com')
    await password.fill('long-enough-1')
    const create = button(page, 'Create account')
    await page.waitForFunction(() => typeof window.__pass === 'function')
    assert.equal(await page.evaluate(() => window.__sitekey), SITE_KEY, 'Turnstile site key')
    assert.ok(await create.isDisabled(), 'no captcha: Primary enabled')
    const reasonId = await create.getAttribute('aria-describedby')
    assert.equal((await page.locator(`[id="${reasonId}"]`).textContent()).trim(), 'Complete the check above.')

    await page.evaluate(() => window.__pass())
    assert.ok(await create.isEnabled(), 'captcha done: Primary still disabled')
    await create.click()
    await waitPath(page, '/check-email')
    const [signup] = called('/signup')
    assert.equal(signup.body.email, 'new@example.com')
    assert.equal(signup.body.gotrue_meta_security?.captcha_token, 'tok', 'signUp without captchaToken')
    assert.equal(new URL(signup.url).searchParams.get('redirect_to'), base + '/auth/callback', 'email redirect')

    // Check your email: one OTP field, the link works equally.
    assert.match(await page.locator('main').textContent(), /new@example\.com/)
    assert.match(await page.locator('main').textContent(), /link in the same email\. Either one works/)
    const code = page.getByLabel('Code')
    assert.equal(await code.getAttribute('autocomplete'), 'one-time-code')
    assert.equal(await code.getAttribute('inputmode'), 'numeric')
    assert.equal(await page.locator('input:not([type="hidden"])').count(), 1, 'one OTP field only')

    // Wrong/expired OTP: words + Send a new code.
    await code.fill('000000')
    await button(page, 'Verify email').click()
    await page.getByRole('alert').waitFor()
    assert.equal(await alertText(page), "That code didn't work or has expired.")
    await pass(page)
    await button(page, 'Send a new code').click()
    await page.getByText('We sent a new code to new@example.com.').waitFor()
    assert.equal(sentToken('/resend'), 'tok', 'resend without captcha token')
    const [resend] = called('/resend')
    assert.deepEqual([resend.body.type, resend.body.email], ['signup', 'new@example.com'], 'resend')

    // Correct OTP: verified as signup, lands on My tournaments.
    await code.fill('123456')
    await button(page, 'Verify email').click()
    await waitPath(page, '/')
    await page.getByText('No tournaments yet.').waitFor()
    const verify = called('/verify').at(-1)
    assert.deepEqual([verify.body.type, verify.body.token, verify.body.email], ['signup', '123456', 'new@example.com'])
    assert.ok(await button(page, 'Create new tournament').isVisible(), 'empty state Primary')
    await context.close()
  }

  // --- Email link: verified, lands on /. Invalid link: words + Send a new code.
  {
    const { context, page } = await fresh()
    await page.goto(base + '/auth/callback?token_hash=good&type=signup')
    await waitPath(page, '/')
    await page.getByText('No tournaments yet.').waitFor()
    assert.deepEqual([called('/verify')[0].body.token_hash, called('/verify')[0].body.type], ['good', 'signup'])
    await page.evaluate(() => localStorage.clear())
    await page.goto(base + '/auth/callback?token_hash=bad&type=signup')
    await page.getByRole('alert').waitFor()
    assert.equal(await alertText(page), "That link didn't work or has expired.")
    await button(page, 'Send a new code').click()
    await waitPath(page, '/check-email')
    await context.close()
  }

  // --- Sign in: wrong credentials, then unverified email.
  {
    const { context, page } = await fresh()
    await page.goto(base + '/sign-in')
    assert.equal(await page.getByLabel('Password').getAttribute('autocomplete'), 'current-password')
    await page.getByLabel('Email').fill('org@example.com')
    await page.getByLabel('Password').fill('wrong-password')
    const signInButton = button(page, 'Sign in')
    assert.ok(await signInButton.isDisabled(), 'sign in enabled before the robot check')
    const why = await signInButton.getAttribute('aria-describedby')
    assert.equal((await page.locator(`[id="${why}"]`).textContent()).trim(), "Checking you're not a robot…")
    await pass(page)
    await signInButton.click()
    await page.getByRole('alert').waitFor()
    assert.equal(await alertText(page), 'Email or password is wrong.')
    assert.equal(sentToken('/token?password'), 'tok', 'sign in without captcha token')

    await page.getByLabel('Email').fill('unverified@example.com')
    await pass(page)
    await button(page, 'Sign in').click()
    await waitPath(page, '/check-email')
    assert.match(await page.locator('main').textContent(), /unverified@example\.com/, 'email not kept')
    await context.close()
  }

  // --- Unverified session reaches /new: redirect to Check your email.
  {
    const { context, page } = await fresh({ stored: session('half@example.com', { confirmed: false }) })
    await page.goto(base + '/new')
    await waitPath(page, '/check-email')
    assert.match(await page.locator('main').textContent(), /half@example\.com/)
    await context.close()
  }

  // --- Signed out: / and /new go to /sign-in.
  {
    const { context, page } = await fresh()
    for (const p of ['/', '/new']) {
      await page.goto(base + p)
      await waitPath(page, '/sign-in')
    }
    await context.close()
  }

  // --- Recovery by OTP: email, wrong code, then code + new password.
  {
    const { context, page } = await fresh()
    await page.goto(base + '/forgot-password')
    await page.getByLabel('Email').fill('org@example.com')
    await pass(page)
    await button(page, 'Email me a reset code').click()
    await waitPath(page, '/reset-password')
    assert.equal(called('/recover')[0].body.email, 'org@example.com')
    assert.equal(sentToken('/recover'), 'tok', 'reset request without captcha token')
    assert.equal(new URL(called('/recover')[0].url).searchParams.get('redirect_to'), base + '/auth/callback')
    await page.getByLabel('Code').fill('000000')
    await page.getByLabel('New password').fill('brand-new-pass')
    await button(page, 'Save new password').click()
    await page.getByRole('alert').waitFor()
    assert.equal(await alertText(page), "That code didn't work or has expired.")
    await pass(page)
    await button(page, 'Send a new code').click()
    await page.getByText('We sent a new code to org@example.com.').waitFor()
    assert.equal(called('/recover').length, 2, 'Send a new code did not request a new reset')

    await page.getByLabel('Code').fill('123456')
    await page.getByLabel('New password').fill('brand-new-pass')
    await button(page, 'Save new password').click()
    await waitPath(page, '/')
    assert.deepEqual([called('/verify').at(-1).body.type, called('/user').at(-1).body.password], ['recovery', 'brand-new-pass'])
    await context.close()
  }

  // --- Recovery by link: /reset-password with only the new password.
  {
    const { context, page } = await fresh()
    await page.goto(base + '/auth/callback?token_hash=good&type=recovery')
    await waitPath(page, '/reset-password')
    assert.equal(await page.getByLabel('Code').count(), 0, 'link recovery asks for a code')
    await page.getByLabel('New password').fill('brand-new-pass')
    await button(page, 'Save new password').click()
    await waitPath(page, '/')
    assert.equal(called('/user').at(-1).body.password, 'brand-new-pass')
    await context.close()
  }

  // --- Loading: skeleton cards with aria-busy while the session resolves.
  {
    const { context, page } = await fresh({ stored: session('stored@example.com', { expired: true }), refreshDelay: 1500 })
    await page.goto(base + '/')
    const busy = page.locator('[aria-busy="true"]')
    await busy.waitFor()
    assert.equal(await busy.locator('.skeleton-card').count(), 3, 'skeleton cards')
    await page.getByText('No tournaments yet.').waitFor()
    assert.equal(await busy.count(), 0, 'still busy after loading')
    await context.close()
  }

  // --- Create a tournament: field checks, then the command, then the card on My tournaments.
  {
    const { context, page } = await signedIn()
    const rpcCalls = () => called('/rest/v1/rpc/create_tournament')
    await button(page, 'Create new tournament').click()
    await waitPath(page, '/new')
    const create = button(page, 'Create tournament')
    await create.click()
    await page.getByText('Tournament name is required.').waitFor()
    await page.getByLabel('Tournament name').fill('x'.repeat(81))
    await create.click()
    await page.getByText('Use 80 characters or fewer.').waitFor()
    assert.equal(rpcCalls().length, 0, 'invalid name sent')
    await page.getByLabel('Tournament name').fill('  Gulmi Cup ')
    await create.click()
    await waitPath(page, '/')
    const card = page.locator('.card')
    await card.waitFor()
    assert.equal((await card.textContent()).replace(/\s+/g, ' ').trim(), 'Gulmi CupSeason 1 · Setup')
    assert.equal(await card.locator('.ui-pill-pending').textContent(), 'Setup')
    const [rpc] = rpcCalls()
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    assert.deepEqual(Object.keys(rpc.body).sort(), ['command_id', 'name', 'season_id', 'tournament_id'])
    for (const k of ['command_id', 'season_id', 'tournament_id']) assert.match(rpc.body[k], uuid, k)
    assert.equal(rpc.body.name, 'Gulmi Cup')
    assert.equal(rpc.headers['content-profile'], 'app', 'command not sent to the app schema')
    assert.equal(called('/rest/v1/tournament').at(-1).headers['accept-profile'], 'app', 'read not from the app schema')
    assert.ok(await button(page, 'Create new tournament').isVisible(), 'no way to create another')
    await context.close()
  }

  // --- Create refused: offline keeps the same command (no double create); a code shows its text.
  {
    const answers = ['offline', { ok: false, code: 'email_not_verified', message: 'Not allowed.' }]
    const { context, page } = await signedIn('org@example.com', { rpc: () => answers.shift() })
    await page.goto(base + '/new')
    await page.getByLabel('Tournament name').fill('Gulmi Cup')
    await button(page, 'Create tournament').click()
    await page.getByRole('alert').waitFor()
    assert.equal(await alertText(page), "Can't reach the server. Check your signal and try again.")
    await button(page, 'Create tournament').click()
    await page.getByText('Verify your email first, then try again.').waitFor()
    assert.equal(await alertText(page), 'Verify your email first, then try again.')
    assert.equal(path(page), '/new')
    // After a definite refusal, the next try is a new command with new ids.
    await button(page, 'Create tournament').click()
    await waitPath(page, '/')
    const [first, second, third] = called('/rest/v1/rpc/create_tournament').map((c) => c.body)
    assert.deepEqual(second, first, 'offline retry changed the command')
    for (const k of ['command_id', 'tournament_id', 'season_id']) assert.notEqual(third[k], second[k], `${k} reused after a refusal`)
    await context.close()
  }

  // --- Create hits a server error: unknown text; the retry may have run, so it reuses the ids.
  {
    const answers = [500]
    const { context, page } = await signedIn('org@example.com', { rpc: () => answers.shift() })
    await page.goto(base + '/new')
    await page.getByLabel('Tournament name').fill('Gulmi Cup')
    await button(page, 'Create tournament').click()
    await page.getByRole('alert').waitFor()
    assert.equal(await alertText(page), 'Something went wrong. Try again.')
    await button(page, 'Create tournament').click()
    await waitPath(page, '/')
    const [first, second] = called('/rest/v1/rpc/create_tournament').map((c) => c.body)
    assert.deepEqual(second, first, 'retry after a server error changed the command')
    await context.close()
  }

  // --- List read fails: words, Try loading again, Create still there; back online reloads it.
  {
    const reads = ['error']
    const { context, page } = await fresh({ stored: session('org@example.com'), listRead: () => reads.shift() })
    await page.goto(base + '/')
    await page.getByRole('alert').waitFor()
    assert.equal(await alertText(page), "Couldn't load your tournaments. Try loading them again.")
    assert.ok(await button(page, 'Create new tournament').isVisible(), 'error: no Create')
    await button(page, 'Try loading again').click()
    await page.getByText('No tournaments yet.').waitFor()
    await context.close()
  }
  {
    // supabase-js retries a failed read 3 times (1s, 2s, 4s), so stay down until back online.
    let down = true
    const seed = [{ id: 't1', name: 'Gulmi Cup', season: [{ number: 1, status: 'setup' }] }]
    const { context, page } = await fresh({ stored: session('org@example.com'), listRead: () => (down ? 'offline' : undefined), seed })
    await page.goto(base + '/')
    await page.getByRole('alert').waitFor({ timeout: 15000 })
    assert.equal(await alertText(page), "Can't reach the server. Check your signal and try again.")
    assert.ok(await button(page, 'Create new tournament').isVisible(), 'offline: no Create')
    await context.setOffline(true)
    down = false
    await context.setOffline(false)
    await page.locator('.card').waitFor()
    assert.match(await page.locator('.card').textContent(), /Gulmi Cup/)
    assert.equal(await page.getByRole('alert').count(), 0, 'error still shown after reload')
    await context.close()
  }

  // --- Offline banner, exact text; gone when back online.
  {
    const { context, page } = await signedIn()
    const banner = "Can't reach the server. Showing what's on this phone."
    await context.setOffline(true)
    await page.getByText(banner, { exact: true }).waitFor()
    await context.setOffline(false)
    await page.getByText(banner).waitFor({ state: 'detached' })
    await context.close()
  }

  // --- Theme override: Dark on a light device survives reload before first paint; Device clears it.
  {
    const { context, page } = await signedIn()
    const theme = () => page.evaluate(() => [document.documentElement.dataset.theme ?? null, localStorage.getItem('theme')])
    await page.getByText('Account', { exact: true }).click()
    assert.ok(await page.getByText('org@example.com').isVisible(), 'account menu shows the email')
    await page.getByLabel('Dark').check()
    assert.deepEqual(await theme(), ['dark', 'dark'])
    // With the app's scripts blocked, only the inline pre-paint script can set it.
    await context.route(/\/assets\/.*\.js$/, (r) => r.abort())
    await page.reload()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'not applied before first paint')
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(10, 26, 63)')
    await context.unroute(/\/assets\/.*\.js$/)
    await page.reload()
    await page.getByText('Account', { exact: true }).click()
    assert.ok(await page.getByLabel('Dark').isChecked())
    await page.getByLabel('Same as this phone').check()
    assert.deepEqual(await theme(), [null, null])
    await context.close()
  }

  // --- Theme with storage blocked: still works for the session (sign in through the form, memory session).
  {
    const { context, page } = await fresh({
      init: () => {
        for (const m of ['getItem', 'setItem', 'removeItem']) Storage.prototype[m] = () => { throw new DOMException('blocked', 'SecurityError') }
      },
    })
    await page.goto(base + '/sign-in')
    await page.getByLabel('Email').fill('org@example.com')
    await page.getByLabel('Password').fill('right-password')
    await pass(page)
    await button(page, 'Sign in').click()
    await page.getByText('No tournaments yet.').waitFor()
    await page.getByText('Account', { exact: true }).click()
    await page.getByLabel('Dark').check()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'storage blocked: theme not applied')
    await context.close()
  }

  // --- Sign up with an already-confirmed email: says so, with Sign in and reset links.
  {
    const { context, page } = await fresh()
    await page.goto(base + '/sign-up')
    await page.getByLabel('Email').fill('taken@example.com')
    await page.getByLabel('Password').fill('long-enough-1')
    await pass(page)
    await button(page, 'Create account').click()
    await page.getByRole('alert').waitFor()
    assert.equal(await alertText(page), 'An account with this email already exists.')
    assert.equal(path(page), '/sign-up')
    assert.ok(await page.getByRole('link', { name: 'reset your password' }).isVisible())
    await context.close()
  }

  // --- Verified via the link elsewhere: "I've verified my email" refreshes and goes to /.
  {
    const { context, page } = await fresh({ stored: session('half@example.com', { confirmed: false }) })
    await page.goto(base + '/new')
    await waitPath(page, '/check-email')
    await button(page, "I've verified my email").click()
    await waitPath(page, '/')
    await context.close()
  }

  // --- A signed-in (non-recovery) session on /reset-password still needs the code.
  {
    const { context, page } = await signedIn()
    await page.goto(base + '/reset-password')
    await page.getByLabel('Code').waitFor()
    await context.close()
  }

  // --- Link while offline: Try again re-runs it. Used link while signed in and verified: /.
  {
    const { context, page } = await fresh({ offlineVerifies: 1 })
    await page.goto(base + '/auth/callback?token_hash=good&type=signup')
    await page.getByRole('alert').waitFor()
    assert.match(await alertText(page), /^Can't reach the server/)
    await button(page, 'Try the link again').click()
    await waitPath(page, '/')
    await page.getByText('No tournaments yet.').waitFor()
    await page.goto(base + '/auth/callback?token_hash=bad&type=signup')
    await waitPath(page, '/')
    await context.close()
  }

  // --- Sign out: local session cleared, /sign-in, Back does not show My tournaments.
  {
    // History: /new, then / (pushed by the link), so Back after sign-out lands on a guarded page.
    const { context, page } = await signedIn()
    await page.goto(base + '/new')
    await page.getByRole('link', { name: 'Back to My tournaments' }).click()
    await page.getByText('No tournaments yet.').waitFor()
    await page.getByText('Account', { exact: true }).click()
    await button(page, 'Sign out').click()
    await waitPath(page, '/sign-in')
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY), null, 'session still stored')
    await page.goBack()
    await page.waitForTimeout(300)
    assert.equal(path(page), '/sign-in', 'Back left /sign-in')
    assert.equal(await page.getByText('No tournaments yet.').count(), 0, 'Back shows My tournaments')
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
