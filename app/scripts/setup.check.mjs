// Story 1.8 setup check: every UI row of the spec's I/O matrix in real Chrome. Supabase (auth, the app schema's
// tournament read and commands, Storage uploads) is mocked by route interception; the mock commands follow the
// server: ids applied once, versions checked with the conflict envelope, setup_step monotonic. The app is built
// with a fake Supabase URL into node_modules/.setup-dist. `npm run check:setup`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const outDir = 'node_modules/.setup-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_TURNSTILE_SITE_KEY
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4183 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * A signed-in context with a mocked server. mock.rows: tournaments by id (server columns, season rows with
 * setup_step); mock.calls: every command body, cmd its name; mock.uploads: { path, upsert, bytes }; mock.down: every
 * request to Supabase fails as if offline; mock.storage: [HTTP status, body statusCode] answers for the next uploads;
 * mock.refuse: codes for the next set_tournament_branding calls. Ok answers carry the row's version, like the server.
 */
async function fresh({ viewport = { width: 390, height: 844 }, rows = [] } = {}) {
  const mock = { rows: new Map(rows.map((r) => [r.id, r])), calls: [], uploads: [], down: false, done: new Map(), storage: [], refuse: [] }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) =>
    route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/storage/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = decodeURIComponent(new URL(req.url()).pathname.replace('/storage/v1/object/tournament-assets/', ''))
    const fail = mock.storage.shift()
    if (fail) {
      mock.uploads.push({ path, failed: fail[0] })
      return route.fulfill({ status: fail[0], headers: cors, contentType: 'application/json',
        body: JSON.stringify({ statusCode: fail[1], error: 'Unauthorized', message: 'new row violates row-level security policy' }) })
    }
    mock.uploads.push({ path, upsert: req.headers()['x-upsert'], bytes: req.postDataBuffer() })
    return json(route, { Key: `tournament-assets/${path}`, Id: crypto.randomUUID() })
  })
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') return json(route, [...mock.rows.values()].reverse())
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    const name = path.replace('/rest/v1/rpc/', '')
    const a = JSON.parse(req.postData())
    mock.calls.push({ ...a, cmd: name })
    if (mock.done.has(a.command_id)) return json(route, mock.done.get(a.command_id))
    const ok = { ok: true, code: null, message: 'Done.' }
    let r = ok
    if (name === 'discard_command') r = ok
    else if (name === 'create_tournament') {
      r = { ...ok, version: 1 }
      mock.rows.set(a.tournament_id, { id: a.tournament_id, name: a.name, brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1,
        season: [{ id: a.season_id, number: 1, status: 'setup', setup_step: 0 }] })
    } else if (name === 'set_tournament_branding') {
      const t = mock.rows.get(a.tournament_id)
      const refusal = mock.refuse.shift()
      if (refusal) r = { ok: false, code: refusal, message: 'Refused.' }
      else if (t.version !== a.expected_version) {
        r = { ok: false, code: 'version_conflict', message: 'Someone else changed this first.', conflict: { current_version: t.version,
          current: { name: t.name, brand_primary: t.brand_primary, brand_secondary: t.brand_secondary, logo_path: t.logo_path },
          changed_by: 'sita', changed_at: '2026-11-10T04:15:00Z' } }
      } else {
        for (const k of ['name', 'brand_primary', 'brand_secondary']) if (a[k] != null) t[k] = a[k]
        if (a.logo_path != null) t.logo_path = a.logo_path || null
        t.version++
        r = { ...ok, version: t.version }
      }
    } else if (name === 'set_setup_step') {
      for (const t of mock.rows.values()) for (const s of t.season) if (s.id === a.season_id) s.setup_step = Math.max(s.setup_step, a.step)
    } else return route.fulfill({ status: 500, headers: cors, body: `unmocked ${path}` })
    mock.done.set(a.command_id, r)
    return json(route, r)
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  return { context, mock, page }
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const onStep = (n) => (u) => new RegExp(`^/t/[0-9a-f-]{36}/setup/${n}$`).test(u.pathname)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const status = (page) => page.locator('.save-bar')
/** A colour picker's choice: Playwright sets the value and fires input then change, as closing the picker does. */
const pick = (page, label, hex) => page.getByLabel(label, { exact: true }).fill(hex)
/** /new → name → leave the field: step 1 of the created Tournament. Returns its id. */
async function createVia(page, name) {
  await page.goto(base + '/new')
  await page.getByLabel('Tournament name').fill(name)
  await page.getByLabel('Tournament name').press('Tab')
  await page.waitForURL(onStep(1), { timeout: 5000 })
  await page.getByRole('heading', { name: 'Step 1 of 7 · Name & logo' }).waitFor()
  await page.getByLabel('Main colour', { exact: true }).waitFor()
  return new URL(page.url()).pathname.split('/')[2]
}
const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor)

