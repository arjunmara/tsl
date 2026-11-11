// Story 2.4 Eligibility proof check: on /register#<token> a Team manager picks a Player's document type, enters its
// number and uploads a scan from the camera or gallery. The scan is resized to WebP on the phone, uploaded without upsert
// to <tournament>/<team>/<player>/<uuid>.webp in the private eligibility-scans bucket, then the command names it; the card
// shows only the file name. A refused upload is said in that Player's card only; a retry that finds the file is done;
// offline it waits with the rest; closed, the document type shows without its number. Every UI row of the spec's I/O
// matrix, in real Chrome with Supabase and Turnstile mocked by route interception. `npm run check:eligibility`.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'
import { formatDay } from '../src/domain/format.ts'

const SUPA = 'https://fake.supabase.co'
const ANON = '00000000-0000-4000-8000-0000000000a1'
const TOURNAMENT = '11111111-0000-4000-8000-000000000001'
const TEAM = '55555555-0000-4000-8000-000000000001'
const P1 = '91111111-0000-4000-8000-000000000001'
const P2 = '91111111-0000-4000-8000-000000000002'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const OPEN_DAY = '2033-11-03'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const outDir = 'node_modules/.eligibility-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4190 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session(id) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, exp, role: 'authenticated', aud: 'authenticated', is_anonymous: true })}.sig`
  const user = { id, aud: 'authenticated', role: 'authenticated', email: '', is_anonymous: true, app_metadata: {}, user_metadata: {},
    identities: [], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: `rt-${id}`, user }
}

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const twoPlayers = () => [
  { id: P1, name: 'Bisho Basnet', shirt: 7, dob: '2012-05-01', consent: true, givenBy: 'Mina Basnet', version: 1 },
  { id: P2, name: 'Dinesh Shrees', shirt: 8, dob: '2000-01-01', consent: false, givenBy: null, version: 1 },
]

/**
 * A context with the Team manager's grant. mock.records: Eligibility records by Player id (with the scan path, as the
 * server keeps it; the read never returns it); mock.uploads: { path, upsert, bytes }; mock.storage: [HTTP status, body
 * statusCode] answers for the next uploads; mock.down: Supabase unreachable; mock.calls: every command body with cmd.
 */
