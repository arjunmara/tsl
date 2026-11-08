// Story 1.7 outbox check: every row of the spec's I/O matrix in real Chrome. Supabase is mocked by route
// interception; the mock RPC dedupes by command_id like the server. The app is built twice with a fake
// Supabase URL (the second build is the "new version" for the update gate) and served by a tiny static
// server whose root can be switched. `npm run check:outbox`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { chromium } from 'playwright-core'
import { build } from 'vite'
import pkg from '../package.json' with { type: 'json' }

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const OFFLINE = "Can't reach the server. Check your signal and try again."
const A = 'node_modules/.outbox-dist/a'
const B = 'node_modules/.outbox-dist/b'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_TURNSTILE_SITE_KEY
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir: A, emptyOutDir: true } })
// Any change in the bundle gives a new service worker.
process.env.VITE_APP_URL = 'https://new-version.example'
await build({ logLevel: 'silent', build: { outDir: B, emptyOutDir: true } })
delete process.env.VITE_APP_URL

let root = A
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const server = createServer((req, res) => {
  let file = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(4182, '127.0.0.1', r))
const base = 'http://127.0.0.1:4182'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const email = 'org@example.com'
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email, exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: '2026-11-08T00:00:00Z', app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/**
 * A signed-in context with mocked Supabase. The mock server applies each command_id once and returns the
 * stored result to repeats. mock.refuse: names answered name_invalid (not stored); mock.dropNext: apply the
 * next new command, then drop its response; mock.down: abort every RPC and list read; mock.next: answers for
 * the next RPCs (an HTTP status or a result), before applying; clockAhead: ms the server Date header
 * (exposed to CORS) is ahead; mock.delay: ms before each RPC answer.
 */
async function fresh({ serviceWorkers = 'block', clockAhead } = {}) {
  const mock = { calls: [], applied: new Map(), tournaments: [], refuse: new Set(), dropNext: false, down: false, delay: 0, next: [] }
  const context = await browser.newContext({ serviceWorkers })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const headers = () => clockAhead === undefined ? cors
    : { ...cors, date: new Date(Date.now() + clockAhead).toUTCString(), 'access-control-expose-headers': 'date' }
  const json = (route, data) => route.fulfill({ status: 200, headers: headers(), contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) =>
    route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') return mock.down ? route.abort('internetdisconnected') : json(route, mock.tournaments)
    if (path !== '/rest/v1/rpc/create_tournament') return route.fulfill({ status: 500, headers: cors, body: `unmocked ${path}` })
    const body = JSON.parse(req.postData())
    mock.calls.push(body)
    if (mock.down) return route.abort('internetdisconnected')
    if (mock.delay) await new Promise((r) => setTimeout(r, mock.delay))
    const special = mock.next.shift()
    if (typeof special === 'number') {
      return route.fulfill({ status: special, headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST000', message: `HTTP ${special}` }) })
    }
    if (special) return json(route, special)
    if (mock.applied.has(body.command_id)) return json(route, mock.applied.get(body.command_id))
    if (mock.refuse.has(body.name)) return json(route, { ok: false, code: 'name_invalid', message: 'Bad name.' })
    const result = { ok: true, code: null, message: 'Tournament created.' }
    mock.applied.set(body.command_id, result)
    mock.tournaments.unshift({ id: body.tournament_id, name: body.name, season: [{ number: 1, status: 'setup' }] })
    if (mock.dropNext) {
      mock.dropNext = false
      return route.abort('connectionreset')
    }
    return json(route, result)
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  return { context, mock, page: await open(context) }
}

async function open(context) {
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(base + '/')
  await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
  return page
}

// Raw IndexedDB access to the outbox (Dexie stores 'entries' with keyPath 'seq').
const idb = (page, fn, arg) => page.evaluate(async ([src, arg]) => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('tsl-outbox')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  try {
    const tx = db.transaction('entries', 'readwrite')
    const out = await new Function('store', 'arg', `return (${src})(store, arg)`)(tx.objectStore('entries'), arg)
    await new Promise((res) => (tx.oncomplete = res))
    return out
  } finally {
    db.close()
  }
}, [fn.toString(), arg])
const entries = (page) => idb(page, (store) => new Promise((res) => (store.getAll().onsuccess = (e) => res(e.target.result))))
const seed = (page, list) => idb(page, (store, list) => list.forEach((e) => store.add(e)), list)
const entry = (name, scope, actor = ME) => ({
  commandId: crypto.randomUUID(), name: 'create_tournament', scope, actor, appVersion: pkg.version,
  args: { tournament_id: crypto.randomUUID(), season_id: crypto.randomUUID(), name },
  enteredAt: new Date().toISOString(), state: 'pending', attempts: 0,
})

const button = (page, name) => page.getByRole('button', { name, exact: true })
const status = (page) => page.locator('.save-bar')
/** In-app navigation to /new (works offline). */
async function createOffline(page, name) {
  await button(page, 'Create new tournament').click()
  await page.getByLabel('Tournament name').fill(name)
  await button(page, 'Create tournament').click()
  await page.waitForURL((u) => u.pathname === '/', { timeout: 5000 })
}
// Within a minute: the offline creates wait out the list read's retries; a missed offset is 5 min off.
const near = (iso, expected, what) => assert.ok(Math.abs(Date.parse(iso) - expected) < 60000, `${what}: ${iso}`)

try {
  // --- Online send: stored, sent, deleted; Saving… then Saved then hidden.
  {
    const { context, mock, page } = await fresh()
    mock.delay = 800
    await page.goto(base + '/new')
    await page.getByLabel('Tournament name').fill('Alpha')
    await button(page, 'Create tournament').click()
    await status(page).getByText(/^Saving…/).waitFor()
    await page.waitForURL((u) => u.pathname === '/')
    await status(page).locator('[aria-live="polite"]').getByText('Saved', { exact: true }).waitFor()
    await status(page).getByText('Saved').waitFor({ state: 'detached', timeout: 6000 })
    assert.equal((await status(page).textContent()).trim(), '', 'status not hidden')
    assert.deepEqual(await entries(page), [])
    assert.equal(mock.calls.length, 1)
    await page.locator('.card', { hasText: 'Alpha' }).waitFor()
    await context.close()
  }

  // --- Offline × 3 (server clock 5 min ahead), leave warning, close, reopen online with a lost response.
  {
    const ahead = 5 * 60 * 1000
    const { context, mock, page } = await fresh({ clockAhead: ahead })
    await page.getByText('No tournaments yet.').waitFor() // a response with the Date header has arrived
    // Routed requests ignore setOffline, so the mock drops RPCs too.
    await context.setOffline(true)
    mock.down = true
    for (const name of ['One', 'Two', 'Three']) await createOffline(page, name)
    const waiting = "Offline · 3 changes waiting to send. They'll send when the signal is back."
    const live = status(page).locator('[aria-live="polite"]')
    await live.getByText(waiting, { exact: true }).waitFor()
    assert.equal(await page.locator('.card-waiting', { hasText: 'Waiting to send' }).count(), 3, 'waiting cards')
    const queued = await entries(page)
    assert.deepEqual(queued.map((e) => e.args.name), ['One', 'Two', 'Three'])
    assert.ok(queued.every((e, i) => i === 0 || e.seq > queued[i - 1].seq), 'seq order')
    for (const e of queued) {
      assert.deepEqual([e.actor, e.appVersion, e.state, e.name, e.scope], [ME, pkg.version, 'pending', 'create_tournament', e.args.tournament_id])
      near(e.enteredAt, Date.now() + ahead, 'enteredAt not server-corrected')
    }
    // Tapping the status lists the waiting changes in words.
    await live.getByRole('button').click()
    const items = await status(page).getByRole('listitem').allTextContents()
    assert.deepEqual(items, ['Create tournament ‘One’', 'Create tournament ‘Two’', 'Create tournament ‘Three’'])
    // Leave warning.
    let dialog = null
    page.on('dialog', (d) => ((dialog = d.type()), d.accept()))
    await page.close({ runBeforeUnload: true })
    await page.waitForEvent('close')
    assert.equal(dialog, 'beforeunload', 'no leave warning with changes waiting')

    await context.setOffline(false)
    mock.down = false
    mock.calls.length = 0
    mock.dropNext = true
    const page2 = await open(context)
    await status(page2).getByText('Saved', { exact: true }).waitFor({ timeout: 15000 })
    assert.deepEqual(await entries(page2), [], 'outbox not empty')
    const ids = queued.map((e) => e.commandId)
    const firstSeen = [...new Set(mock.calls.map((c) => c.command_id))]
    assert.deepEqual(firstSeen, ids, 'calls not in enqueue order / ids changed')
    assert.ok(mock.calls.filter((c) => c.command_id === ids[0]).length >= 2, 'lost response not retried')
    for (const c of mock.calls) assert.equal(c.name, queued.find((e) => e.commandId === c.command_id).args.name, 'retry changed the command')
    assert.equal(mock.applied.size, 3)
    assert.deepEqual(mock.tournaments.map((t) => t.name), ['Three', 'Two', 'One'], 'not applied exactly once each')
    await page2.locator('.card', { hasText: 'One' }).waitFor()
    assert.equal(await page2.locator('.card').count(), 3)
    await context.close()
  }

  // --- Queued create with no server Date header: offset 0; navigates to / with a Waiting card.
  {
    const { context, mock, page } = await fresh()
    await context.setOffline(true)
    mock.down = true
    await createOffline(page, 'Solo')
    await page.locator('.card-waiting', { hasText: 'Solo' }).getByText('Waiting to send').waitFor()
    // The list read fails offline (after supabase-js's own retries): the waiting card stays with the message.
    await page.locator('main').getByRole('alert').getByText(OFFLINE, { exact: true }).waitFor({ timeout: 15000 })
    assert.equal(await page.locator('.card-waiting', { hasText: 'Solo' }).count(), 1, 'waiting card hidden by the error')
    await status(page).getByText("Offline · 1 change waiting to send. They'll send when the signal is back.", { exact: true }).waitFor()
    const [e] = await entries(page)
    near(e.enteredAt, Date.now(), 'enteredAt with no Date header')
    await context.close()
  }

  // --- Refusal: entry failed, its scope stopped, other scopes continue; Try saving again re-sends it.
  {
    const { context, mock, page } = await fresh()
    const [bad, later, other] = [entry('Bad', 'S1'), entry('Later', 'S1'), entry('Other', 'S2')]
    await seed(page, [bad, later, other])
    mock.refuse.add('Bad')
    await page.close()
    const page2 = await open(context)
    const alert = status(page2).getByRole('alert')
    await alert.getByText("Couldn't save", { exact: true }).waitFor()
    for (let i = 0; i < 50 && !mock.calls.some((c) => c.name === 'Other'); i++) await page2.waitForTimeout(100)
    assert.deepEqual(mock.calls.map((c) => c.name), ['Bad', 'Other'], 'scope not stopped or other scope held')
    const stored = await entries(page2)
    assert.deepEqual(stored.map((e) => [e.args.name, e.state, e.code ?? null]), [['Bad', 'failed', 'name_invalid'], ['Later', 'pending', null]])
    await page2.locator('.card-waiting', { hasText: 'Bad' }).getByText("Couldn't save").waitFor()
    mock.refuse.clear()
    await button(page2, 'Try saving again').click()
    await status(page2).getByText('Saved', { exact: true }).waitFor()
    assert.deepEqual(mock.calls.slice(2).map((c) => c.command_id), [bad.commandId, later.commandId], 'Try again did not re-send the same entry, then the rest')
    assert.deepEqual(await entries(page2), [])
    await context.close()
  }

  // --- Other user's entries: skipped and kept.
  {
    const { context, mock, page } = await fresh()
    await seed(page, [entry('Theirs', 'S9', OTHER)])
    await page.close()
    const page2 = await open(context)
    await page2.waitForTimeout(1500)
    assert.equal(mock.calls.length, 0, "replayed another user's entry")
    assert.deepEqual((await entries(page2)).map((e) => [e.actor, e.state]), [[OTHER, 'pending']])
    await context.close()
  }

  // --- Reconnect sends at once, without waiting out the backoff.
  {
    const { context, mock, page } = await fresh()
    await context.setOffline(true)
    mock.down = true
    await createOffline(page, 'Quick')
    await page.waitForTimeout(6500) // tries at 0, 2 s and 6 s; the next is 8 s later
    const before = mock.calls.length
    mock.down = false
    const t = Date.now()
    await context.setOffline(false)
    while (mock.calls.length === before && Date.now() - t < 3000) await page.waitForTimeout(50)
    assert.ok(Date.now() - t < 1200, `reconnect took ${Date.now() - t} ms to send`)
    await status(page).getByText('Saved', { exact: true }).waitFor()
    await context.close()
  }

  // --- in_progress, then 401: kept pending and re-sent with the same command_id.
  for (const answer of [{ ok: false, code: 'in_progress', message: null }, 401]) {
    const { context, mock, page } = await fresh()
    mock.next.push(answer)
    await page.goto(base + '/new')
    await page.getByLabel('Tournament name').fill('Again')
    await button(page, 'Create tournament').click()
    await page.waitForURL((u) => u.pathname === '/')
    const [e] = await entries(page)
    assert.deepEqual([e?.state, e?.attempts], ['pending', 1], `${JSON.stringify(answer)} did not keep it pending`)
    await status(page).getByText('Saved', { exact: true }).waitFor({ timeout: 8000 })
    assert.deepEqual(mock.calls.map((c) => c.command_id), [e.commandId, e.commandId])
    assert.deepEqual(await entries(page), [])
    await context.close()
  }

  // --- A 400 on replay is a definite refusal: the entry is marked failed.
  {
    const { context, mock, page } = await fresh()
    await seed(page, [entry('Odd', 'S5')])
    mock.next.push(400)
    await page.close()
    const page2 = await open(context)
    await status(page2).getByRole('alert').getByText("Couldn't save", { exact: true }).waitFor()
    assert.deepEqual((await entries(page2)).map((e) => [e.state, e.code]), [['failed', 'request_failed']])
    await context.close()
  }

  // --- Update ready while changes wait: the new service worker activates only once the outbox is empty.
  {
    root = A
    const { context, mock, page } = await fresh({ serviceWorkers: 'allow' })
    await page.evaluate(() => navigator.serviceWorker.ready)
    // A worker waits only while it would replace one that controls a page.
    await page.reload()
    await page.waitForFunction(() => !!navigator.serviceWorker.controller)
    mock.down = true
    await createOffline(page, 'Held')
    assert.equal((await entries(page)).length, 1)
    root = B
    await page.evaluate(() => (window.__oldPage = true))
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update())
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()).waiting, null, { timeout: 10000 })
    await page.waitForTimeout(1000)
    assert.ok(await page.evaluate(async () => window.__oldPage && !!(await navigator.serviceWorker.getRegistration()).waiting), 'activated with changes waiting')
    mock.down = false // the next backoff retry sends it and the outbox empties…
    for (let i = 0; i < 80 && mock.applied.size === 0; i++) await page.waitForTimeout(100)
    await page.waitForTimeout(500)
    assert.ok(await page.evaluate(() => window.__oldPage), 'reloaded while the page was visible')
    // …and the update activates (and reloads) once the page is hidden.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForFunction(() => !window.__oldPage, null, { timeout: 20000, polling: 200 }).catch(() => {})
    await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
    assert.ok(await page.evaluate(() => !window.__oldPage), 'update not activated after the outbox emptied')
    assert.ok(await page.evaluate(async () => !(await navigator.serviceWorker.getRegistration()).waiting), 'new worker still waiting')
    assert.deepEqual(await entries(page), [])
    assert.equal(mock.applied.size, 1)
    await context.close()
    root = A
  }
} finally {
  await browser.close()
  server.close()
}
console.log('ok')
