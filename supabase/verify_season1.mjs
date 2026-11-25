// Story 6.6: checks that the Season 1 copy made by 0045 matches the legacy tables, field by field. Read only: every query runs in one
// read-only transaction (begin transaction read only ... rollback). Prints `ok` and exits 0, or one line per difference and exits 1.
//
// Usage (needs Docker and Node; run from anywhere):
//   TSL_DB_URL='<Supabase -> Connect -> Session pooler string>' node supabase/verify_season1.mjs
// Optional env: TSL_DOCKER_ARGS (extra `docker run` args, e.g. "--network container:<box>"), TSL_PSQL_IMAGE (default postgres:17).
// Exit codes: 0 everything matches; 1 differences, or "Season 1 copy not found"; 2 no connection, TSL_DB_URL missing or Docker failed.
// The connection string is passed to the container through the environment and is never printed.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { TSL_DB_URL: url, TSL_DOCKER_ARGS: extra = '', TSL_PSQL_IMAGE: image = 'postgres:17' } = process.env
const bail = (msg, code) => { console.error(msg); process.exit(code) }
if (!url) bail('TSL_DB_URL is not set: copy the Session pooler string from Supabase -> Connect.', 2)

// The same ids as 0045. One document with both sides, built in one read-only transaction.
const SQL = `begin transaction read only;
with k as (select extensions.uuid_generate_v5('7a5f1c3e-91d4-4b6a-8e2f-5c0d7b1a9e34'::uuid, 'tsl-s1:season:1') sid)
select json_build_object(
  'found', exists (select 1 from app.season s, k where s.id = k.sid),
  'lTeams', (select coalesce(json_agg(json_build_object('code', t.code, 'name', t.name, 'grp', s.grp) order by s.grp nulls last, s.sort, s.team), '[]')
    from public.season_teams s join public.teams t on t.id = s.team where s.season = 1),
  'aTeams', (select coalesce(json_agg(json_build_object('code', t.code, 'name', t.name)), '[]') from app.team t, k where t.season_id = k.sid),
  'lMatches', (select coalesce(json_agg(json_build_object('id', extensions.uuid_generate_v5('7a5f1c3e-91d4-4b6a-8e2f-5c0d7b1a9e34'::uuid, 'tsl-s1:match:' || m.id), 'n', m.n, 'home', h.code, 'away', a.code, 'status', m.status, 'hg', m.hg, 'ag', m.ag, 'hp', m.hp, 'ap', m.ap,
      'round', case when m.round = 'Group' then 'Group ' || (select s.grp from public.season_teams s where s.season = m.season and s.team = m.home) else m.round end) order by m.n), '[]')
    from public.matches m join public.teams h on h.id = m.home join public.teams a on a.id = m.away where m.season = 1),
  'aMatches', (select coalesce(json_agg(json_build_object('id', m.id, 'n', m.ord, 'home', h.code, 'away', a.code, 'status', m.status, 'hg', m.hg, 'ag', m.ag, 'hp', m.home_pens, 'ap', m.away_pens,
      'round', m.round) order by m.ord), '[]')
    from app.match m, k, app.team h, app.team a where m.season_id = k.sid and h.id = m.home_team_id and a.id = m.away_team_id),
  'lGoals', (select coalesce(json_agg(json_build_object('n', m.n, 'team', t.code, 'who', btrim(p.name), 'og', g.og, 'min', coalesce(g.minute, 0))), '[]')
    from public.goals g join public.matches m on m.id = g.match and m.season = 1 join public.teams t on t.id = g.team left join public.players p on p.id = g.player),
  'aGoals', (select coalesce(json_agg(json_build_object('n', m.ord, 'team', t.code, 'who', p.name, 'og', e.own_goal, 'min', e.minute)), '[]')
    from app.match_event e join app.match m on m.id = e.match_id join k on m.season_id = k.sid join app.team t on t.id = e.team_id left join app.player p on p.id = e.player_id
    where e.kind = 'goal' and e.deleted_at is null),
  'lCards', (select coalesce(json_agg(json_build_object('n', m.n, 'team', t.code, 'who', btrim(p.name), 'min', coalesce(e.minute, 0),
      'kind', case e.kind when 'Yellow Card' then 'yellow' when 'Penalty Missed' then 'missed_penalty' else 'red' end)), '[]')
    from public.events e join public.matches m on m.id = e.match and m.season = 1 join public.teams t on t.id = e.team left join public.players p on p.id = e.player
    where e.kind in ('Yellow Card', 'Red Card', 'Second Yellow', 'Penalty Missed')),
  'aCards', (select coalesce(json_agg(json_build_object('n', m.ord, 'team', t.code, 'who', p.name, 'min', e.minute,
      'kind', case e.kind when 'missed_penalty' then 'missed_penalty' else e.card end)), '[]')
    from app.match_event e join app.match m on m.id = e.match_id join k on m.season_id = k.sid join app.team t on t.id = e.team_id left join app.player p on p.id = e.player_id
    where e.kind in ('card', 'missed_penalty') and e.deleted_at is null),
  'awards', (select count(*) from app.season_awards a, k where a.season_id = k.sid),
  'table', (select coalesce(json_agg(json_build_object('grp', s.grp, 'pos', s.pos, 'team', t.code, 'P', s.p, 'W', s.w, 'D', s.d, 'L', s.l, 'GF', s.gf, 'GA', s.ga, 'Pts', s.pts)), '[]')
    from k, app.standings_calc(k.sid) s join app.team t on t.id = s.team_id),
  'otherEvents', (select count(*) from app.match_event e, k where e.season_id = k.sid and e.kind not in ('goal', 'card', 'missed_penalty'))
);
rollback;`

