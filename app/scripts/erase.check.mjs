// Story 2.10 check: an Organiser opens a Player card with a photo, date of birth, guardian's name and an Eligibility
// document, taps "Delete personal details" and gets the destructive Confirm sheet: it opens with focus on Cancel and says
// "Backups keep it for up to 30 days."; Cancel sends nothing; confirming sends erase_player_personal_data (versioned on the
// Player) and the card then shows no photo, date of birth, guardian or document number, and no delete button. A Player with
// nothing personal left has no button. (The Team manager never sees it: check:eligibility.) Real Chrome, Supabase mocked
// by route interception. `npm run check:erase`.
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
const PHOTO = `${T}/${TEAM}/${P1}/d2111111-0000-4000-8000-000000000001.webp`
const outDir = 'node_modules/.erase-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4196 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email: 'org@example.com', exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'org@example.com', email_confirmed_at: '2026-11-08T00:00:00Z',
    app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#ddd"/></svg>'
const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

const season = { id: S, number: 1, status: 'registration', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
  starts_on: '2026-11-07', ends_on: '2026-11-21', registration_deadline: '2026-11-03', starters: 2, max_bench: 1, staff_roles: ['manager', 'coach'] }
const mock = {
  players: [
    { id: P1, name: 'Bisho Basnet', shirt: 4, date_of_birth: '2012-03-04', version: 2, photo_path: PHOTO, is_cutout: true,
      photo_consent: [{ season_id: S, consent_given: true, given_by: 'Mina Basnet' }] },
    // Gita: nothing personal left (erased before).
    { id: P2, name: 'Gita Rana', shirt: 5, date_of_birth: null, version: 3, photo_path: null, is_cutout: null, photo_consent: [] },
  ],
  records: [{ id: R1, player_id: P1, document_type: 'emis', document_number: '430010248', scan_name: 'emis-bisho.jpg', scan_path: null,
    scan_uploaded_at: null, verified_at: null, version: 1 }],
  calls: [],
}
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
const json = (route, data, s = 200) => route.fulfill({ status: s, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
  ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
await context.route(`${SUPA}/storage/v1/**`, (route) => {
  const req = route.request()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  if (req.method() === 'POST') {
    const { paths } = JSON.parse(req.postData() ?? '{}')
    return json(route, (paths ?? []).map((path) => ({ path, signedURL: `/object/sign/player-photos/${path}?token=t`, error: null })))
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
    return json(route, mock.players.map(({ shirt, ...player }) => ({ team_id: TEAM, shirt_number: shirt, player })))
  }
  if (path === '/rest/v1/eligibility_record') return json(route, mock.records)
  if (path === '/rest/v1/staff' || path === '/rest/v1/sponsor') return json(route, [])
  if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
  const a = JSON.parse(req.postData() ?? '{}')
  const cmd = path.replace('/rest/v1/rpc/', '')
  mock.calls.push({ ...a, cmd })
  if (cmd === 'erase_player_personal_data') {
    const p = mock.players.find((x) => x.id === a.player_id)
    Object.assign(p, { date_of_birth: null, photo_path: null, is_cutout: null, version: p.version + 1,
      photo_consent: [{ season_id: S, consent_given: false, given_by: null }] })
    for (const r of mock.records.filter((x) => x.player_id === a.player_id)) Object.assign(r, { document_number: null, scan_name: null, version: r.version + 1 })
    return json(route, { ok: true, code: null, message: 'Personal details deleted.', version: p.version })
  }
  return json(route, { ok: true, code: null, message: 'Done.' })
})
await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))

const until = async (page, fn, what, ms = 8000) => {
  for (const t = Date.now(); !(await fn()); await page.waitForTimeout(50)) if (Date.now() - t > ms) assert.fail(`timed out: ${what}`)
}
const erases = () => mock.calls.filter((c) => c.cmd === 'erase_player_personal_data')

try {
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${base}/t/${T}/teams/${TEAM}`)
  await page.getByText('Players · 2', { exact: true }).waitFor()
  const c = page.locator('details.squad-card', { hasText: 'Bisho Basnet' })
  await c.locator('summary').click()
  await c.locator('img').first().waitFor()
  const has = (v) => c.locator('input').evaluateAll((xs, w) => xs.some((x) => x.value === w), v)
  const hasNumber = () => has('430010248')
  await until(page, hasNumber, 'document number not shown')
  assert.equal(await has('Mina Basnet'), true, 'guardian not shown')
  await c.getByLabel('Date of birth').waitFor()
  assert.equal(await c.getByLabel('Date of birth').inputValue(), '2012-03-04')
  const del = c.getByRole('button', { name: 'Delete personal details of Bisho Basnet', exact: true })

  // The Confirm sheet: names the Player and what goes, the 30-day backup line, focus on Cancel; Cancel sends nothing.
  await del.click()
  const sheet = page.getByRole('dialog')
  await sheet.getByText("Delete Bisho Basnet's personal details?", { exact: true }).waitFor()
  assert.match(await sheet.innerText(), /Bisho Basnet's photo, date of birth, guardian's name and document/)
  assert.match(await sheet.innerText(), /Backups keep it for up to 30 days\./)
  await until(page, () => page.evaluate(() => document.activeElement?.textContent === 'Cancel'), 'focus not on Cancel')
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click()
  await until(page, async () => (await page.getByRole('dialog').count()) === 0, 'sheet not closed')
  assert.equal(erases().length, 0, 'Cancel sent the erase')

  // Confirm: versioned on the Player; the card then holds nothing personal and offers no second delete.
  await del.click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete personal details', exact: true }).click()
  await until(page, async () => erases().length === 1, 'erase not sent')
  const e = erases()[0]
  assert.deepEqual([e.team_id, e.player_id, e.expected_version], [TEAM, P1, 2])
  await until(page, async () => (await del.count()) === 0, 'delete button still shown after the erase')
  assert.equal(await c.locator('img').count(), 0, 'photo still shown')
  assert.equal(await c.getByLabel('Date of birth').inputValue(), '', 'date of birth still shown')
  assert.equal(await c.getByText('Mina Basnet').count() + Number(await has('Mina Basnet')), 0, 'guardian still shown')
  assert.equal(await hasNumber(), false, 'document number still shown')
  await c.getByText('Bisho Basnet · #4').waitFor()

  // Nothing personal: no button.
  const g = page.locator('details.squad-card', { hasText: 'Gita Rana' })
  await g.locator('summary').click()
  assert.equal(await g.getByRole('button', { name: /Delete personal details/ }).count(), 0, 'button shown with nothing to delete')
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
