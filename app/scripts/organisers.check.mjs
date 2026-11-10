// Story 1.14 co-organisers check: Settings → Co-organisers (invite, share, cancel, remove, leave) and the invite page
// (/invite/:token: signed out, unverified, accept, refusals) in real Chrome, every UI row of the spec's I/O matrix.
// Supabase is mocked by route interception; each command is recorded and answered from mock.answers (default ok).
// The app is built with a fake Supabase URL into node_modules/.organisers-dist. `npm run check:organisers`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const SITA = '00000000-0000-4000-8000-000000000002'
const T = '22222222-0000-4000-8000-000000000001'
const TOK = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const outDir = 'node_modules/.organisers-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_TURNSTILE_SITE_KEY
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4186 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session(verified = true) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const email = 'org@example.com'
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email, exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: verified ? '2026-11-08T00:00:00Z' : null,
    app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}
const tournament = {
  id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1,
  season: [{ id: '22222222-0000-4000-8000-000000000009', number: 1, status: 'setup', setup_step: 7, version: 1 }],
}
const inFuture = new Date(Date.now() + 14 * 864e5).toISOString()

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/**
 * A context signed in as org@example.com (signedIn: false = no session; verified: false = unverified). mock.calls: every
 * command body (cmd: its name); mock.answers[cmd]: answers to give, in order; mock.down: Supabase unreachable.
 */
async function fresh({ signedIn = true, verified = true, share = 'none' } = {}) {
  const mock = {
    organisers: [{ user_id: ME, email: 'org@example.com', created_at: '2026-11-01T00:00:00Z' },
      { user_id: SITA, email: 'sita@example.com', created_at: '2026-11-02T00:00:00Z' }],
    invites: [{ id: '33333333-0000-4000-8000-000000000001', email: 'ram@example.com', token: TOK.replace('A', 'Z'), expires_at: inFuture }],
    answers: {}, calls: [], down: false, inviteQuery: null,
  }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS' || req.url().includes('/logout')) return route.fulfill({ status: 204, headers: cors })
    return json(route, session(verified))
  })
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') return json(route, [tournament])
    if (path === '/rest/v1/organiser_invite') return (mock.inviteQuery = new URL(req.url()).searchParams, json(route, mock.invites))
    if (path === '/rest/v1/sponsor') return json(route, [])
    if (path === '/rest/v1/rpc/organisers') return json(route, mock.organisers)
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    const given = mock.answers[cmd]?.shift()
    if (given) return json(route, given)
    const extra = cmd === 'invite_organiser' ? { token: TOK } : cmd === 'accept_invite' ? { tournament_id: T } : {}
    return json(route, { ok: true, code: null, message: 'Done.', ...extra })
  })
  if (signedIn) await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session(verified)))
  // share: 'record' = a Web Share API that records what it was given; 'none' = no Web Share API (clipboard fallback).
  await context.addInitScript((mode) => {
    if (mode === 'record') navigator.share = async (d) => void (window.__shared = d)
    else delete Navigator.prototype.share
  }, share)
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, mock, page }
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
const text = (page, t) => page.getByText(t, { exact: true })
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const noScroll = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
const kept = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('tsl-invite') ?? 'null')?.token ?? null)
const refused = (code) => ({ ok: false, code, message: 'No.' })
const outbox = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('tsl-outbox')
  r.onsuccess = () => {
    const q = r.result.transaction('entries').objectStore('entries').getAll()
    q.onsuccess = () => res(q.result.map((e) => [e.name, e.state, e.code ?? null]))
  }
}))

