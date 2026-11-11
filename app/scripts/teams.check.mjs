// Story 2.1 Teams check: the Teams tab (empty, loading, load failure, setup first, add with a suggested code, duplicate
// codes, offline add, share with and without Web Share) and the Team page (share elsewhere, reissue, revoke, refusals) in
// real Chrome, every UI row of the spec's I/O matrix; plus unit asserts of suggestCode and the link token.
// Supabase is mocked by route interception. `npm run check:teams`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'
import { CODE, newLink, suggestCode } from '../src/domain/teamCode.ts'

// --- Unit: code suggestion and the token.
assert.equal(suggestCode('Friends Sporting Wing'), 'FSW')
assert.equal(suggestCode('14 Star Youth Club'), '14SYC')
assert.equal(suggestCode('Ruru Kshetra Friends Club United Seven'), 'RKFCU')
assert.equal(suggestCode('Tamghas'), 'TAM')
assert.equal(suggestCode('  a-b '), 'AB')
assert.equal(suggestCode('X'), '')
assert.equal(suggestCode('तम्घास'), '')
assert.equal(suggestCode('Friends Sporting Wing', ['FSW']), 'FS2')
assert.equal(suggestCode('Friends Sporting Wing', ['FSW', 'FS2', 'FS3']), 'FS4')
for (const c of ['FSW', '14SYC', 'AB']) assert.ok(CODE.test(c), c)
for (const c of ['F', 'TOOLNG', 'fsw', 'F-W']) assert.ok(!CODE.test(c), c)
const links = await Promise.all(Array.from({ length: 50 }, () => newLink()))
for (const { token, hash } of links) {
  assert.match(token, /^[A-Za-z0-9_-]{43}$/) // 43 base64url characters = 256 bits
  assert.equal(hash, createHash('sha256').update(token, 'utf8').digest('hex'))
}
assert.equal(new Set(links.map((l) => l.token)).size, 50, 'tokens repeat')

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const FSW = '55555555-0000-4000-8000-000000000001'
const outDir = 'node_modules/.teams-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4187 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email: 'org@example.com', exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'org@example.com', email_confirmed_at: '2026-11-08T00:00:00Z',
    app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}
const seasonRow = (o = {}) => ({
  id: S, number: 1, status: 'setup', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
  starts_on: '2026-11-07', ends_on: '2026-11-21', registration_deadline: '2026-11-03', ...o,
})
const teamRow = (id, name, code, links = []) => ({ id, name, code, kit_colour: null, status: 'invited', registration_link: links })

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/**
 * A signed-in context. mock.teams: app.team rows (commands change them as the server would); mock.calls: every command
 * body (cmd: its name); mock.answers[cmd]: answers to give, in order; mock.down: Supabase unreachable; mock.teamsFail:
 * the next Team reads answer 500; mock.teamsDelay: ms before a Team read answers; mock.bodies: every request body.
 */
async function fresh({ season = {}, teams = [], share = 'none' } = {}) {
  const mock = { season: seasonRow(season), teams, answers: {}, calls: [], bodies: [], down: false, teamsFail: 0, teamsDelay: 0 }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (mock.down) return route.abort('internetdisconnected')
    if (req.postData()) mock.bodies.push(req.postData())
    const path = new URL(req.url()).pathname
    if (path === '/rest/v1/tournament') {
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [mock.season] }])
    }
    if (path === '/rest/v1/team') {
      assert.equal(new URL(req.url()).searchParams.get('season_id'), `eq.${S}`)
      if (mock.teamsDelay) await new Promise((r) => setTimeout(r, mock.teamsDelay))
      if (mock.teamsFail) return (mock.teamsFail--, route.fulfill({ status: 500, headers: cors, contentType: 'application/json', body: '{"message":"boom"}' }))
      // The open Team's form read (Story 2.6) embeds its Season and Tournament.
      return json(route, mock.teams.map((t) => ({ ...t, version: 1, tournament: { name: 'Gulmi Cup' }, season: mock.season })))
    }
    if (['/rest/v1/squad_entry', '/rest/v1/staff', '/rest/v1/eligibility_record'].includes(path)) return json(route, [])
    if (path === '/rest/v1/sponsor') return json(route, [])
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    const a = JSON.parse(req.postData())
    const cmd = path.replace('/rest/v1/rpc/', '')
    mock.calls.push({ ...a, cmd })
    const given = mock.answers[cmd]?.shift()
    if (given) return json(route, given)
    const t = mock.teams.find((x) => x.id === a.team_id)
    if (cmd === 'add_team') mock.teams.push(teamRow(a.team_id, a.name, a.code, [{ id: a.link_id, revoked_at: null }]))
    if (cmd === 'reissue_registration_link') {
      for (const l of t.registration_link) l.revoked_at ??= 'now'
      t.registration_link.push({ id: a.link_id, revoked_at: null })
    }
    if (cmd === 'revoke_registration_link') for (const x of mock.teams) for (const l of x.registration_link) if (l.id === a.link_id) l.revoked_at = 'now'
    if (cmd === 'open_registration') mock.season.status = 'registration'
    return json(route, { ok: true, code: null, message: 'Done.' })
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
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
const refused = (code) => ({ ok: false, code, message: 'No.' })
/** The token kept on this phone for a link id, as { linkId, token }, or null. */
const kept = async (page, linkId) => {
  const token = await page.evaluate((k) => localStorage.getItem(k), `tsl-link:${linkId}`)
  return token ? { linkId, token } : null
}
const outbox = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('tsl-outbox')
  r.onsuccess = () => {
    const q = r.result.transaction('entries').objectStore('entries').getAll()
    q.onsuccess = () => res(q.result.map((e) => [e.name, e.state, e.code ?? null]))
  }
}))
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const teamsTab = async (page) => {
  await page.goto(base + `/t/${T}`)
  await page.getByRole('tab', { name: 'Teams' }).click()
}
const deadlineWords = /Open until Tuesday · Kartik 17, 2083 BS \(3 Nov 2026\)\./