try {
  // --- First name blur: create_tournament with the ids made on /new (kept across a reload), then /t/<id>/setup/1.
  // Empty name on Next: the message, focus on the field, no command.
  {
    const { context, mock, page } = await fresh()
    await page.goto(base + '/')
    await button(page, 'Create new tournament').click()
    await page.getByRole('heading', { name: 'Step 1 of 7 · Name & logo' }).waitFor()
    assert.ok(await page.locator('.wizard-progress').getAttribute('aria-hidden'), 'progress bar not aria-hidden')
    await button(page, 'Next').click()
    await page.getByText("Add the tournament's name.", { exact: true }).waitFor()
    assert.ok(await page.getByLabel('Tournament name').evaluate((el) => el === document.activeElement), 'Next did not focus the name')
    assert.equal(mock.calls.length, 0, 'a command was sent with no name')
    const ids = await page.evaluate(() => history.state?.usr?.ids)
    assert.match(ids?.tournamentId ?? '', UUID, 'ids not in history.state')
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('tsl-new-tournament'))), ids, 'ids not in sessionStorage')
    await page.reload()
    await page.getByLabel('Tournament name').waitFor()
    assert.deepEqual(await page.evaluate(() => history.state?.usr?.ids), ids, 'reload made new ids')
    await page.getByLabel('Tournament name').fill('Gulmi Cup')
    await page.getByLabel('Tournament name').press('Tab')
    await page.waitForURL(onStep(1), { timeout: 5000 })
    await until(page, () => calls(mock, 'create_tournament').length === 1, 'create not sent')
    const [c] = calls(mock, 'create_tournament')
    assert.deepEqual([c.tournament_id, c.season_id, c.name], [ids.tournamentId, ids.seasonId, 'Gulmi Cup'])
    assert.equal(new URL(page.url()).pathname, `/t/${ids.tournamentId}/setup/1`)
    assert.equal(await page.evaluate(() => sessionStorage.getItem('tsl-new-tournament')), null, 'ids kept after the create')
    await page.getByLabel('Main colour', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Tournament name').inputValue(), 'Gulmi Cup')
    // Back on step 1 returns to My tournaments.
    await button(page, 'Back').click()
    await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
    await context.close()
  }

  // --- Colour change: only brand_primary with expected_version 1; the sample follows at once; default navy needs no note.
  // Then a rename sends only the name with expected_version 2. Next sends set_setup_step(1) and opens the step 2 placeholder.
  {
    const { context, mock, page } = await fresh()
    const id = await createVia(page, 'Gulmi Cup')
    const sample = page.locator('.sample')
    assert.equal(await page.getByText('Darkened behind text so it stays readable.').count(), 0, 'note shown for navy')
    await pick(page, 'Main colour', '#1b5e20')
    assert.equal(await bg(sample), 'rgb(27, 94, 32)', 'sample not updated')
    await until(page, () => calls(mock, 'set_tournament_branding').length === 1, 'colour not sent')
    const { command_id: _c, cmd: _n, ...colour } = calls(mock, 'set_tournament_branding')[0]
    assert.deepEqual(colour, { tournament_id: id, expected_version: 1, brand_primary: '#1b5e20' })
    await page.getByLabel('Tournament name').fill('Gulmi Gold Cup')
    await page.getByLabel('Tournament name').press('Tab')
    await until(page, () => calls(mock, 'set_tournament_branding').length === 2, 'rename not sent')
    const { command_id: _d, cmd: _m, ...rename } = calls(mock, 'set_tournament_branding')[1]
    assert.deepEqual(rename, { tournament_id: id, expected_version: 2, name: 'Gulmi Gold Cup' })
    assert.match(await page.locator('.sample-name').textContent(), /Gulmi Gold Cup/)
    await button(page, 'Next').click()
    await page.waitForURL(onStep(2))
    await page.getByRole('heading', { name: 'Step 2 of 7 · Description & rules' }).waitFor()
    await page.getByText('This step arrives in the next update.', { exact: true }).waitFor()
    await until(page, () => calls(mock, 'set_setup_step').length === 1, 'set_setup_step not sent')
    const { command_id: _e, cmd: _o, ...step } = calls(mock, 'set_setup_step')[0]
    assert.deepEqual(step, { season_id: mock.rows.get(id).season[0].id, step: 1 })
    assert.equal(await button(page, 'Next').count(), 0, 'placeholder has Next')
    await button(page, 'Back').click()
    await page.waitForURL(onStep(1))
    // Reopened from the server: the saved values.
    await page.getByLabel('Main colour', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Main colour', { exact: true }).inputValue(), '#1b5e20')
    assert.equal(await page.getByLabel('Tournament name').inputValue(), 'Gulmi Gold Cup')
    await context.close()
  }

  // --- Two edits offline: queued in order with expected_version 1 then 2; both apply when online.
  {
    const { context, mock, page } = await fresh()
    const id = await createVia(page, 'Gulmi Cup')
    await status(page).getByText('Saved', { exact: true }).waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    await context.setOffline(true)
    mock.down = true
    await page.getByLabel('Tournament name').fill('Gulmi Offline Cup')
    await page.getByLabel('Tournament name').press('Tab')
    await pick(page, 'Second colour', '#123456')
    await status(page).getByText("Offline · 2 changes waiting to send. They'll send when the signal is back.", { exact: true }).waitFor()
    mock.down = false
    await context.setOffline(false)
    await status(page).getByText('Saved', { exact: true }).waitFor({ timeout: 15000 })
    const sent = calls(mock, 'set_tournament_branding')
    const first = [...new Map(sent.map((c) => [c.command_id, c])).values()]
    assert.deepEqual(first.map((c) => [c.expected_version, c.name ?? null, c.brand_secondary ?? null]),
      [[1, 'Gulmi Offline Cup', null], [2, null, '#123456']], 'not queued in order with versions 1 then 2')
    const t = mock.rows.get(id)
    assert.deepEqual([t.name, t.brand_secondary, t.version], ['Gulmi Offline Cup', '#123456', 3], 'not applied')
    await context.close()
  }

  // --- Created offline: a queued create counts as version 1; step 1 reopens from the queue with no server; then all apply in order.
  {
    const { context, mock, page } = await fresh()
    await page.goto(base + '/new')
    await page.getByLabel('Tournament name').waitFor()
    const depth = await page.evaluate(() => history.length)
    await context.setOffline(true)
    mock.down = true
    await pick(page, 'Main colour', '#1b5e20') // before the name: waits for the create
    await page.getByLabel('Tournament name').fill('Hill Cup')
    await page.getByLabel('Tournament name').press('Tab')
    await page.waitForURL(onStep(1), { timeout: 5000 })
    const id = new URL(page.url()).pathname.split('/')[2]
    await page.getByLabel('Second colour', { exact: true }).waitFor()
    await pick(page, 'Second colour', '#123456')
    await button(page, 'Back').click()
    await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
    assert.equal(await page.evaluate(() => history.length), depth, 'the wizard grew the history')
    await page.locator('.card-waiting', { hasText: 'Hill Cup' }).getByRole('button', { name: 'Continue setup' }).click()
    await page.waitForURL(onStep(1))
    await page.getByLabel('Second colour', { exact: true }).waitFor()
    assert.deepEqual([await page.getByLabel('Tournament name').inputValue(), await page.getByLabel('Main colour', { exact: true }).inputValue(),
      await page.getByLabel('Second colour', { exact: true }).inputValue()], ['Hill Cup', '#1b5e20', '#123456'], 'queued values not shown')
    mock.down = false
    await context.setOffline(false)
    await status(page).getByText('Saved', { exact: true }).waitFor({ timeout: 15000 })
    const order = [...new Map(mock.calls.map((c) => [c.command_id, c])).values()].map((c) => [c.cmd, c.expected_version ?? null])
    assert.deepEqual(order, [['create_tournament', null], ['set_tournament_branding', 1], ['set_tournament_branding', 2]])
    const t = mock.rows.get(id)
    assert.deepEqual([t.name, t.brand_primary, t.brand_secondary, t.version], ['Hill Cup', '#1b5e20', '#123456', 3])
    await context.close()
  }

  // --- Conflict: the server moved on; the entry is a conflict and the hand-back sheet shows the differing field.
  // An edit queued behind it waits; Send my version applies both, with no second conflict.
  {
    const { context, mock, page } = await fresh()
    const id = await createVia(page, 'Gulmi Cup')
    const t = mock.rows.get(id)
    Object.assign(t, { brand_primary: '#550000', version: 2 })
    await pick(page, 'Main colour', '#005500')
    await status(page).getByRole('alert').getByText("Couldn't save", { exact: true }).waitFor()
    await pick(page, 'Second colour', '#123456')
    await page.waitForTimeout(300)
    assert.equal(t.brand_secondary, '#f58220', 'the edit behind the conflict was sent')
    await button(page, 'Review this change').click()
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('heading', { name: 'Someone else changed this first' }).waitFor()
    const cols = await sheet.locator('section').evaluateAll((ss) => ss.map((s) => [...s.querySelectorAll('dt, dd')].map((d) => d.textContent)))
    assert.deepEqual(cols, [['Main colour', '#005500'], ['Main colour', '#550000']])
    await sheet.getByText('Change the main colour', { exact: true }).waitFor()
    await button(page, 'Send my version').click()
    await status(page).getByText('Saved', { exact: true }).waitFor({ timeout: 8000 })
    assert.deepEqual([t.brand_primary, t.brand_secondary, t.version], ['#005500', '#123456', 4], 'not both applied')
    assert.equal(calls(mock, 'set_tournament_branding').at(-1).expected_version, 3)
    await context.close()
  }

  // --- A refused edit, discarded: the next edit applies with no conflict (the base version did not move).
  {
    const { context, mock, page } = await fresh()
    const id = await createVia(page, 'Gulmi Cup')
    mock.refuse.push('colour_invalid')
    await pick(page, 'Main colour', '#005500')
    await status(page).getByRole('alert').getByText("Couldn't save", { exact: true }).waitFor()
    await button(page, 'Review this change').click()
    await button(page, 'Discard this change').click()
    await button(page, 'Discard this change').click()
    await page.locator('dialog[open]').waitFor({ state: 'detached' })
    await pick(page, 'Second colour', '#123456')
    await until(page, () => mock.rows.get(id).brand_secondary === '#123456', 'next edit not applied')
    const last = calls(mock, 'set_tournament_branding').at(-1)
    assert.deepEqual([last.expected_version, mock.rows.get(id).version], [1, 2])
    await status(page).getByText('Saved', { exact: true }).waitFor()
    await context.close()
  }

  // --- Storage refuses the upload (400 with statusCode 403 in the body): failed not_authorized, no branding call,
  // review offered. A 5xx stays pending and retries.
  {
    const { context, mock, page } = await fresh()
    await createVia(page, 'Gulmi Cup')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    mock.storage.push([400, '403'])
    await page.getByLabel('Choose a logo').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: png })
    await status(page).getByRole('alert').getByText("Couldn't save", { exact: true }).waitFor()
    await button(page, 'Review this change').waitFor()
    const stored = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('tsl-outbox')
      r.onsuccess = () => {
        const q = r.result.transaction('entries').objectStore('entries').getAll()
        q.onsuccess = () => res(q.result.map((e) => [e.name, e.state, e.code]))
      }
    }))
    assert.deepEqual(stored, [['set_tournament_branding', 'failed', 'not_authorized']])
    assert.equal(calls(mock, 'set_tournament_branding').length, 0, 'branding sent after a refused upload')
    await context.close()
  }
  {
    const { context, mock, page } = await fresh()
    const id = await createVia(page, 'Gulmi Cup')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    mock.storage.push([503, '503'])
    await page.getByLabel('Choose a logo').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: png })
    await until(page, () => mock.uploads.length === 1, 'no upload')
    assert.equal(calls(mock, 'set_tournament_branding').length, 0)
    await until(page, () => !!mock.rows.get(id).logo_path, 'upload not retried after a 5xx')
    assert.equal(mock.uploads.length, 2)
    assert.equal(await page.locator('.save-bar').getByText("Couldn't save").count(), 0, 'a 5xx was shown as refused')
    await context.close()
  }

  // --- Logo: a 3000px JPEG is uploaded as a ≤512px WebP to <id>/logo-<uuid>.webp, then branding with logo_path;
  // the preview shows it. Offline it is queued with the blob and uploads on reconnect. Remove logo clears it.
  {
    const { context, mock, page } = await fresh()
    const id = await createVia(page, 'Gulmi Cup')
    const jpeg = Buffer.from(await page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 3000
      c.height = 2000
      const g = c.getContext('2d')
      g.fillStyle = 'orange'
      g.fillRect(0, 0, 3000, 2000)
      return c.toDataURL('image/jpeg', 0.9).split(',')[1]
    }), 'base64')
    await context.setOffline(true)
    mock.down = true
    await page.getByLabel('Choose a logo').setInputFiles({ name: 'logo.jpg', mimeType: 'image/jpeg', buffer: jpeg })
    await page.getByRole('img', { name: 'Logo preview' }).waitFor()
    await status(page).getByText("Offline · 1 change waiting to send. They'll send when the signal is back.", { exact: true }).waitFor()
    const queued = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('tsl-outbox')
      r.onsuccess = () => {
        const q = r.result.transaction('entries').objectStore('entries').getAll()
        q.onsuccess = () => res(q.result.map((e) => ({ name: e.name, path: e.upload?.path, type: e.upload?.blob?.type, size: e.upload?.blob?.size })))
      }
    }))
    assert.equal(queued.length, 1)
    assert.equal(queued[0].type, 'image/webp', 'not WebP')
    assert.ok(queued[0].size > 0 && queued[0].size < jpeg.length, 'blob not stored or not smaller')
    mock.down = false
    await context.setOffline(false)
    await status(page).getByText('Saved', { exact: true }).waitFor({ timeout: 15000 })
    assert.equal(mock.uploads.length, 1)
    const [up] = mock.uploads
    assert.match(up.path, new RegExp(`^${id}/logo-[0-9a-f-]{36}\\.webp$`))
    assert.equal(up.upsert, 'true')
    const riff = up.bytes.indexOf('RIFF')
    assert.ok(riff >= 0 && up.bytes.toString('latin1', riff + 8, riff + 12) === 'WEBP', 'upload is not WebP')
    const webp = up.bytes.subarray(riff, riff + 8 + up.bytes.readUInt32LE(riff + 4))
    const size = await page.evaluate(async (b) => {
      const img = await createImageBitmap(new Blob([Uint8Array.from(atob(b), (c) => c.charCodeAt(0))], { type: 'image/webp' }))
      return [img.width, img.height]
    }, webp.toString('base64'))
    assert.deepEqual(size, [512, 341], 'not resized to fit 512×512')
    const brand = calls(mock, 'set_tournament_branding')
    assert.equal(brand.at(-1).logo_path, up.path, 'branding not sent with the logo path')
    assert.equal(mock.rows.get(id).logo_path, up.path)
    await page.getByRole('img', { name: 'Logo preview' }).waitFor()
    await button(page, 'Remove logo').click()
    await until(page, () => calls(mock, 'set_tournament_branding').some((c) => c.logo_path === ''), 'remove not sent')
    assert.equal(await page.getByRole('img', { name: 'Logo preview' }).count(), 0, 'preview still shown')
    await until(page, () => mock.rows.get(id).logo_path === null, 'logo not removed on the server')
    await context.close()
  }

  // --- Low contrast: neither navy nor white reaches 4.5:1 on this grey: adjusted swatch and the note.
  {
    const { context, page } = await fresh()
    await createVia(page, 'Gulmi Cup')
    await pick(page, 'Main colour', '#7a7a7a')
    await page.getByText('Darkened behind text so it stays readable.', { exact: true }).waitFor()
    const swatches = await page.locator('.swatch').evaluateAll((ss) => ss.map((s) => getComputedStyle(s).backgroundColor))
    assert.equal(swatches[0], 'rgb(122, 122, 122)')
    assert.notEqual(swatches[1], swatches[0], 'no adjusted swatch')
    const ratio = await page.locator('.sample-panel').evaluate((el) => {
      const lum = (c) => {
        const [r, g, b] = c.match(/\d+/g).slice(0, 3).map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const s = getComputedStyle(el)
      const [a, b] = [lum(s.color), lum(s.backgroundColor)].sort((x, y) => y - x)
      return (a + 0.05) / (b + 0.05)
    })
    assert.ok(ratio >= 4.5, `text on the panel is ${ratio.toFixed(2)}:1`)
    await pick(page, 'Main colour', '#0a1a3f')
    await page.getByText('Darkened behind text so it stays readable.').waitFor({ state: 'detached' })
    await context.close()
  }

  // --- Resume: setup_step 1 on the server → the card, and Continue setup opens step 2. A finished setup shows no card.
  {
    const T = '11111111-0000-4000-8000-000000000001'
    const U = '11111111-0000-4000-8000-000000000002'
    const rows = [
      { id: U, name: 'Done Cup', logo_path: null, season: [{ id: 's2', number: 1, status: 'setup', setup_step: 7 }] },
      { id: T, name: 'Gulmi Cup', logo_path: `${T}/logo-x.webp`, season: [{ id: 's1', number: 1, status: 'setup', setup_step: 1 }] },
    ]
    const { context, page } = await fresh({ rows })
    await page.goto(base + '/')
    const card = page.locator('.card', { hasText: 'Gulmi Cup' })
    await card.getByText('Season 1 · Setup · step 2 of 7', { exact: true }).waitFor()
    await card.getByText('Step 1 is saved. Next: Description & rules.', { exact: true }).waitFor()
    assert.equal(await card.locator('.wizard-progress').getAttribute('aria-hidden'), 'true')
    assert.equal(await card.locator('img').getAttribute('src'), `${SUPA}/storage/v1/object/public/tournament-assets/${T}/logo-x.webp`)
    assert.equal(await page.locator('.card', { hasText: 'Done Cup' }).getByRole('button').count(), 0, 'finished setup has a Resume card')
    await card.getByRole('button', { name: 'Continue setup' }).click()
    await page.waitForURL((u) => u.pathname === `/t/${T}/setup/2`)
    await page.getByRole('heading', { name: 'Step 2 of 7 · Description & rules' }).waitFor()
    rows[1].season[0].setup_step = 3
    await page.goto(base + '/')
    await card.getByText('Steps 1–3 are saved. Next: Format.', { exact: true }).waitFor()
    await context.close()
  }

  // --- Unknown or malformed ids, step out of range or ahead of setup_step, step 1 offline with nothing queued.
  {
    const T = '11111111-0000-4000-8000-000000000001'
    const rows = [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1,
      season: [{ id: 's1', number: 1, status: 'setup', setup_step: 1 }] }]
    const { context, mock, page } = await fresh({ rows })
    for (const p of ['/t/22222222-0000-4000-8000-000000000009/setup/1', '/t/not-a-uuid/setup/1', '/t/22222222-0000-4000-8000-000000000009/setup/3']) {
      await page.goto(base + p)
      await page.getByText("This tournament isn't available.", { exact: true }).waitFor()
      await button(page, 'Back to My tournaments').waitFor()
    }
    await button(page, 'Back to My tournaments').click()
    await page.getByRole('heading', { name: 'My tournaments' }).waitFor()
    await page.goto(base + `/t/${T}/setup/9`)
    await page.waitForURL((u) => u.pathname === `/t/${T}/setup/1`)
    await page.goto(base + `/t/${T}/setup/5`)
    await page.waitForURL((u) => u.pathname === `/t/${T}/setup/1`)
    await page.getByLabel('Main colour', { exact: true }).waitFor()
    await page.goto(base + '/')
    await page.locator('.card', { hasText: 'Gulmi Cup' }).waitFor()
    await context.setOffline(true)
    mock.down = true
    await page.locator('.card', { hasText: 'Gulmi Cup' }).getByRole('button', { name: 'Continue setup' }).click()
    await page.waitForURL((u) => u.pathname === `/t/${T}/setup/2`)
    await page.locator('main').getByRole('alert').getByText("Can't reach the server. Check your signal and try again.", { exact: true }).waitFor({ timeout: 15000 })
    mock.down = false
    await context.setOffline(false)
    await button(page, 'Try loading again').click()
    await page.getByText('This step arrives in the next update.', { exact: true }).waitFor()
    await context.close()
  }

  // --- Laptop: content at most 960px, centred, sample beside the fields. Phone: one column, the bar fixed at the bottom.
  {
    const { context, page } = await fresh({ viewport: { width: 1280, height: 900 } })
    await createVia(page, 'Gulmi Cup')
    const box = await page.locator('main.wizard').boundingBox()
    assert.ok(box.width <= 960, `content ${box.width}px wide`)
    assert.ok(Math.abs(box.x - (1280 - box.x - box.width)) <= 1, 'content not centred')
    const fields = await page.locator('.wizard-fields').boundingBox()
    const sample = await page.locator('.sample').boundingBox()
    assert.ok(sample.x >= fields.x + fields.width && Math.abs(sample.y - fields.y) < 40, 'sample not beside the fields')
    assert.ok(Math.abs(sample.height / sample.width - 5 / 4) < 0.01, 'sample not 4:5')
    await page.setViewportSize({ width: 390, height: 844 })
    const [f, s] = [await page.locator('.wizard-fields').boundingBox(), await page.locator('.sample').boundingBox()]
    assert.ok(s.y >= f.y + f.height, 'phone: not one column')
    const bar = await page.locator('.wizard-bar').boundingBox()
    assert.equal(Math.round(bar.y + bar.height), 844, 'bar not at the bottom')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll on phone')
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom), `${bar.height}px`, 'scroll-padding-bottom')
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