try {
  // --- Invite: Settings → "Manage co-organisers"; Organisers and invites waiting listed; " Sita@X.Test " is sent in
  // lower case; the link shows as selectable text and "Share invite link" hands it to the Web Share API.
  {
    const { context, mock, page } = await fresh({ share: 'record' })
    await page.goto(base + `/t/${T}/settings`)
    await button(page, 'Manage co-organisers').click()
    await page.waitForURL((u) => u.pathname === `/t/${T}/settings/co-organisers`)
    await page.getByRole('heading', { name: 'Co-organisers', level: 1 }).waitFor()
    await text(page, 'org@example.com (you)').waitFor()
    await text(page, 'sita@example.com').waitFor()
    await text(page, 'ram@example.com').waitFor()
    await page.getByText(/^Link works until \w+day · .+ BS \(.+\)$/).waitFor()
    await button(page, 'Remove organiser sita@example.com').waitFor()
    await button(page, 'Leave this tournament').waitFor()
    await button(page, 'Share invite link for ram@example.com').waitFor()
    await button(page, 'Cancel invite for ram@example.com').waitFor()
    // Only pending invites are asked for: not accepted, not cancelled, not expired.
    const qy = mock.inviteQuery
    assert.deepEqual([qy.get('tournament_id'), qy.get('accepted_at'), qy.get('cancelled_at')], [`eq.${T}`, 'is.null', 'is.null'])
    assert.ok(Math.abs(Date.parse(qy.get('expires_at').replace(/^gt\./, '')) - Date.now()) < 60000, 'expiry not filtered at now')
    // Empty email: says why, sends nothing.
    await button(page, 'Send invite').click()
    await text(page, 'Add the email to invite.').waitFor()
    assert.equal(calls(mock, 'invite_organiser').length, 0)
    await page.getByLabel('Their email').fill(' Sita@X.Test ')
    await button(page, 'Send invite').click()
    const link = page.getByLabel('Invite link for sita@x.test')
    await link.waitFor()
    assert.equal(await link.inputValue(), `${base}/invite/${TOK}`)
    const [sent] = calls(mock, 'invite_organiser')
    assert.equal(sent.email, 'sita@x.test')
    assert.equal(sent.tournament_id, T)
    assert.match(sent.invite_id, /^[0-9a-f-]{36}$/)
    assert.equal(await page.getByLabel('Their email').inputValue(), '', 'email field not cleared')
    await button(page, 'Share invite link').click()
    await until(page, () => page.evaluate(() => !!window.__shared), 'nothing shared')
    assert.equal((await page.evaluate(() => window.__shared)).url, `${base}/invite/${TOK}`)
    await noScroll(page)
    await button(page, 'Back to settings').click()
    await page.waitForURL((u) => u.pathname === `/t/${T}/settings`)
    await context.close()
  }

  // --- No Web Share API: the link is copied to the clipboard and the page says so. Refusals show in words beside the
  // form and leave nothing queued.
  {
    const { context, mock, page } = await fresh()
    await page.goto(base + `/t/${T}/settings/co-organisers`)
    await button(page, 'Share invite link for ram@example.com').click()
    await text(page, 'Invite link copied. Paste it in a message to ram@example.com.').waitFor()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${base}/invite/${TOK.replace('A', 'Z')}`)
    for (const [code, words] of [['already_organiser', 'That person already organises this tournament.'],
      ['already_invited', 'That email already has an invite waiting. Share its link from the list below.'],
      ['email_invalid', "That email address doesn't look right. Check it, then send the invite again."]]) {
      mock.answers.invite_organiser = [refused(code)]
      await page.getByLabel('Their email').fill('sita@example.com')
      await button(page, 'Send invite').click()
      await page.locator('form').getByRole('alert').getByText(words, { exact: true }).waitFor()
    }
    assert.equal(await page.getByLabel(/^Invite link for/).count(), 0, 'link shown after a refusal')
    await until(page, async () => (await outbox(page)).length === 0, 'refused invite left in the outbox')
    await context.close()
  }

  // --- Cancel invite and remove an Organiser go through a Confirm sheet that opens on Cancel; last_organiser in words.
  {
    const { context, mock, page } = await fresh()
    await page.goto(base + `/t/${T}/settings/co-organisers`)
    await button(page, 'Cancel invite for ram@example.com').click()
    const sheet = page.getByRole('dialog', { name: 'Cancel the invite for ram@example.com?' })
    await sheet.waitFor()
    assert.ok(await sheet.getByRole('button', { name: 'Cancel', exact: true }).evaluate((el) => el === document.activeElement), 'sheet not on Cancel')
    await sheet.getByRole('button', { name: 'Cancel invite', exact: true }).click()
    await text(page, 'The invite for ram@example.com is cancelled. Its link no longer works.').waitFor()
    assert.deepEqual(calls(mock, 'cancel_invite').map((c) => [c.invite_id, c.tournament_id]), [['33333333-0000-4000-8000-000000000001', T]])
    mock.organisers = mock.organisers.slice(0, 1)
    await button(page, 'Remove organiser sita@example.com').click()
    const rm = page.getByRole('dialog', { name: 'Remove sita@example.com?' })
    await rm.getByText('sita@example.com organises this tournament', { exact: false }).waitFor()
    assert.ok(await rm.getByRole('button', { name: 'Cancel', exact: true }).evaluate((el) => el === document.activeElement), 'sheet not on Cancel')
    await rm.getByRole('button', { name: 'Remove organiser', exact: true }).click()
    await text(page, 'sita@example.com no longer organises this tournament.').waitFor()
    assert.deepEqual(calls(mock, 'remove_organiser').map((c) => [c.user_id, c.tournament_id]), [[SITA, T]])
    await until(page, async () => (await text(page, 'sita@example.com').count()) === 0, 'removed Organiser still listed')
    // Alone: leaving is refused with last_organiser.
    mock.answers.remove_organiser = [refused('last_organiser')]
    await button(page, 'Leave this tournament').click()
    await page.getByRole('dialog', { name: 'Leave this tournament?' }).getByRole('button', { name: 'Leave this tournament', exact: true }).click()
    await page.getByRole('alert').getByText('A tournament needs at least one organiser.', { exact: true }).waitFor()
    assert.equal(new URL(page.url()).pathname, `/t/${T}/settings/co-organisers`)
    // Leaving with another Organiser: ok, back to My tournaments.
    await button(page, 'Leave this tournament').click()
    await page.getByRole('dialog', { name: 'Leave this tournament?' }).getByRole('button', { name: 'Leave this tournament', exact: true }).click()
    await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
    assert.equal(calls(mock, 'remove_organiser').at(-1).user_id, ME)
    await context.close()
  }

  // --- Removed: a queued change comes back not_authorized and waits in the hand-back sheet; the page itself is gone.
  {
    const { context, mock, page } = await fresh()
    await page.goto(base + `/t/${T}/settings/co-organisers`)
    await text(page, 'sita@example.com').waitFor()
    mock.down = true
    await context.setOffline(true)
    await page.getByLabel('Their email').fill('hari@example.com')
    await button(page, 'Send invite').click()
    await page.getByText(/^Can't reach the server\. .*The invite will be made when the signal is back/).waitFor()
    mock.answers.invite_organiser = [refused('not_authorized')]
    mock.organisers = []
    mock.invites = []
    mock.down = false
    await context.setOffline(false)
    await button(page, 'Review this change').waitFor({ timeout: 15000 })
    assert.deepEqual(await outbox(page), [['invite_organiser', 'failed', 'not_authorized']])
    await button(page, 'Review this change').click()
    await page.getByRole('dialog').getByText("Only this tournament's organisers can change it.", { exact: false }).waitFor()
    await page.getByRole('dialog').getByText('Invite hari@example.com to organise the tournament', { exact: false }).first().waitFor()
    await page.keyboard.press('Escape')
    await text(page, "This tournament isn't available.").waitFor()
    await context.close()
  }

  // --- Signed out: the invite asks to sign in or sign up, and signing in later comes back to it.
  {
    const { context, mock, page } = await fresh({ signedIn: false })
    await page.goto(base + `/invite/${TOK}`)
    await page.getByRole('heading', { name: 'Help run a tournament' }).waitFor()
    await button(page, 'Create an account to accept the invite').waitFor()
    await button(page, 'Sign in to accept the invite').click()
    await page.waitForURL((u) => u.pathname === '/sign-in')
    assert.equal(await kept(page), TOK)
    await page.evaluate((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
    await page.goto(base + '/')
    await page.waitForURL((u) => u.pathname === `/invite/${TOK}`)
    await text(page, 'org@example.com').waitFor()
    await until(page, async () => (await kept(page)) === null, 'kept invite not dropped')
    await button(page, 'Accept this invite').click()
    await page.waitForURL((u) => u.pathname === `/t/${T}`)
    assert.deepEqual(calls(mock, 'accept_invite').map((c) => c.token), [TOK])
    // My tournaments no longer sends back to the invite.
    await page.goto(base + '/')
    await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
    await page.waitForTimeout(300)
    assert.equal(new URL(page.url()).pathname, '/')
    await context.close()
  }

  // --- Unverified: the invite is kept and the person verifies first.
  {
    const { context, page } = await fresh({ verified: false })
    await page.goto(base + `/invite/${TOK}`)
    await page.waitForURL((u) => u.pathname === '/check-email')
    await until(page, async () => (await kept(page)) === TOK, 'invite not kept')
    // Still unverified, My tournaments doesn't bounce back to the invite (and so to "Check your email").
    await page.goto(base + '/')
    await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
    await page.waitForTimeout(300)
    assert.equal(new URL(page.url()).pathname, '/')
    await context.close()
  }

  // --- A kept invite older than a day is dropped, not followed.
  {
    const { context, page } = await fresh()
    await page.addInitScript((t) => localStorage.setItem('tsl-invite', JSON.stringify({ token: t, at: Date.now() - 2 * 864e5 })), TOK)
    await page.goto(base + '/')
    await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
    await page.waitForTimeout(300)
    assert.equal(new URL(page.url()).pathname, '/')
    assert.equal(await kept(page), null)
    await context.close()
  }

  // --- Refusals on accept say so in words and grant nothing; a different email offers to switch account.
  {
    const { context, mock, page } = await fresh()
    for (const [code, words] of [['invite_wrong_email', 'This invite is for a different email.'],
      ['invite_used', 'This invite has already been used. Ask for a new invite if you need one.'],
      ['invite_cancelled', 'This invite was cancelled. Ask for a new invite if you need one.'],
      ['invite_expired', 'This invite has expired. Ask for a new invite.'],
      ['invite_missing', "This invite link doesn't work. Ask for a new invite."]]) {
      mock.answers.accept_invite = [refused(code)]
      await page.goto(base + `/invite/${TOK}`)
      await button(page, 'Accept this invite').click()
      await page.getByRole('alert').getByText(words, { exact: true }).waitFor()
      assert.equal(new URL(page.url()).pathname, `/invite/${TOK}`)
      assert.equal(await button(page, 'Sign out to use another account').count(), code === 'invite_wrong_email' ? 1 : 0)
      await button(page, 'Open My tournaments').waitFor()
    }
    await until(page, async () => (await outbox(page)).length === 0, 'refused accept left in the outbox')
    mock.answers.accept_invite = [refused('invite_wrong_email')]
    await page.goto(base + `/invite/${TOK}`)
    await button(page, 'Accept this invite').click()
    await button(page, 'Sign out to use another account').click()
    await page.waitForURL((u) => u.pathname === '/sign-in')
    await until(page, async () => (await kept(page)) === TOK, 'invite not kept after switching account')
    // A malformed token never reaches the server.
    await page.goto(base + '/invite/short')
    await text(page, "This invite link doesn't work. Ask for a new invite.").waitFor()
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