const docker = ['run', '--rm', '-i', ...extra.split(/\s+/).filter(Boolean), '-e', 'TSL_DB_URL',
  image, 'sh', '-c', 'exec psql "$TSL_DB_URL" -v ON_ERROR_STOP=1 -qAt']
const run = spawnSync('docker', docker, { input: SQL, encoding: 'utf8', maxBuffer: 1 << 26, env: process.env })
const scrub = (s) => String(s ?? '').split(url).join('<TSL_DB_URL>').trim()
if (run.error) bail(`Could not run Docker: ${scrub(run.error.message)}`, 2)
if (run.status !== 0) bail(`Could not read the database: ${scrub(run.stderr).slice(0, 1500)}`, 2)
let d
try { d = JSON.parse(run.stdout.trim()) } catch { bail(`Unexpected answer from the database: ${scrub(run.stdout).slice(0, 300)}`, 2) }
if (!d.found) bail('Season 1 copy not found: run 0045_copy_tsl_season_1.sql first.', 1)

process.on('uncaughtException', (e) => bail(`Could not compare: ${scrub(e.message)}`, 2))
const diffs = []
const hdr = (n, h, a) => `Match ${n} (${h} v ${a})`
const add = (head, field, l, a) => { if (String(l) !== String(a)) diffs.push(`${head}: ${field}: legacy ${l}, app ${a}`) }
const by = (rows, key) => { const m = new Map(); for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]); return m }

// Counts and Teams.
add('Counts', 'Teams', d.lTeams.length, d.aTeams.length)
add('Counts', 'Matches', d.lMatches.length, d.aMatches.length)
add('Counts', 'goals', d.lGoals.length, d.aGoals.length)
add('Counts', 'cards', d.lCards.length, d.aCards.length)
add('Season', 'awards', 0, d.awards)
add('Counts', 'other events', 0, d.otherEvents)
const aTeam = new Map(d.aTeams.map((t) => [t.code, t]))
for (const t of d.lTeams) {
  if (!aTeam.has(t.code)) diffs.push(`Team ${t.code}: team: legacy present, app missing`)
  else add(`Team ${t.code}`, 'name', t.name, aTeam.get(t.code).name)
}
for (const t of d.aTeams) if (!d.lTeams.some((x) => x.code === t.code)) diffs.push(`Team ${t.code}: team: legacy missing, app present`)

