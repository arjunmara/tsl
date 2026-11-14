// Release gate: feeds Season 1's results and the matchday/league.test.js cases into Postgres and fails on any table order that
// differs from matchday/league.js. Run by check.sh against its throwaway container:
//   PG_CONTAINER=<docker name> PARITY_TOURNAMENT=<uuid> PARITY_SEASON=<uuid> node standings.parity.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const { TEAMS, team, parseResults, table, parseGroups, groupTables } = createRequire(import.meta.url)(`${root}matchday/league.js`)
const { PG_CONTAINER: box, PARITY_TOURNAMENT: T, PARITY_SEASON: S } = process.env
assert.ok(box && T && S, 'PG_CONTAINER, PARITY_TOURNAMENT and PARITY_SEASON are needed')
const psql = (sql) => execFileSync('docker', ['exec', '-i', box, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-F', '|'],
  { input: sql, encoding: 'utf8' }).trim()

const id = (kind, n) => `7${kind}111111-0000-4000-8000-${String(n).padStart(12, '0')}`
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`

/** groups: arrays of team objects (one array = one group; `league` = a single table). results: parseResults output. */
function dbOrder(groups, results, league) {
  const sql = [`delete from app.tiebreak_shootout where season_id = '${S}'; delete from app.match where season_id = '${S}';
    delete from app.draw_slot where season_id = '${S}'; delete from app.team where season_id = '${S}';
    update app.season set structure = ${league ? "'league'" : "'groups_knockout', group_count = 16, teams_per_group = 16, qualifiers_per_group = 1"} where id = '${S}';`]
  const gi = new Map(), tid = new Map()
  groups.forEach((g, gn) => g.forEach((t, i) => {
    const n = tid.size + 1
    tid.set(t.name, id('a', n)); gi.set(t.name, gn)
    sql.push(`insert into app.team (id, tournament_id, season_id, name, code, status) values (${lit(id('a', n))}, '${T}', '${S}', ${lit(t.name)}, ${lit(t.code)}, 'approved');`)
    if (!league) sql.push(`insert into app.draw_slot (id, tournament_id, season_id, grp, pos, team_id) values (gen_random_uuid(), '${T}', '${S}', ${gn + 1}, ${i + 1}, ${lit(id('a', n))});`)
  }))
  results.forEach((r, i) => {
    const h = lit(tid.get(r.home.name)), a = lit(tid.get(r.away.name))
    if (r.pens) {  // a tie-break shootout: the side with the higher "score" won it
      const [w, l] = r.hg > r.ag ? [h, a] : [a, h]
      sql.push(`insert into app.tiebreak_shootout (id, tournament_id, season_id, winner_team_id, loser_team_id) values (gen_random_uuid(), '${T}', '${S}', ${w}, ${l});`)
    } else {
      const stage = r.round ? 'knockout' : league ? 'league' : 'group'
      sql.push(`insert into app.match (id, tournament_id, season_id, stage, round, ord, home_team_id, away_team_id, status, hg, ag)
        values (${lit(id('b', i + 1))}, '${T}', '${S}', '${stage}', 'r', ${i + 1}, ${h}, ${a}, 'finished', ${r.hg}, ${r.ag});`)
    }
  })
  sql.push(`select s.grp, t.name from app.standings_calc('${S}') s join app.team t on t.id = s.team_id order by s.grp, s.pos;`)
  const out = psql(sql.join('\n')).split('\n').filter((l) => /^\d+\|/.test(l))
  const byGroup = groups.map(() => [])
  for (const l of out) { const [g, name] = l.split('|'); byGroup[league ? 0 : +g - 1].push(name) }
  return byGroup
}

let n = 0
function same(name, groups, results, expected, league = false) {
  const got = dbOrder(groups, results, league)
  const want = expected.map((rows) => rows.map((r) => r.team.name))
  assert.deepEqual(got, want, `${name}: Postgres order differs from league.js`)
  n++
}

// Season 1: the real groups and results.
const read = (f) => readFileSync(`${root}seasons/season-1/${f}`, 'utf8')
{
  const groups = parseGroups(read('groups.txt')), results = parseResults(read('results.txt'))
  const all = groups.map((g) => g.teams)
  same('Season 1', all, results, groupTables(results, groups).map((g) => g.rows))
}

// The cases of matchday/league.test.js.
const r = parseResults(`
Da Boys 2-1 Real Tamghas
Bhadgaun Ward No. 3 2-2 14 Star Youth Club
KPT 0-3 dab
`)
same('table, 13 Teams', [TEAMS], r, [table(r)], true)
const groups = parseGroups('Group A\nDAB\nRTM\nKPT\nJBT\nRE8\nDFT\nNYC\nGroup B\nFSW\nCYC\nBW3\nKYC\n14SYC\nPTB')
same('two groups', groups.map((g) => g.teams), r, groupTables(r, groups).map((g) => g.rows))
const tb = parseResults('RTM 1-0 DAB\nDAB 5-0 KPT\nRTM 0-1 KPT\nJBT 1-1 RE8')
same('three-way tie', [TEAMS], tb, [table(tb)], true)
const three = [team('DAB'), team('RTM'), team('KPT')]
const h = parseResults('RTM 1-0 DAB|DAB 5-0 KPT|KPT 1-0 RTM|KPT 0-1 DAB')
same('head-to-head over goal difference', [three], h, [table(h, three)], true)
const two = [team('JBT'), team('RE8')]
for (const text of ['JBT 1-1 RE8', 'JBT 1-1 RE8|JBT 3-4 RE8 (pens)', 'JBT 1-1 RE8|JBT 4-3 RE8 (pens)']) {
  const x = parseResults(text)
  same(`shootout: ${text}`, [two], x, [table(x, two)], true)
}
const ko = parseResults('QF: DAB 2-1 FSW|final: dab 1-1 rtm|FINAL: DAB 4-3 RTM (pens)')
const withKo = [...r, ...ko.filter((x) => !x.pens)]
same('knockouts ignored', groups.map((g) => g.teams), withKo, groupTables([...r, ...ko], groups).map((g) => g.rows))

console.log(`parity ok (${n} cases)`)
