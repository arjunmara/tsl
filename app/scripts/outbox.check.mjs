// Story 1.7 outbox check (parts A and B): every UI row of both specs' I/O matrices in real Chrome. Supabase is mocked by route
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
 * stored result to repeats, refusals included (like finish_command). mock.refuse: names answered name_invalid; mock.dropNext: apply the
 * next new command, then drop its response; mock.down: abort every RPC and list read; mock.next: answers for
 * the next create_tournament RPCs (an HTTP status or a result), before applying; clockAhead: ms app.server_now
 * is ahead (undefined: server_now fails); mock.delay: ms before each RPC answer. mock.discards: discard_command
 * bodies (deduped by command_id); mock.reports: report_client_error bodies. signedIn false: no stored session.
 */
async function fresh({ serviceWorkers = 'block', clockAhead, signedIn = true } = {}) {
  const mock = { calls: [], applied: new Map(), tournaments: [], refuse: new Set(), dropNext: false, down: false, delay: 0, next: [], discards: [], reports: [], refused: new Map() }
  const context = await browser.newContext({ serviceWorkers })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) =>
    route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') return mock.down ? route.abort('internetdisconnected') : json(route, mock.tournaments)
    if (path === '/rest/v1/rpc/server_now') {
      return clockAhead === undefined ? route.fulfill({ status: 500, headers: cors, body: 'no clock' })
        : json(route, new Date(Date.now() + clockAhead).toISOString().replace('Z', '123+00:00'))
    }
    if (path === '/rest/v1/rpc/report_client_error') {
      mock.reports.push(JSON.parse(req.postData()))
      return route.fulfill({ status: 204, headers: cors })
    }
    if (path === '/rest/v1/rpc/discard_command') {
      if (mock.down) return route.abort('internetdisconnected')
      const body = JSON.parse(req.postData())
      if (!mock.discards.some((d) => d.command_id === body.command_id)) mock.discards.push(body)
      return json(route, { ok: true, code: null, message: 'Change discarded.' })
    }
    if (path !== '/rest/v1/rpc/create_tournament') return route.fulfill({ status: 500, headers: cors, body: `unmocked ${path}` })
    const body = JSON.parse(req.postData())
    mock.calls.push(body)
    if (mock.down) return route.abort('internetdisconnected')
    if (mock.delay) await new Promise((r) => setTimeout(r, mock.delay))
    const special = mock.next.shift()
    if (typeof special === 'number') {
      return route.fulfill({ status: special, headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST000', message: `HTTP ${special}` }) })
    }
    // The server stores every finished answer, refusals included; in_progress is not finished.
    if (special && special.code !== 'in_progress') mock.refused.set(body.command_id, special)
    if (special) return json(route, special)
    if (mock.refused.has(body.command_id)) return json(route, mock.refused.get(body.command_id))
    if (mock.applied.has(body.command_id)) return json(route, mock.applied.get(body.command_id))
    if (mock.refuse.has(body.name)) {
      const refusal = { ok: false, code: 'name_invalid', message: 'Bad name.' }
      mock.refused.set(body.command_id, refusal)
      return json(route, refusal)
    }
    const result = { ok: true, code: null, message: 'Tournament created.' }
    mock.applied.set(body.command_id, result)
    mock.tournaments.unshift({ id: body.tournament_id, name: body.name, season: [{ number: 1, status: 'setup' }] })
    if (mock.dropNext) {
      mock.dropNext = false
      return route.abort('connectionreset')
    }
    return json(route, result)
  })
  if (!signedIn) return { context, mock, page: await context.newPage() }
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
const onStep1 = (u) => /^\/t\/[0-9a-f-]{36}\/setup\/1$/.test(u.pathname)
/** In-app navigation (works offline) to /new: the name is sent when the field is left, then Back returns to My tournaments. */
async function createOffline(page, name) {
  await button(page, 'Create new tournament').click()
  await page.getByLabel('Tournament name').fill(name)
  await page.getByLabel('Tournament name').press('Tab')
  await page.waitForURL(onStep1, { timeout: 5000 })
  await button(page, 'Back').click()
  await page.waitForURL((u) => u.pathname === '/', { timeout: 5000 })
  await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
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
    await page.getByLabel('Tournament name').press('Tab')
    await status(page).getByText(/^Saving…/).waitFor()
    await page.waitForURL(onStep1)
    await status(page).locator('[aria-live="polite"]').getByText('Saved', { exact: true }).waitFor()
    await status(page).getByText('Saved').waitFor({ state: 'detached', timeout: 6000 })
    assert.equal((await status(page).textContent()).trim(), '', 'status not hidden')
    assert.deepEqual(await entries(page), [])
    assert.equal(mock.calls.length, 1)
    await button(page, 'Back').click()
    await page.locator('.card', { hasText: 'Alpha' }).waitFor()
    await context.close()
  }

  // --- Offline × 3 (server clock 5 min ahead), leave warning, close, reopen online with a lost response.
  {
    const ahead = 5 * 60 * 1000
    const { context, mock, page } = await fresh({ clockAhead: ahead })
    await page.getByText('No tournaments yet.').waitFor()
    for (let i = 0; i < 50 && !(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.endsWith('/rpc/server_now') && r.responseEnd > 0))); i++) await page.waitForTimeout(100)
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

  // --- Queued create while server_now fails: offset 0; step 1, then Back shows a Waiting card on /.
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
    near(e.enteredAt, Date.now(), 'enteredAt with server_now failing')
    await context.close()
  }

  // --- Refusal: entry failed, its scope stopped, other scopes continue; hand-back "Try sending again" re-sends it.
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
    await button(page2, 'Review this change').click()
    const sheet = page2.getByRole('dialog')
    await sheet.getByRole('heading', { name: "This change wasn't saved" }).waitFor()
    await sheet.getByText('Create tournament ‘Bad’', { exact: true }).waitFor()
    await sheet.getByText('Names must be 1 to 80 characters.', { exact: true }).waitFor()
    await button(page2, 'Try sending again').click()
    await status(page2).getByText('Saved', { exact: true }).waitFor()
    assert.equal(await page2.locator('dialog[open]').count(), 0, 'sheet still open')
    const [again, next] = mock.calls.slice(2)
    assert.notEqual(again.command_id, bad.commandId, 'Try sending again reused the refused command id')
    assert.deepEqual({ ...again, command_id: 0 }, { ...bad.args, command_id: 0 }, 'Try sending again changed the command')
    assert.equal(next?.command_id, later.commandId, 'the rest of the scope did not follow')
    assert.ok(mock.applied.has(again.command_id), 'resend did not succeed')
    assert.deepEqual(await entries(page2), [])
    await context.close()
  }

  // --- Refusal → Discard: Cancel changes nothing; confirming sends a logged discard_command and resumes the scope.
  {
    const { context, mock, page } = await fresh()
    const [bad, later] = [entry('Bad', 'S1'), entry('Later', 'S1')]
    await seed(page, [bad, later])
    mock.refuse.add('Bad')
    await page.close()
    const page2 = await open(context)
    // Tapping the status lists the changes, refused first; the review button opens the sheet.
    await status(page2).getByRole('alert').getByRole('button', { name: "Couldn't save" }).click()
    assert.deepEqual(await status(page2).getByRole('listitem').allTextContents(),
      ['Create tournament ‘Bad’ · Names must be 1 to 80 characters.', 'Create tournament ‘Later’'])
    assert.equal(await page2.locator('dialog[open]').count(), 0, 'the status opened the sheet')
    await button(page2, 'Review this change').click()
    const sheet = page2.getByRole('dialog')
    await sheet.getByRole('heading', { name: "This change wasn't saved" }).waitFor()
    await button(page2, 'Discard this change').click()
    await sheet.getByRole('heading', { name: 'Discard "Create tournament ‘Bad’"?' }).waitFor()
    assert.ok(await button(page2, 'Discard this change').evaluate((b) => b.classList.contains('ui-destructive')), 'confirm action not destructive')
    await sheet.getByText("It won't be saved. This is logged.", { exact: true }).waitFor()
    assert.equal(await page2.evaluate(() => document.activeElement?.textContent), 'Cancel', 'focus not on Cancel')
    assert.equal(await page2.locator('dialog[open]').count(), 1, 'a second sheet opened')
    await button(page2, 'Cancel').click()
    await sheet.getByRole('heading', { name: "This change wasn't saved" }).waitFor()
    await page2.waitForTimeout(300)
    assert.deepEqual(mock.discards, [], 'Cancel sent a discard')
    assert.deepEqual((await entries(page2)).map((e) => [e.args.name, e.state]), [['Bad', 'failed'], ['Later', 'pending']], 'Cancel changed the outbox')
    await button(page2, 'Discard this change').click()
    await button(page2, 'Discard this change').click()
    await status(page2).getByText('Saved', { exact: true }).waitFor()
    assert.equal(mock.discards.length, 1)
    const { command_id: _, ...args } = mock.discards[0]
    assert.deepEqual(args, { discarded_id: bad.commandId, name: 'create_tournament', scope: 'S1', reason: 'name_invalid' })
    assert.deepEqual(mock.calls.map((c) => c.command_id), [bad.commandId, later.commandId], 'scope did not resume after the discard')
    assert.deepEqual(await entries(page2), [])
    assert.equal(await page2.locator('dialog[open]').count(), 0, 'sheet still open')
    await context.close()
  }

  // --- Conflict on replay: scope stopped; the sheet shows only the differing fields, who and when; Use mine
  // re-sends with expected_version and a new command id, then the scope resumes.
  const conflict = (tournamentId) => ({ ok: false, code: 'version_conflict', message: 'Changed by someone else.',
    conflict: { current_version: 4, current: { id: tournamentId, tournament_id: tournamentId, name: 'Theirs Cup' }, changed_by: 'Sita', changed_at: '2026-11-10T04:15:00Z' } })
  {
    const { context, mock, page } = await fresh()
    const [mine, later] = [entry('Mine Cup', 'S1'), entry('Later', 'S1')]
    await seed(page, [mine, later])
    mock.next.push(conflict(mine.args.tournament_id))
    await page.close()
    const page2 = await open(context)
    await status(page2).getByRole('alert').getByText("Couldn't save", { exact: true }).waitFor()
    await page2.waitForTimeout(300)
    assert.deepEqual(mock.calls.map((c) => c.command_id), [mine.commandId], 'scope not stopped by the conflict')
    const stored = await entries(page2)
    assert.deepEqual(stored.map((e) => [e.state, e.code ?? null]), [['conflict', 'version_conflict'], ['pending', null]])
    assert.deepEqual(stored[0].conflict, conflict(mine.args.tournament_id).conflict, 'conflict not stored')
    await button(page2, 'Review this change').click()
    const sheet = page2.getByRole('dialog')
    await sheet.getByRole('heading', { name: 'Someone else changed this first' }).waitFor()
    const cols = await sheet.locator('section').evaluateAll((ss) => ss.map((s) => [s.querySelector('h3').textContent,
      [...s.querySelectorAll('dt, dd')].map((d) => d.textContent)]))
    assert.deepEqual(cols, [['Your change', ['Name', 'Mine Cup']], ['Their version', ['Name', 'Theirs Cup']]])
    await sheet.getByText('Changed by Sita at 10:00, Tuesday · Kartik 24, 2083 BS (10 Nov 2026)', { exact: true }).waitFor()
    await button(page2, 'Send my version').click()
    await status(page2).getByText('Saved', { exact: true }).waitFor()
    const [, again, next] = mock.calls
    assert.notEqual(again.command_id, mine.commandId, 'Send my version reused the command id')
    const { command_id: _, ...sent } = again
    assert.deepEqual(sent, { ...mine.args, expected_version: 4 }, 'Send my version sent different args')
    assert.equal(next?.command_id, later.commandId, 'scope did not resume')
    assert.equal(mock.calls.length, 3)
    assert.deepEqual(await entries(page2), [])
    await context.close()
  }

  // --- Keep their version while offline: the discard is queued (scope 'discard') and the entry is gone; it sends later.
  {
    const { context, mock, page } = await fresh()
    const mine = entry('Mine Cup', 'S1')
    await seed(page, [mine])
    mock.next.push(conflict(mine.args.tournament_id))
    await page.close()
    const page2 = await open(context)
    await button(page2, 'Review this change').click()
    mock.down = true
    await button(page2, 'Keep their version').click()
    await page2.locator('dialog[open]').waitFor({ state: 'detached', timeout: 3000 })
    for (let i = 0; i < 30 && (await entries(page2)).some((e) => e.name !== 'discard_command'); i++) await page2.waitForTimeout(100)
    const [q, ...rest] = await entries(page2)
    assert.equal(rest.length, 0, 'old entry kept')
    assert.deepEqual([q.name, q.scope, q.state, q.actor], ['discard_command', `discard:${mine.commandId}`, 'pending', ME])
    assert.deepEqual(q.args, { discarded_id: mine.commandId, name: 'create_tournament', scope: 'S1', reason: 'kept_theirs' })
    mock.down = false
    for (let i = 0; i < 100 && !mock.discards.length; i++) await page2.waitForTimeout(100)
    assert.equal(mock.discards[0]?.command_id, q.commandId, 'queued discard not sent')
    await status(page2).getByText('Saved', { exact: true }).waitFor()
    assert.deepEqual(await entries(page2), [])
    await context.close()
  }

  // --- A conflict where nothing sent differs: the fallback line, a blank changed_by as "someone", both choices.
  {
    const { context, mock, page } = await fresh()
    const mine = entry('Same Cup', 'S1')
    await seed(page, [mine])
    const c = conflict(mine.args.tournament_id)
    mock.next.push({ ...c, conflict: { ...c.conflict, current: { tournament_id: mine.args.tournament_id, name: 'Same Cup' }, changed_by: ' ' } })
    await page.close()
    const page2 = await open(context)
    await button(page2, 'Review this change').click()
    const sheet = page2.getByRole('dialog')
    await sheet.getByText('Nothing you changed differs from their version.', { exact: true }).waitFor()
    await sheet.getByText('Changed by someone at 10:00, Tuesday · Kartik 24, 2083 BS (10 Nov 2026)', { exact: true }).waitFor()
    assert.equal(await sheet.locator('section').count(), 0, 'columns shown with nothing differing')
    await button(page2, 'Keep their version').waitFor()
    await button(page2, 'Send my version').waitFor()
    await button(page2, 'Close without choosing').click()
    assert.deepEqual((await entries(page2)).map((e) => e.state), ['conflict'], 'closing dropped the change')
    await context.close()
  }

  // --- A malformed conflict payload is a plain refusal.
  {
    const { context, mock, page } = await fresh()
    await seed(page, [entry('Odd Cup', 'S1')])
    mock.next.push({ ok: false, code: 'version_conflict', message: null, conflict: { current_version: 'x', current: [], changed_at: 'never' } })
    await page.close()
    const page2 = await open(context)
    await status(page2).getByRole('alert').getByText("Couldn't save", { exact: true }).waitFor()
    assert.deepEqual((await entries(page2)).map((e) => [e.state, e.code, e.conflict ?? null]), [['failed', 'request_failed', null]])
    await context.close()
  }

  // --- Two refused changes: oldest first; the first choice moves to the second with focus on the heading;
  // the second choice closes the sheet.
  {
    const { context, mock, page } = await fresh()
    const [one, two] = [entry('Bad1', 'S1'), entry('Bad2', 'S2')]
    await seed(page, [one, two])
    mock.refuse.add('Bad1').add('Bad2')
    await page.close()
    const page2 = await open(context)
    await button(page2, 'Review refused changes').click()
    const sheet = page2.getByRole('dialog')
    await sheet.getByRole('heading', { name: 'Review refused changes' }).waitFor()
    await sheet.getByText('Create tournament ‘Bad1’', { exact: true }).waitFor()
    mock.refuse.clear()
    await button(page2, 'Try sending again').click()
    await sheet.getByText('Create tournament ‘Bad2’', { exact: true }).waitFor()
    assert.equal(await page2.locator('dialog[open]').count(), 1, 'sheet closed after the first choice')
    assert.equal(await page2.evaluate(() => document.activeElement?.tagName), 'H2', 'focus not on the heading')
    await button(page2, 'Discard this change').click()
    await button(page2, 'Discard this change').click()
    await page2.locator('dialog[open]').waitFor({ state: 'detached' })
    await status(page2).getByText('Saved', { exact: true }).waitFor()
    assert.deepEqual(mock.discards.map((d) => [d.discarded_id, d.reason]), [[two.commandId, 'name_invalid']])
    assert.equal(mock.applied.size, 1, 'first change not sent')
    await context.close()
  }

  // --- Sign-in kicks a pass: an entry of this user waiting while signed out sends as soon as they sign in.
  {
    const { context, mock, page } = await fresh({ signedIn: false })
    await page.goto(base + '/sign-in')
    await page.getByLabel('Email').waitFor()
    const late = entry('Late', 'S7')
    await seed(page, [late])
    await page.waitForTimeout(1000)
    assert.equal(mock.calls.length, 0, 'sent while signed out')
    await page.getByLabel('Email').fill('org@example.com')
    await page.getByLabel('Password').fill('password1')
    const t = Date.now()
    await button(page, 'Sign in').click()
    while (!mock.calls.length && Date.now() - t < 5000) await page.waitForTimeout(50)
    assert.ok(Date.now() - t < 1500, `sign-in took ${Date.now() - t} ms to send`)
    assert.equal(mock.calls[0].command_id, late.commandId)
    await status(page).getByText('Saved', { exact: true }).waitFor()
    await context.close()
  }

  // --- Crash in a screen: one report with no email or long number, the boundary text and its reload button.
  {
    const { context, mock, page } = await fresh()
    await page.goto(base + '/__crash?crashtest')
    await page.getByRole('alert').getByText('Something went wrong on this screen.', { exact: true }).waitFor()
    await button(page, 'Reload this page').waitFor()
    await page.waitForTimeout(500)
    assert.equal(mock.reports.length, 1, `reports: ${JSON.stringify(mock.reports)}`)
    const [r] = mock.reports
    assert.deepEqual([r.app_version, r.route, r.error_name], [pkg.version, '/__crash', 'Error'])
    assert.ok(r.message.includes('[removed]') && !/example\.com|9800000001/.test(r.message), `message: ${r.message}`)
    assert.match(r.frame, /^\/assets\/[^:]+\.js:\d+$/, `frame: ${r.frame}`)
    await context.close()
  }

  // --- Uncaught errors and rejections: route with :id and no query or hash; personal data removed; 5 per page load.
  {
    const { context, mock, page } = await fresh()
    await page.evaluate(() => {
      history.pushState(null, '', '/t/0b7c2c7e-1d2a-4c3b-9f00-123456789abc/teams?who=x#y')
      setTimeout(() => void Promise.reject(new Error('Rejected for org@example.com')))
    })
    for (let i = 0; i < 50 && !mock.reports.length; i++) await page.waitForTimeout(50)
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) setTimeout(() => { throw new TypeError(`Boom ${i} 0b7c2c7e-1d2a-4c3b-9f00-123456789abc 9812345678`) })
    })
    await page.waitForTimeout(1000)
    assert.equal(mock.reports.length, 5, `reports: ${mock.reports.length}`)
    assert.ok(mock.reports.every((r) => r.route === '/t/:id/teams'), `routes: ${mock.reports.map((r) => r.route)}`)
    const msgs = mock.reports.map((r) => r.message)
    assert.ok(msgs.includes('Rejected for [removed]'), `messages: ${msgs}`)
    assert.ok(msgs.includes('Boom 0 [removed] [removed]'), `messages: ${msgs}`)
    assert.ok(mock.reports.some((r) => r.error_name === 'TypeError'))
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
    await page.getByLabel('Tournament name').press('Tab')
    await page.waitForURL(onStep1)
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
