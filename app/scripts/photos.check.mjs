// Story 2.5 photo check: on /register#<token> a Team manager adds a Player's or Staff member's photo. The card shows it
// with "Removing background…", the segmenter (stubbed here with window.tslSegment, so CI never downloads MediaPipe) cuts
// the person out, and the transparent WebP is uploaded without upsert to <tournament>/<team>/<person>/<uuid>.webp in
// player-photos before set_photo. Failure offers "Try removing the background again" / "Keep the photo with its
// background" (is_cutout false); a refused upload is said in that card only; a stored photo downloads as PNG. Also: no
// AGPL package or @imgly code ships, and MediaPipe stays out of the main chunk. `npm run check:photos`.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

// --- Licences and bundle: no AGPL package (incl. @imgly/background-removal) installed; MediaPipe lazy and self-hosted.
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const agpl = Object.entries(lock.packages).filter(([k, p]) => k.includes('@imgly/') || /AGPL/i.test(String(p.license ?? '')))
assert.deepEqual(agpl.map(([k]) => k), [], 'AGPL package in package-lock.json')
assert.equal(lock.packages['node_modules/@mediapipe/tasks-vision']?.license, 'Apache-2.0')

const SUPA = 'https://fake.supabase.co'
const ANON = '00000000-0000-4000-8000-0000000000a1'
const TOURNAMENT = '11111111-0000-4000-8000-000000000001'
const TEAM = '55555555-0000-4000-8000-000000000001'
const P1 = '91111111-0000-4000-8000-000000000001'
const P2 = '91111111-0000-4000-8000-000000000002'
const SF1 = 'a1111111-0000-4000-8000-000000000001'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const outDir = 'node_modules/.photos-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const js = readdirSync(`${outDir}/assets`).filter((f) => f.endsWith('.js'))
for (const f of js) assert.ok(!readFileSync(`${outDir}/assets/${f}`, 'utf8').includes('@imgly'), `@imgly in ${f}`)
const main = js.filter((f) => f.startsWith('main-') || f.startsWith('index-'))
assert.ok(main.length && main.every((f) => !readFileSync(`${outDir}/assets/${f}`, 'utf8').includes('wasmLoaderPath')), 'MediaPipe in the main chunk')
assert.ok(js.some((f) => readFileSync(`${outDir}/assets/${f}`, 'utf8').includes('wasmLoaderPath')), 'no lazy MediaPipe chunk')
assert.ok(existsSync(`${outDir}/mediapipe/selfie_segmenter.tflite`), 'model not self-hosted')
// `npm run build` (prebuild) self-hosts the wasm too.
if (existsSync('dist')) assert.ok(existsSync('dist/mediapipe/vision_wasm_internal.wasm'), 'wasm not self-hosted in dist')

const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4191 } })
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

/**
 * A context with the Team manager's grant and a stub segmenter: a person in the middle third of the picture after
 * window.tslDelay ms; window.tslFail failures first. mock.photos: stored photos by person id ({ path, cutout, bytes });
 * mock.uploads; mock.storage: [HTTP status, body statusCode] answers for the next uploads; mock.calls: commands.
 */
