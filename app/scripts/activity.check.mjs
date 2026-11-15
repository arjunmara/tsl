// Story 3.7 Activity log check: rows in words (kick-off old struck through, personal field without a value), who and when in BS and AD,
// Team/Match/person chips that combine and clear, links, pages of 50, empty, offline. Real Chrome, Supabase mocked by route interception.
// `npm run check:activity`. Needs Google Chrome.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const SUPA = 'https://fake.supabase.co'
const ME = '00000000-0000-4000-8000-000000000001'
const T = '22222222-0000-4000-8000-000000000001'
const S = '22222222-0000-4000-8000-000000000009'
const outDir = 'node_modules/.activity-dist'
Object.assign(process.env, { VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
delete process.env.VITE_APP_URL
await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } })
const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { port: 4199 } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, email: 'org@example.com', exp, role: 'authenticated', aud: 'authenticated' })}.sig`
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'org@example.com', email_confirmed_at: '2026-11-08T00:00:00Z',
    app_metadata: {}, user_metadata: {}, identities: [{ id: 'i1' }], created_at: '2026-11-08T00:00:00Z' }
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt', user }
}
const tid = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`
const M = '66666666-0000-4000-8000-000000000001'
const teamRow = (n, code) => ({ id: tid(n), name: `Team ${code}`, code, kit_colour: '#1d4ed8', status: 'approved', registration_link: [], version: 1 })
const ORG = 'org@example.com'
const HELPER = 'helper@example.com'
// 120 rows, newest (highest id) first. 120: kick-off move; 119: a Player's date of birth; the rest alternate Team RTM / no Team.
const log = Array.from({ length: 120 }, (_, i) => {
  const id = i + 1
  const base = { id, at: '2026-11-14T04:00:00Z', who: HELPER, op: 'insert', before: null, reason: null, team_id: id % 2 ? null : tid(1), team_ids: id % 2 ? [] : [tid(1)], match_id: null }
  if (id === 120) return { ...base, who: ORG, table_name: 'match', op: 'update', match_id: M, team_id: null, team_ids: [tid(1), tid(2)],
    before: { id: M, version: 1, kick_off: '2026-11-14T02:25:00Z', ord: 3 }, after: { id: M, version: 2, kick_off: '2026-11-14T03:45:00Z', ord: 3 } }
  if (id === 119) return { ...base, who: ORG, table_name: 'player', op: 'update', team_id: tid(1), team_ids: [tid(1)],
    before: { id: 'p', name: 'Ram Thapa', date_of_birth: 'date_of_birth', version: 1 }, after: { id: 'p', name: 'Ram Thapa', date_of_birth: 'date_of_birth:changed', version: 2 } }
  return { ...base, table_name: 'staff', after: { id: 's', name: `Helper ${id}`, team_id: base.team_id } }
})

const browser = await chromium.launch({ channel: 'chrome' })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

async function fresh(rows = log) {
  const mock = { calls: [], down: false }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const json = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) })
  await context.route(`${SUPA}/auth/v1/**`, (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors }) : json(route, session()))
  await context.route(`${SUPA}/rest/v1/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const u = new URL(req.url())
    const path = u.pathname
    if (path === '/rest/v1/tournament') {
      const season = { id: S, number: 7, status: 'started', setup_step: 7, version: 3, description: '', rules: '', photo_consent: 'Photos may be posted.',
        starts_on: '2033-11-07', ends_on: '2033-11-21', registration_deadline: '2033-11-03', structure: 'knockout', group_count: 2, teams_per_group: 4, qualifiers_per_group: 2 }
      return json(route, [{ id: T, name: 'Gulmi Cup', brand_primary: '#0a1a3f', brand_secondary: '#f58220', logo_path: null, version: 1, season: [season] }])
    }
    if (path === '/rest/v1/team') return json(route, [teamRow(1, 'RTM'), teamRow(2, 'RE8')])
    if (path === '/rest/v1/match') return json(route, [{ id: M, stage: 'group', round: 'Group A', label: null, ord: 3, home_team_id: tid(1), away_team_id: tid(2),
      home_src: null, away_src: null, kick_off: null, version: 2 }])
    if (path === '/rest/v1/season') return json(route, [{ fixtures_published_at: '2026-11-12T00:00:00Z' }])
    if (path === '/rest/v1/rpc/server_now') return json(route, new Date().toISOString())
    if (path === '/rest/v1/activity_view') {
      if (mock.down) return route.abort()
      const p = u.searchParams
      mock.calls.push(u.search)
      const lt = p.get('id')?.startsWith('lt.') ? Number(p.get('id').slice(3)) : Infinity
      const eq = (k) => p.get(k)?.startsWith('eq.') ? p.get(k).slice(3) : null
      const out = rows.filter((r) => r.id < lt && (!p.get('team_ids') || r.team_ids.includes(p.get('team_ids').slice(3).replace(/[{}]/g, ''))) && (!eq('match_id') || r.match_id === eq('match_id'))
        && (!eq('who') || r.who === eq('who'))).sort((a, b) => b.id - a.id).slice(0, Number(p.get('limit')))
      return json(route, out)
    }
    return json(route, [])
  })
  await context.addInitScript((v) => localStorage.setItem('sb-fake-auth-token', v), JSON.stringify(session()))
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${base}/t/${T}/settings/activity`)
  return { context, mock, page }
}