try {
  // --- Empty tab: skeleton rows while loading, then the empty state; a failed load says so and loads again.
  {
    const { context, mock, page } = await fresh()
    mock.teamsDelay = 800
    mock.teamsFail = 1
    await teamsTab(page)
    await page.locator('.skeleton-row').first().waitFor()
    await text(page, "Couldn't load the Teams. Try loading them again.").waitFor()
    mock.teamsDelay = 0
    await button(page, 'Try loading again').click()
    await text(page, 'Add your Teams to send each one its Registration link.').waitFor()
    await noScroll(page)
    await context.close()
  }

  // --- A Team its manager sent for review (Story 2.3): its row shows the Submitted pill.
  {
    const { context, page } = await fresh({ teams: [{ ...teamRow('55555555-0000-4000-8000-0000000000f1', 'Sent FC', 'SFC'), status: 'submitted' }] })
    await teamsTab(page)
    await page.locator('.team-row', { hasText: 'Sent FC' }).getByText('Submitted', { exact: true }).waitFor()
    await context.close()
  }

  // --- Setup incomplete: no deadline → the tab asks to finish setup, with no form.
  {
    const { context, page } = await fresh({ season: { registration_deadline: null } })
    await teamsTab(page)
    await text(page, 'Finish setup before adding Teams: add the photo-consent statement and the Season dates.').waitFor()
    assert.equal(await page.getByLabel('Team name').count(), 0, 'form shown')
    await button(page, 'Continue setup').click()
    await page.waitForURL((u) => u.pathname === `/t/${T}/settings/dates`)
    await context.close()
  }

  // --- Add: the code follows the name, the row shows dot, name, code, Invited and Share link; add_team carries only the
  // hash of the token kept on this device; the first Team opens registration (once). Share hands link + message to Web Share.
  {
    const { context, mock, page } = await fresh({ share: 'record' })
    await teamsTab(page)
    await text(page, 'Add your Teams to send each one its Registration link.').waitFor()
    await button(page, 'Add this Team').click()
    await text(page, "Add the Team's name.").waitFor()
    assert.equal(calls(mock, 'add_team').length, 0)
    await page.getByLabel('Team name').fill('Friends Sporting Wing')
    await page.getByLabel('Team name').blur()
    assert.equal(await page.getByLabel('Team code').inputValue(), 'FSW')
    await button(page, 'Add this Team').click()
    const row = page.locator('.team-row', { hasText: 'Friends Sporting Wing' })
    await row.waitFor()
    await row.getByText('FSW', { exact: true }).waitFor()
    await row.getByText('Invited', { exact: true }).waitFor()
    assert.equal(await row.locator('.ui-kit-dot').count(), 1)
    await button(page, 'Share link for Friends Sporting Wing').waitFor()
    const [sent] = calls(mock, 'add_team')
    assert.equal(sent.season_id, S)
    assert.equal(sent.code, 'FSW')
    assert.match(sent.token_hash, /^[0-9a-f]{64}$/)
    const k = await kept(page, sent.link_id)
    assert.equal(sha(k.token), sent.token_hash)
    assert.ok(mock.bodies.every((b) => !b.includes(k.token)), 'token sent to the server')
    await until(page, async () => calls(mock, 'open_registration').length === 1, 'registration not opened')
    assert.equal(calls(mock, 'open_registration')[0].season_id, S)
    await page.getByText(/Season 1 · Registration/).waitFor()
    // The code field is empty again and follows the next name; a second Team doesn't open registration again.
    assert.equal(await page.getByLabel('Team code').inputValue(), '')
    await page.getByLabel('Team name').fill('14 Star Youth Club')
    await page.getByLabel('Team code').fill('star')
    await button(page, 'Add this Team').click()
    await page.locator('.team-row', { hasText: '14 Star Youth Club' }).getByText('STAR', { exact: true }).waitFor()
    assert.equal(calls(mock, 'add_team')[1].code, 'STAR')
    assert.equal(calls(mock, 'open_registration').length, 1)
    // Share.
    await button(page, 'Share link for Friends Sporting Wing').click()
    await until(page, () => page.evaluate(() => !!window.__shared), 'nothing shared')
    const shared = await page.evaluate(() => window.__shared)
    assert.equal(shared.url, `${base}/register#${k.token}`)
    assert.match(shared.text, /^Register Friends Sporting Wing for Gulmi Cup Season 1\. Open this link to add your Players and Staff\. /)
    assert.match(shared.text, deadlineWords)
    await noScroll(page)
    await context.close()
  }

  // --- Duplicate code: suggested past a taken code, refused in words before sending when typed; server refusal in words.
  // No Web Share: link and message are copied.
  {
    const { context, mock, page } = await fresh({ season: { status: 'registration' } })
    await teamsTab(page)
    await text(page, 'Add your Teams to send each one its Registration link.').waitFor()
    await page.getByLabel('Team name').fill('Friends Sporting Wing')
    await button(page, 'Add this Team').click()
    await page.locator('.team-row', { hasText: 'FSW' }).waitFor()
    assert.equal(calls(mock, 'open_registration').length, 0, 'opened an open Season')
    await page.getByLabel('Team name').fill('Friends Social Wing')
    await page.getByLabel('Team name').blur()
    assert.equal(await page.getByLabel('Team code').inputValue(), 'FS2')
    await page.getByLabel('Team code').fill('fsw')
    await page.getByLabel('Team code').blur()
    await text(page, 'FSW is already used by Friends Sporting Wing. Choose another code.').waitFor()
    await button(page, 'Add this Team').click()
    assert.equal(calls(mock, 'add_team').length, 1, 'duplicate sent')
    mock.answers.add_team = [refused('team_code_taken')]
    await page.getByLabel('Team code').fill('FSO')
    await button(page, 'Add this Team').click()
    await page.getByRole('alert').getByText('That Team code is already used in this Season. Choose another code.', { exact: true }).waitFor()
    await until(page, async () => (await outbox(page)).length === 0, 'refused add left in the outbox')
    assert.equal(await page.locator('.team-row').count(), 1)
    await button(page, 'Share link for Friends Sporting Wing').click()
    await page.getByText(/^Link and message copied\./).waitFor()
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    const tok = (await kept(page, calls(mock, 'add_team')[0].link_id)).token
    assert.ok(clip.endsWith(`\n${base}/register#${tok}`), clip)
    assert.match(clip, deadlineWords)
    await context.close()
  }

  // --- Offline: the row shows at once and both commands send when the signal is back.
  {
    const { context, mock, page } = await fresh()
    await teamsTab(page)
    await text(page, 'Add your Teams to send each one its Registration link.').waitFor()
    mock.down = true
    await context.setOffline(true)
    await page.getByLabel('Team name').fill('Tamghas United')
    await button(page, 'Add this Team').click()
    await page.locator('.team-row', { hasText: 'Tamghas United' }).getByText('TU', { exact: true }).waitFor()
    await page.getByText(/Tamghas United will be added when the signal is back\./).waitFor()
    assert.deepEqual((await outbox(page)).map((e) => e[0]), ['add_team', 'open_registration'])
    mock.down = false
    await context.setOffline(false)
    await until(page, async () => calls(mock, 'open_registration').length === 1, 'queued commands not sent')
    assert.equal(calls(mock, 'add_team').length, 1)
    await context.close()
  }

  // --- Share elsewhere: a link made on another phone opens the Team page, which offers a new link (Confirm sheet on
  // Cancel); the new link shows and shares. Reissue replaces it; a refusal puts the old token back; revoke ends it.
  {
    const { context, mock, page } = await fresh({ season: { status: 'registration' },
      teams: [teamRow(FSW, 'Friends Sporting Wing', 'FSW', [{ id: '66666666-0000-4000-8000-000000000001', revoked_at: null }])] })
    await teamsTab(page)
    await button(page, 'Share link for Friends Sporting Wing').click()
    await page.waitForURL((u) => u.pathname === `/t/${T}/teams/${FSW}`)
    await page.getByRole('heading', { name: 'Friends Sporting Wing', level: 2 }).waitFor()
    await page.getByText(/^This phone doesn't have this Team's link\./).waitFor()
    await button(page, 'Make a new link').click()
    const sheet = page.getByRole('dialog', { name: 'Make a new link for Friends Sporting Wing?' })
    assert.ok(await sheet.getByRole('button', { name: 'Cancel', exact: true }).evaluate((el) => el === document.activeElement), 'sheet not on Cancel')
    await sheet.getByRole('button', { name: 'Make a new link', exact: true }).click()
    const link = page.getByLabel('Registration link for Friends Sporting Wing')
    await link.waitFor()
    const [r1] = calls(mock, 'reissue_registration_link')
    assert.deepEqual([r1.season_id, r1.team_id], [S, FSW])
    const k1 = await kept(page, r1.link_id)
    assert.equal(await link.inputValue(), `${base}/register#${k1.token}`)
    assert.equal(sha(k1.token), r1.token_hash)
    // Reissue with the token here.
    await button(page, 'Reissue link').click()
    await page.getByRole('dialog', { name: 'Make a new link for Friends Sporting Wing?' }).getByRole('button', { name: 'Make a new link', exact: true }).click()
    await text(page, 'New link made. The old link no longer works.').waitFor()
    const k2 = await kept(page, calls(mock, 'reissue_registration_link')[1].link_id)
    assert.notEqual(k2.token, k1.token)
    await until(page, async () => (await link.inputValue()) === `${base}/register#${k2.token}`, 'new link not shown')
    // Another tenant's (or a removed Organiser's) reissue is refused in words; the link here stays as it was.
    mock.answers.reissue_registration_link = [refused('not_authorized')]
    await button(page, 'Reissue link').click()
    await page.getByRole('dialog', { name: 'Make a new link for Friends Sporting Wing?' }).getByRole('button', { name: 'Make a new link', exact: true }).click()
    await page.getByRole('alert').getByText("Only this tournament's organisers can change it.", { exact: true }).waitFor()
    assert.deepEqual(await kept(page, k2.linkId), k2)
    assert.equal(await kept(page, calls(mock, 'reissue_registration_link')[2].link_id), null, 'refused link kept')
    assert.equal(await link.inputValue(), `${base}/register#${k2.token}`)
    // Revoke.
    await button(page, 'Revoke link').click()
    await page.getByRole('dialog', { name: 'Revoke the link for Friends Sporting Wing?' }).getByRole('button', { name: 'Revoke link', exact: true }).click()
    await text(page, 'The link for Friends Sporting Wing no longer works.').waitFor()
    assert.equal(calls(mock, 'revoke_registration_link')[0].link_id, k2.linkId)
    await text(page, 'This Team has no working link.').waitFor()
    assert.equal(await kept(page, k2.linkId), null)
    assert.equal(await button(page, 'Revoke link').count(), 0)
    await button(page, 'Make a new link').waitFor()
    // Offline: a new link shows at once (laid over the read) and a revoke shows no working link while both wait to send.
    mock.down = true
    await context.setOffline(true)
    await button(page, 'Make a new link').click()
    await page.getByText(/The new link works once it's sent/).waitFor()
    const k3 = await kept(page, (await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('tsl-outbox')
      r.onsuccess = () => {
        const q = r.result.transaction('entries').objectStore('entries').getAll()
        q.onsuccess = () => res(q.result.find((e) => e.name === 'reissue_registration_link').args.link_id)
      }
    }))))
    await until(page, async () => (await link.count()) === 1 && (await link.inputValue()) === `${base}/register#${k3.token}`, 'queued link not shown')
    await button(page, 'Revoke link').click()
    await page.getByRole('dialog', { name: 'Revoke the link for Friends Sporting Wing?' }).getByRole('button', { name: 'Revoke link', exact: true }).click()
    await text(page, 'This Team has no working link.').waitFor()
    assert.deepEqual(await kept(page, k3.linkId), k3, 'token forgotten before the revoke was sent')
    mock.down = false
    await context.setOffline(false)
    await until(page, async () => calls(mock, 'revoke_registration_link').length === 2, 'queued revoke not sent')
    await noScroll(page)
    await button(page, 'Back to Teams').click()
    await page.waitForURL((u) => u.pathname === `/t/${T}`)
    assert.equal(await page.getByRole('tab', { name: 'Teams' }).getAttribute('aria-selected'), 'true')
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