async function fresh({ photos = {} } = {}) {
  const mock = { photos, uploads: [], storage: [], calls: [], versions: { [P1]: 1, [P2]: 1, [SF1]: 1 }, requests: [] }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, acceptDownloads: true })
  await context.addInitScript(() => {
    window.tslDelay = 300
    window.tslFail = 0
    window.tslSegment = async (c) => {
      await new Promise((r) => setTimeout(r, window.tslDelay))
      if (window.tslFail > 0) {
        window.tslFail--
        throw new Error('stub failure')
      }
      const m = new Float32Array(c.width * c.height)
      for (let y = Math.floor(c.height / 3); y < (2 * c.height) / 3; y++) m.fill(1, y * c.width + Math.floor(c.width / 3), y * c.width + Math.floor((2 * c.width) / 3))
      return m
    }
  })
  context.on('request', (r) => mock.requests.push(r.url()))
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  await context.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({
    contentType: 'text/javascript', body: `window.turnstile = { render(el, o) { setTimeout(() => o.callback('tok')); return 'w' }, remove() {} }`,
  }))
  const json = (route, data, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session(ANON)))
  await context.route(`${SUPA}/storage/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const url = new URL(req.url())
    if (url.pathname === '/storage/v1/object/sign/player-photos') {
      const { paths } = JSON.parse(req.postData())
      return json(route, paths.map((path) => ({ path, signedURL: `/object/sign/player-photos/${path}?token=t`, error: null })))
    }
    if (url.pathname.startsWith('/storage/v1/object/sign/player-photos/')) {
      const path = decodeURIComponent(url.pathname.replace('/storage/v1/object/sign/player-photos/', ''))
      const p = Object.values(mock.photos).find((x) => x.path === path)
      return route.fulfill({ status: p ? 200 : 404, headers: cors, contentType: 'image/webp', body: p?.bytes ?? '' })
    }
    const path = decodeURIComponent(url.pathname.replace('/storage/v1/object/player-photos/', ''))
    const fail = mock.storage.shift()
    if (fail) {
      mock.uploads.push({ path, failed: fail[0] })
      return route.fulfill({ status: fail[0], headers: cors, contentType: 'application/json',
        body: JSON.stringify({ statusCode: fail[1], error: 'Refused', message: 'new row violates row-level security policy' }) })
    }
    mock.uploads.push({ path, upsert: req.headers()['x-upsert'], bytes: req.postDataBuffer() })
    return json(route, { Key: `player-photos/${path}`, Id: crypto.randomUUID() })
  })
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(req.url()).pathname
    const photo = (id) => ({ photo_path: mock.photos[id]?.path ?? null, is_cutout: mock.photos[id]?.cutout ?? null })
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/team') return json(route, [{ id: TEAM, tournament_id: TOURNAMENT, name: 'Friends Sporting Wing', code: 'FSW', kit_colour: null, status: 'invited', version: 1 }])
    if (path === '/rest/v1/rpc/registration_form') return json(route, [{ tournament_name: 'Gulmi Cup', season_number: 1, season_status: 'registration', registration_deadline: '2033-11-03' }])
    if (path === '/rest/v1/rpc/registration_rules') return json(route, [{ consent_statement: 'Photos may be used.', starters: 2, max_bench: 1, staff_roles: ['manager'] }])
    if (path === '/rest/v1/squad_entry') {
      return json(route, [[P1, 'Bisho Basnet', 7], [P2, 'Dinesh Shrees', 8]].map(([id, name, shirt]) => ({ team_id: TEAM, shirt_number: shirt,
        player: { id, name, date_of_birth: '2000-01-01', version: mock.versions[id], ...photo(id), photo_consent: [{ consent_given: true, given_by: name }] } })))
    }
    if (path === '/rest/v1/staff') return json(route, [{ team_id: TEAM, id: SF1, name: 'Ram Thapa', role: 'manager', version: mock.versions[SF1], ...photo(SF1) }])
    if (path === '/rest/v1/rpc/registration_eligibility') return json(route, [])
    const a = JSON.parse(req.postData() ?? '{}')
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    if (cmd === 'set_photo') {
      if (mock.versions[a.person_id] !== a.expected_version) return json(route, { ok: false, code: 'request_failed', message: 'No.' })
      const up = mock.uploads.find((u) => u.path === a.photo_path)
      mock.photos[a.person_id] = { path: a.photo_path, cutout: a.is_cutout, bytes: up?.bytes.subarray(up.bytes.indexOf('RIFF')) } // the WebP inside the multipart body
      return json(route, { ok: true, code: null, message: 'Photo saved.', version: ++mock.versions[a.person_id] })
    }
    return json(route, { ok: true, code: null, message: 'Done.', team_id: TEAM })
  })
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${base}/register#${TOKEN}`)
  await page.getByText('Players · 2').waitFor()
  return { context, mock, page }
}

const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const card = (page, name) => page.locator('details.squad-card', { hasText: name })
const open = async (page, name) => {
  await card(page, name).locator('summary').click()
  return card(page, name)
}
const calls = (mock) => mock.calls.filter((c) => c.cmd === 'set_photo')
/** A 2000×3000 JPEG "portrait", drawn in the page. */
const portrait = async (page) => Buffer.from(await page.evaluate(() => {
  const c = document.createElement('canvas')
  c.width = 2000
  c.height = 3000
  const g = c.getContext('2d')
  g.fillStyle = 'green'
  g.fillRect(0, 0, 2000, 3000)
  g.fillStyle = 'orange'
  g.fillRect(700, 1000, 600, 1000)
  return c.toDataURL('image/jpeg', 0.9).split(',')[1]
}), 'base64')
const pick = async (page, c) => c.locator('section.photo input[type=file]').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: await portrait(page) })
/** width, height and the alpha of the corner and the centre of a stored image. */
const decode = (page, bytes) => page.evaluate(async (b) => {
  const img = await createImageBitmap(new Blob([Uint8Array.from(atob(b), (x) => x.charCodeAt(0))]))
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0)
  return { width: img.width, height: img.height, corner: g.getImageData(0, 0, 1, 1).data[3], centre: g.getImageData(img.width >> 1, img.height >> 1, 1, 1).data[3] }
}, bytes.toString('base64'))
const PHOTO_TEXT = "Photo didn't upload. Try again."