async function fresh({ deadline = OPEN_DAY, records = {} } = {}) {
  const mock = {
    team: { id: TEAM, tournament_id: TOURNAMENT, name: 'Friends Sporting Wing', code: 'FSW', kit_colour: null, status: 'invited', version: 1 },
    form: { tournament_name: 'Gulmi Cup', season_number: 1, season_status: 'registration', registration_deadline: deadline },
    rules: { consent_statement: 'Photos may be used.', starters: 2, max_bench: 1, staff_roles: ['manager'] },
    players: twoPlayers(), records, uploads: [], storage: [], down: false, calls: [],
  }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  await context.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({
    contentType: 'text/javascript', body: `window.turnstile = { render(el, o) { setTimeout(() => o.callback('tok')); return 'w' }, remove() {} }`,
  }))
  const json = (route, data, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    return json(route, session(ANON))
  })
  await context.route(`${SUPA}/storage/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = decodeURIComponent(new URL(req.url()).pathname.replace('/storage/v1/object/eligibility-scans/', ''))
    const fail = mock.storage.shift()
    if (fail) {
      mock.uploads.push({ path, failed: fail[0] })
      return route.fulfill({ status: fail[0], headers: cors, contentType: 'application/json',
        body: JSON.stringify({ statusCode: fail[1], error: 'Refused', message: fail[1] === '409' ? 'The resource already exists' : 'new row violates row-level security policy' }) })
    }
    mock.uploads.push({ path, upsert: req.headers()['x-upsert'], bytes: req.postDataBuffer(), url: req.url() })
    return json(route, { Key: `eligibility-scans/${path}`, Id: crypto.randomUUID() })
  })
  const ok = (extra = {}) => ({ ok: true, code: null, message: 'Done.', ...extra })
  const no = (code) => ({ ok: false, code, message: 'No.' })
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/team') return json(route, [mock.team])
    if (path === '/rest/v1/rpc/registration_form') return json(route, [mock.form])
    if (path === '/rest/v1/rpc/registration_rules') return json(route, [mock.rules])
    if (path === '/rest/v1/squad_entry') {
      return json(route, mock.players.map((p) => ({ team_id: TEAM, shirt_number: p.shirt, player: { id: p.id, name: p.name, date_of_birth: p.dob,
        version: p.version, photo_consent: [{ consent_given: p.consent, given_by: p.givenBy }] } })))
    }
    if (path === '/rest/v1/staff') return json(route, [])
    if (path === '/rest/v1/rpc/registration_eligibility') {
      return json(route, Object.entries(mock.records).map(([player_id, r]) => ({ id: r.id, player_id, document_type: r.document_type ?? null,
        document_number: r.document_number ?? null, scan_name: r.scan_name ?? null, verified: !!r.verified, version: r.version })))
    }
    const a = JSON.parse(req.postData() ?? '{}')
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    const fields = Object.fromEntries(['document_type', 'document_number', 'scan_path', 'scan_name'].filter((k) => a[k] != null).map((k) => [k, a[k]]))
    if (cmd === 'redeem_registration_link') return json(route, ok({ team_id: TEAM }))
    if (cmd === 'add_eligibility') {
      if (mock.records[a.player_id]) return json(route, no('eligibility_exists'))
      mock.records[a.player_id] = { id: a.record_id, ...fields, version: 1 }
      return json(route, ok())
    }
    if (cmd === 'edit_eligibility') {
      const r = mock.records[a.player_id]
      if (!r) return json(route, no('eligibility_missing'))
      if (r.version !== a.expected_version) return json(route, no('request_failed'))
      Object.assign(r, fields, { version: r.version + 1 })
      return json(route, ok({ version: r.version }))
    }
    return json(route, ok())
  })
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${base}/register#${TOKEN}`)
  await page.getByText(deadline === OPEN_DAY ? `Open until ${formatDay(OPEN_DAY)}.` : 'To change anything now, ask the organiser.', { exact: true }).waitFor()
  return { context, mock, page }
}

const text = (scope, t) => scope.getByText(t, { exact: true })
const calls = (mock, name) => mock.calls.filter((c) => c.cmd === name)
const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const card = (page, name) => page.locator('details.squad-card', { hasText: name })
const open = async (page, name) => {
  await card(page, name).locator('summary').click()
  return card(page, name)
}
const outbox = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('tsl-outbox')
  r.onsuccess = () => {
    const q = r.result.transaction('entries').objectStore('entries').getAll()
    q.onsuccess = () => res(q.result.map((e) => ({ name: e.name, state: e.state, upload: !!e.upload })))
  }
}))
/** A 3000×2000 JPEG photo of a "document", drawn in the page. */
const photo = async (page) => Buffer.from(await page.evaluate(() => {
  const c = document.createElement('canvas')
  c.width = 3000
  c.height = 2000
  const g = c.getContext('2d')
  g.fillStyle = 'white'
  g.fillRect(0, 0, 3000, 2000)
  g.fillStyle = 'black'
  g.fillRect(200, 200, 2600, 120)
  return c.toDataURL('image/jpeg', 0.9).split(',')[1]
}), 'base64')
const scanInput = (c) => c.locator('section.eligibility input[type=file]')
const DOCUMENT_TEXT = "Document didn't upload. Try again."