const rowsOf = (page) => page.locator('.activity-row')
const more = (page) => page.getByRole('button', { name: 'Show 50 more changes', exact: true })

try {
  {
    const { context, mock, page } = await fresh()
    await page.getByRole('heading', { name: 'Activity log', level: 1 }).waitFor()
    await rowsOf(page).first().waitFor()
    assert.equal(await rowsOf(page).count(), 50, 'first page')
    // The kick-off row: Match name, old struck through, who and when in BS and AD.
    const k = rowsOf(page).first()
    const kt = (await k.innerText()).replace(/\s+/g, ' ')
    assert.match(kt, /^RTM v RE8 Kick-off: 08:10.* → 09:30/, kt)
    assert.equal(await k.locator('s').count(), 1)
    assert.match(await k.locator('s').innerText(), /08:10/)
    assert.match(kt, /org@example\.com · Saturday · Kartik 28, 2083 BS \(14 Nov 2026\) · 09:45/, kt)
    assert.equal(await k.locator('a').getAttribute('href'), `/t/${T}/m/${M}`)
    // Place (ord) is not shown as a change when it didn't change; version never shows.
    assert.ok(!/Version|version/.test(kt))
    // A personal field says changed and shows no value.
    const d = rowsOf(page).nth(1)
    const dt = (await d.innerText()).replace(/\s+/g, ' ')
    assert.match(dt, /^Ram Thapa Date of birth changed/, dt)
    assert.ok(!/date_of_birth/.test(dt))
    assert.equal(await d.locator('a').getAttribute('href'), `/t/${T}/teams/${tid(1)}`)
    // A row with neither Team nor Match is not a link.
    const plain = rowsOf(page).nth(3)
    assert.equal(await plain.locator('a').count(), 0)
    assert.match((await plain.innerText()).replace(/\s+/g, ' '), /^Helper 117/)
    // Pages of 50: 50, 100, then the last 20.
    await more(page).click()
    await page.waitForFunction(() => document.querySelectorAll('.activity-row').length === 100)
    await more(page).click()
    await page.waitForFunction(() => document.querySelectorAll('.activity-row').length === 120)
    assert.equal(await more(page).count(), 0)
    assert.equal(new Set(await rowsOf(page).locator('h2').allInnerTexts()).size > 1, true)
    // Filters combine and a second tap clears.
    const team = page.getByRole('button', { name: 'Show only Team RTM', exact: true })
    const who = page.getByRole('button', { name: `Show only changes by ${ORG}`, exact: true })
    await team.click()
    await page.waitForFunction(() => document.querySelector('.activity-row') && document.querySelectorAll('.activity-row').length === 50)
    assert.equal(await team.getAttribute('aria-pressed'), 'true')
    await who.click()
    await page.waitForFunction(() => document.querySelectorAll('.activity-row').length === 2)
    assert.match(await rowsOf(page).nth(1).innerText(), /Ram Thapa/)
    assert.match(await rowsOf(page).first().innerText(), /RTM v RE8/, "the Team's Match change shows under its Team")
    assert.ok(mock.calls.some((c) => c.includes('team_ids=cs.') && c.includes('who=eq.')))
    await team.click()
    await page.waitForFunction(() => document.querySelectorAll('.activity-row').length === 2)
    await who.click()
    await page.waitForFunction(() => document.querySelectorAll('.activity-row').length === 50)
    // Match chip.
    await page.getByRole('button', { name: 'Show only Match RTM v RE8', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.activity-row').length === 1)
    // Tapping the row opens the Match page.
    await rowsOf(page).first().locator('a').click()
    await page.waitForURL(`**/t/${T}/m/${M}`)
    // Offline: the last newest page, with a note.
    await page.goto(`${base}/t/${T}/settings/activity`)
    await rowsOf(page).first().waitFor()
    mock.down = true
    await page.reload()
    await page.getByText('Showing the last Activity log read on this device', { exact: false }).waitFor()
    assert.equal(await rowsOf(page).count(), 50)
    await context.close()
  }
  // Empty.
  {
    const { context, page } = await fresh([])
    await page.getByText('Nothing changed yet.', { exact: true }).waitFor()
    assert.equal(await rowsOf(page).count(), 0)
    await context.close()
  }
  // Settings has the card.
  {
    const { context, page } = await fresh()
    await page.goto(`${base}/t/${T}/settings`)
    await page.getByRole('button', { name: 'Open the Activity log', exact: true }).click()
    await page.waitForURL(`**/t/${T}/settings/activity`)
    await context.close()
  }
  console.log('ok')
} finally {
  await browser.close()
  await server.close()
}