try {
  // --- Add photo: shown with "Removing background…", then the cut-out goes up as transparent WebP, then set_photo.
  {
    const { context, mock, page } = await fresh()
    assert.equal(mock.requests.some((u) => /mediapipe|vision_bundle/.test(u)), false, 'MediaPipe loaded before the photo screen was used')
    const c = await open(page, 'Bisho Basnet')
    await c.locator('label', { hasText: 'Add photo' }).waitFor()
    await pick(page, c)
    await c.getByRole('status').filter({ hasText: 'Removing background…' }).waitFor()
    await c.locator('img.photo-image').waitFor()
    await until(page, async () => calls(mock).length === 1, 'set_photo not sent')
    const [up] = mock.uploads
    assert.match(up.path, new RegExp(`^${TOURNAMENT}/${TEAM}/${P1}/${UUID}\\.webp$`), 'photo path')
    assert.equal(up.upsert, 'false', 'photo uploaded with upsert')
    const riff = up.bytes.indexOf('RIFF')
    assert.ok(riff >= 0 && up.bytes.toString('latin1', riff + 8, riff + 12) === 'WEBP', 'photo is not WebP')
    const img = await decode(page, up.bytes.subarray(riff))
    assert.deepEqual(img, { width: 683, height: 1024, corner: 0, centre: 255 }, 'not a transparent 1024px cut-out')
    const [s] = calls(mock)
    assert.deepEqual([s.team_id, s.person_id, s.photo_path, s.is_cutout, s.expected_version], [TEAM, P1, up.path, true, 1])
    await c.getByText('Background removed', { exact: true }).waitFor()
    await c.locator('label', { hasText: 'Change photo' }).waitFor()
    assert.equal(await c.getByRole('status').filter({ hasText: 'Removing background…' }).count(), 0)
    assert.equal(mock.requests.some((u) => /mediapipe|vision_bundle/.test(u)), false, 'real MediaPipe loaded despite the stub')

    // Download: the stored photo comes out as PNG.
    const [download] = await Promise.all([page.waitForEvent('download'), c.getByRole('button', { name: 'Download the photo as PNG' }).click()])
    assert.equal(download.suggestedFilename(), 'Bisho Basnet.png')
    const png = readFileSync(await download.path())
    assert.equal(png.toString('latin1', 1, 4), 'PNG', 'download is not PNG')

    // A Staff member's photo: the same, under their id.
    const st = await open(page, 'Ram Thapa')
    await pick(page, st)
    await until(page, async () => calls(mock).length === 2, 'Staff set_photo not sent')
    assert.deepEqual([calls(mock)[1].person_id, calls(mock)[1].is_cutout], [SF1, true])
    assert.match(mock.uploads[1].path, new RegExp(`^${TOURNAMENT}/${TEAM}/${SF1}/${UUID}\\.webp$`))

    // Upload refused: said in that card only; no command; other cards unaffected.
    const d = await open(page, 'Dinesh Shrees')
    mock.storage.push([400, '403'])
    await pick(page, d)
    await d.getByRole('alert').filter({ hasText: PHOTO_TEXT }).waitFor()
    assert.equal(await page.getByText(PHOTO_TEXT).count(), 1, 'upload failure shown on another card')
    assert.equal(calls(mock).length, 2, 'command sent after a refused upload')
    await c.getByText('Background removed', { exact: true }).waitFor()

    // Not a picture: said in words, nothing uploaded.
    const n = mock.uploads.length
    await d.locator('section.photo input[type=file]').setInputFiles({ name: 'x.heic', mimeType: 'image/heic', buffer: Buffer.from('not an image') })
    await d.getByText("Couldn't read that photo. Take a new one, or choose a JPEG, PNG, HEIC or WebP picture.").waitFor()
    assert.equal(mock.uploads.length, n)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'horizontal scroll')
    await context.close()
  }

  // --- Removal fails: assertive words with both choices; trying again cuts out; keeping stores is_cutout false.
  {
    const { context, mock, page } = await fresh()
    const c = await open(page, 'Bisho Basnet')
    await page.evaluate(() => (window.tslFail = 1))
    await pick(page, c)
    await c.getByRole('alert').filter({ hasText: "Couldn't remove the background." }).waitFor()
    assert.equal(mock.uploads.length, 0)
    await c.getByRole('button', { name: 'Try removing the background again' }).click()
    await until(page, async () => calls(mock).length === 1, 'retry not sent')
    assert.equal(calls(mock)[0].is_cutout, true)

    // No clear person (an empty mask) fails too; keep it with its background.
    await page.evaluate(() => {
      const real = window.tslSegment
      window.tslSegment = async (cv) => ((window.tslSegment = real), new Float32Array(cv.width * cv.height))
    })
    await pick(page, c)
    await c.getByRole('alert').filter({ hasText: "Couldn't remove the background." }).waitFor()
    await c.getByRole('button', { name: 'Keep the photo with its background' }).click()
    await until(page, async () => calls(mock).length === 2, 'keep not sent')
    const [, k] = calls(mock)
    assert.deepEqual([k.is_cutout, k.expected_version], [false, 2])
    const kept = await decode(page, mock.uploads[1].bytes.subarray(mock.uploads[1].bytes.indexOf('RIFF')))
    assert.deepEqual([kept.corner, kept.centre], [255, 255], 'kept photo lost its background')
    await c.getByText('Kept with its background', { exact: true }).waitFor()
    await context.close()
  }

  console.log('ok')
} finally {
  await browser.close()
  server.httpServer.close()
}