try {
  // --- First detail creates the record; the number and the scan edit it. The scan goes up resized, without upsert, to
  // the Player's folder, then the command names it; the card shows the file name only.
  {
    const { context, mock, page } = await fresh()
    await card(page, 'Bisho Basnet').getByText('document still needed').waitFor()
    const c = await open(page, 'Bisho Basnet')
    const type = c.getByLabel('Document type', { exact: true })
    assert.deepEqual(await type.locator('option').allTextContents(), ['Choose a document type', 'EMIS number', 'Birth certificate', 'Citizenship', 'Passport'])
    await type.selectOption('emis')
    await until(page, async () => calls(mock, 'add_eligibility').length === 1, 'add_eligibility not sent')
    const [add] = calls(mock, 'add_eligibility')
    assert.deepEqual([add.team_id, add.player_id, add.document_type, add.document_number], [TEAM, P1, 'emis', undefined])
    assert.match(add.record_id, new RegExp(`^${UUID}$`))
    // A required number: emptied, it says so and sends nothing.
    const num = c.getByLabel('Document number', { exact: true })
    await num.fill(' ')
    await num.blur()
    await text(c, 'Add the document number.').waitFor()
    await num.fill('430010248')
    await num.blur()
    await until(page, async () => calls(mock, 'edit_eligibility').length === 1, 'number not sent')
    const [e1] = calls(mock, 'edit_eligibility')
    assert.deepEqual([e1.player_id, e1.document_number, e1.expected_version, e1.scan_path], [P1, '430010248', 1, undefined])
    assert.equal(await c.getByText('Upload the document scan', { exact: true }).count(), 1)
    await scanInput(c).setInputFiles({ name: 'emis-bisho.jpg', mimeType: 'image/jpeg', buffer: await photo(page) })
    await until(page, async () => calls(mock, 'edit_eligibility').length === 2, 'scan command not sent')
    const [up] = mock.uploads
    assert.match(up.path, new RegExp(`^${TOURNAMENT}/${TEAM}/${P1}/${UUID}\\.webp$`), 'scan path')
    assert.equal(up.upsert, 'false', 'scan uploaded with upsert')
    const riff = up.bytes.indexOf('RIFF')
    assert.ok(riff >= 0 && up.bytes.toString('latin1', riff + 8, riff + 12) === 'WEBP', 'scan is not WebP')
    assert.ok(up.bytes.length <= 1048576, 'scan over 1 MiB')
    const width = await page.evaluate(async (b) => (await createImageBitmap(new Blob([Uint8Array.from(atob(b), (x) => x.charCodeAt(0))]))).width,
      up.bytes.subarray(riff).toString('base64'))
    assert.equal(width, 1600, 'scan not resized to 1600px')
    const e2 = calls(mock, 'edit_eligibility')[1]
    assert.deepEqual([e2.scan_path, e2.scan_name, e2.expected_version], [up.path, 'emis-bisho.jpg', 2])
    await text(c, 'emis-bisho.jpg').waitFor()
    await c.getByText('Uploaded · only the organiser sees it').waitFor()
    await c.getByText('Replace the document scan', { exact: true }).waitFor()
    await card(page, 'Bisho Basnet').getByText('EMIS number added').waitFor()
    // Story 2.7: the scan viewer and Mark verified don't exist for the Team manager.
    assert.equal(await page.getByRole('button', { name: /View document|Mark verified/ }).count(), 0, 'scan viewer shown to the Team manager')
    // Never the scan itself: no picture, no link, and its path nowhere on the page.
    assert.equal(await c.locator('img, a').count(), 0, 'scan shown or linked')
    assert.equal((await page.content()).includes(up.path.split('/').at(-1)), false, 'scan path on the page')
    assert.equal(await page.locator('.save-bar').count(), 1, 'no Save status')

    // A retry whose file is already there (409): done; the command follows.
    const d = await open(page, 'Dinesh Shrees')
    mock.storage.push([400, '409'])
    await scanInput(d).setInputFiles({ name: 'citizenship.png', mimeType: 'image/jpeg', buffer: await photo(page) })
    await until(page, async () => calls(mock, 'add_eligibility').length === 2, 'scan after 409 not sent')
    assert.deepEqual([calls(mock, 'add_eligibility')[1].player_id, calls(mock, 'add_eligibility')[1].scan_name], [P2, 'citizenship.png'])
    await text(d, 'citizenship.png').waitFor()

    // A refused upload: words in that Player's card only; nothing waits; the scan before stays.
    mock.storage.push([400, '403'])
    const sent = mock.calls.length
    await scanInput(c).setInputFiles({ name: 'new-scan.jpg', mimeType: 'image/jpeg', buffer: await photo(page) })
    await c.getByRole('alert').filter({ hasText: DOCUMENT_TEXT }).waitFor()
    assert.equal(await d.getByText(DOCUMENT_TEXT).count(), 0, 'upload failure shown on another card')
    assert.equal(mock.calls.length, sent, 'command sent after a refused upload')
    await until(page, async () => (await outbox(page)).length === 0, 'refused upload kept')
    await text(c, 'emis-bisho.jpg').waitFor()
    // Not a picture: said in words, nothing uploaded.
    const n = mock.uploads.length
    await scanInput(c).setInputFiles({ name: 'notes.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image') })
    await c.getByText("Couldn't read that picture. Take a photo of the document, or choose a JPEG, PNG or WebP picture.").waitFor()
    assert.equal(mock.uploads.length, n)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
    await context.close()
  }

  // --- Offline: the type and scan wait with their file; the file name shows at once and after a reload; on reconnect the
  // scan uploads, then the commands go in order, and the file leaves the phone.
  {
    const { context, mock, page } = await fresh()
    mock.down = true
    const c = await open(page, 'Bisho Basnet')
    await c.getByLabel('Document type', { exact: true }).selectOption('passport')
    await scanInput(c).setInputFiles({ name: 'passport.jpg', mimeType: 'image/jpeg', buffer: await photo(page) })
    await text(c, 'passport.jpg').waitFor()
    await page.getByText(/2 changes waiting to send/).first().waitFor()
    assert.deepEqual((await outbox(page)).map((e) => [e.name, e.upload]), [['add_eligibility', false], ['edit_eligibility', true]])
    await page.reload()
    await card(page, 'Bisho Basnet').locator('summary').click()
    await text(card(page, 'Bisho Basnet'), 'passport.jpg').waitFor()
    assert.equal(await card(page, 'Bisho Basnet').getByLabel('Document type', { exact: true }).inputValue(), 'passport')
    mock.down = false
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await until(page, async () => (await outbox(page)).length === 0, 'queued scan not sent')
    assert.equal(mock.uploads.length, 1)
    assert.deepEqual(mock.calls.filter((x) => /eligibility/.test(x.cmd)).map((x) => x.cmd), ['add_eligibility', 'edit_eligibility'])
    assert.equal(mock.records[P1].scan_path, mock.uploads[0].path)

    // Refused on replay: the hand-back sheet says the document didn't upload.
    mock.down = true
    await scanInput(card(page, 'Bisho Basnet')).setInputFiles({ name: 'again.jpg', mimeType: 'image/jpeg', buffer: await photo(page) })
    await page.getByText(/1 change waiting to send/).first().waitFor()
    mock.storage.push([400, '403'])
    mock.down = false
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.getByRole('button', { name: 'Review this change', exact: true }).click()
    await page.getByRole('dialog').getByText("Upload a Player's document scan", { exact: true }).waitFor()
    await page.getByRole('dialog').getByText(DOCUMENT_TEXT, { exact: true }).waitFor()
    await context.close()
  }

  // --- Verified: the card says so and offers no change.
  {
    const { context, page } = await fresh({ records: { [P1]: { id: 'r1', document_type: 'emis', document_number: '430010248', scan_name: 'emis.jpg', verified: true, version: 3 } } })
    const c = await open(page, 'Bisho Basnet')
    await text(c, 'Verified by the organiser.').waitFor()
    assert.equal(await c.locator('section.eligibility select, section.eligibility input').count(), 0, 'verified document editable')
    await context.close()
  }

  // --- Closed: the document type shows, never its number; no inputs.
  {
    const { context, page } = await fresh({ deadline: '2026-11-03',
      records: { [P1]: { id: 'r1', document_type: 'emis', document_number: '430010248', scan_name: 'emis.jpg', version: 2 } } })
    await text(page, 'Bisho Basnet · #7 · EMIS number · photo consent: Mina Basnet').waitFor()
    await text(page, 'Dinesh Shrees · #8 · no document · no photo consent').waitFor()
    assert.equal(await page.getByText(/430010248|emis\.jpg/).count(), 0, 'number or file name on a closed form')
    assert.equal(await page.locator('input, textarea, select, button').count(), 0, 'inputs on a closed form')
    const kept = await page.evaluate(() => localStorage.getItem('tsl-register-form') ?? '')
    assert.equal(kept.includes('430010248'), false, 'closed form keeps the document number on the phone')
    await context.close()
  }

  console.log('ok')
} finally {
  await browser.close()
  server.httpServer.close()
}