// Matches, goals and cards, by match number.
const lM = new Map(d.lMatches.map((m) => [m.n, m])), aM = new Map(d.aMatches.map((m) => [m.n, m]))
const lG = by(d.lGoals, (g) => g.n), aG = by(d.aGoals, (g) => g.n), lC = by(d.lCards, (c) => c.n), aC = by(d.aCards, (c) => c.n)
const unk = (g) => !g.who && !g.og
const gKey = (g) => `${g.team} ${g.who ?? 'unknown'}${g.og ? ' (own goal)' : ''}`
const cKey = (c) => `${c.team} ${c.who} ${c.kind}`
const score = (m) => `${m.hg}-${m.ag}`, pens = (m) => (m.hp == null ? 'none' : `${m.hp}-${m.ap}`)
// Same key on both sides: equal minutes cancel, leftovers pair up as a minute change, then one-sided extras.
function listDiff(head, what, l, a, key) {
  const lk = by(l, key), ak = by(a, key)
  for (const k of new Set([...lk.keys(), ...ak.keys()])) {
    const lm = (lk.get(k) ?? []).map((x) => x.min).sort((x, y) => x - y), am = (ak.get(k) ?? []).map((x) => x.min).sort((x, y) => x - y)
    for (const m of [...lm]) { const i = am.indexOf(m); if (i >= 0) { am.splice(i, 1); lm.splice(lm.indexOf(m), 1) } }
    while (lm.length && am.length) diffs.push(`${head}: ${what} minute: legacy ${lm.shift()}, app ${am.shift()}`)
    for (const m of lm) diffs.push(`${head}: ${what}: legacy ${k} ${m}', app none`)
    for (const m of am) diffs.push(`${head}: ${what}: legacy none, app ${k} ${m}'`)
  }
}
const noScorer = []
for (const n of [...new Set([...lM.keys(), ...aM.keys()])].sort((x, y) => x - y)) {
  const l = lM.get(n), a = aM.get(n)
  if (!l || !a) { diffs.push(`Match ${n} (${(l ?? a).home} v ${(l ?? a).away}): match: legacy ${l ? 'present' : 'missing'}, app ${a ? 'present' : 'missing'}`); continue }
  const h = hdr(n, l.home, l.away), start = diffs.length
  add(h, 'id', l.id, a.id); add(h, 'home', l.home, a.home); add(h, 'away', l.away, a.away); add(h, 'round', l.round, a.round)
  add(h, 'status', l.status === 'done' ? 'finished' : l.status, a.status); add(h, 'score', score(l), score(a)); add(h, 'pens', pens(l), pens(a))
  const lg = lG.get(n) ?? [], ag = aG.get(n) ?? []
  // Unknown scorers have no name: listDiff compares them by Team and minute under the key "<team> unknown".
  listDiff(h, 'goal', lg, ag, gKey)
  if (diffs.length === start && score(l) === score(a) && lg.some(unk)) noScorer.push(`Match ${n} (${l.home} v ${l.away}) ${lg.filter(unk).length}`)
  listDiff(h, 'card', lC.get(n) ?? [], aC.get(n) ?? [], cKey)
}

// Group tables: league.js on the legacy rows against app.standings_calc, every row and column.
const { TEAMS, parseResults, parseGroups, groupTables } = createRequire(import.meta.url)(`${root}matchday/league.js`)
TEAMS.splice(0, TEAMS.length, ...d.lTeams.map(({ name, code }) => ({ name, code })))
let text = '', last = null
for (const t of d.lTeams.filter((x) => x.grp)) { if (t.grp !== last) text += `${text ? '\n' : ''}Group ${t.grp}`; last = t.grp; text += `\n${t.code}` }
const results = d.lMatches.filter((m) => m.round.startsWith('Group') && m.status === 'done')
  .flatMap((m) => [`${m.home} ${m.hg}-${m.ag} ${m.away}`, ...(m.hp == null ? [] : [`${m.home} ${m.hp}-${m.ap} ${m.away} (pens)`])]).join('\n')
const want = groupTables(parseResults(results), parseGroups(text))
want.forEach((g, gi) => {
  const grp = g.name, appRows = new Map(d.table.filter((r) => r.grp === gi + 1).map((r) => [r.team, r]))
  g.rows.forEach((r, i) => {
    const h = `${grp}, ${r.team.code}`, a = appRows.get(r.team.code)
    if (!a) return diffs.push(`${h}: table row: legacy position ${i + 1}, app missing`)
    add(h, 'position', i + 1, a.pos)
    for (const [f, v] of [['P', r.p], ['W', r.w], ['D', r.d], ['L', r.l], ['GF', r.gf], ['GA', r.ga], ['Pts', r.pts]]) add(h, f, v, a[f])
  })
  for (const code of appRows.keys()) if (!g.rows.some((r) => r.team.code === code)) diffs.push(`${grp}, ${code}: table row: legacy missing, app present`)
})
for (const r of d.table) if (!want[r.grp - 1]) diffs.push(`Group ${String.fromCharCode(64 + r.grp)}, ${r.team}: table row: legacy missing, app present`)

if (noScorer.length) console.log(`note: goals with no recorded scorer are compared by Team and minute only: ${noScorer.join('; ')}`)
console.log('note: kick-off is not compared (legacy has a time and no date, the copy has none)')
if (diffs.length) { console.log(diffs.join('\n')); process.exit(1) }
console.log('ok')
