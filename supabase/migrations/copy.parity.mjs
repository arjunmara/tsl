// Story 6.5: the copied Season 1 table order (app.standings_calc) must equal matchday/league.js run on the legacy tables.
// Run by check.sh: PG_CONTAINER=<docker name> COPY_SEASON=<uuid> node copy.parity.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const { parseResults, parseGroups, groupTables } = createRequire(import.meta.url)(`${root}matchday/league.js`)
const { PG_CONTAINER: box, COPY_SEASON: S } = process.env
assert.ok(box && S, 'PG_CONTAINER and COPY_SEASON are needed')
const rows = (sql) => execFileSync('docker', ['exec', '-i', box, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-F', '|'],
  { input: sql, encoding: 'utf8' }).trim().split('\n').filter(Boolean).map((l) => l.split('|'))

const legacy = rows(`select s.grp, t.code from public.season_teams s join public.teams t on t.id = s.team where s.season = 1 and s.grp is not null order by s.grp, s.sort, s.team`)
let text = '', last = ''
for (const [g, code] of legacy) { if (g !== last) text += `${text ? '\n' : ''}Group ${g}`; last = g; text += `\n${code}` }
const groups = parseGroups(text)
const results = parseResults(rows(`select h.name, m.hg, m.ag, a.name, m.hp, m.ap from public.matches m join public.teams h on h.id = m.home join public.teams a on a.id = m.away
  where m.season = 1 and m.round = 'Group' order by m.n`)
  .flatMap(([h, hg, ag, a, hp, ap]) => [`${h} ${hg}-${ag} ${a}`, ...(hp ? [`${h} ${hp}-${ap} ${a} (pens)`] : [])]).join('\n'))
const want = groupTables(results, groups).map((g) => g.rows.map((r) => r.team.name))
const got = want.map(() => [])
for (const [g, name] of rows(`select s.grp, t.name from app.standings_calc('${S}') s join app.team t on t.id = s.team_id order by s.grp, s.pos`)) got[+g - 1].push(name)
assert.deepEqual(got, want, 'copied Season 1 table order differs from league.js on the legacy data')
console.log('copy parity ok')
