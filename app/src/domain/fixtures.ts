import type { Slot } from './draw'
import type { Structure } from './tournaments'

/** One suggested Fixture, in the keys app.suggest_fixtures reads. A side is a Team, or while unknown a source label. */
export type Fixture = {
  id: string; stage: 'group' | 'knockout' | 'league'; round: string; label: string | null; ord: number
  home_team: string | null; away_team: string | null; home_src: string | null; away_src: string | null
}
type Side = { team: string | null; src: string | null }
type Pair = [Side, Side]

const team = (id: string): Side => ({ team: id, src: null })

/** Matches (pairs of Teams) in the order with the fewest consecutive Matches sharing a Team: exact up to 16, greedy above. */
function orderPairs(pairs: [string, string][]): [string, string][] {
  const n = pairs.length
  const clash = (a: number, b: number) => pairs[a]!.some((t) => pairs[b]!.includes(t))
  if (n <= 2) return pairs
  if (n > 16) {
    // ponytail: greedy above 16 Matches; not always the minimum. Upgrade to a local search if it shows.
    const last = new Map<string, number>()
    const left = pairs.map((_, i) => i)
    const out: number[] = []
    while (left.length) {
      const prev = out.at(-1)
      const score = (i: number) => (prev !== undefined && clash(prev, i) ? 1e6 : 0) + pairs[i]!.reduce((s, t) => s - (out.length - (last.get(t) ?? -9)), 0)
      const i = left.reduce((best, c) => (score(c) < score(best) ? c : best))
      left.splice(left.indexOf(i), 1)
      pairs[i]!.forEach((t) => last.set(t, out.length))
      out.push(i)
    }
    return out.map((i) => pairs[i]!)
  }
  // Fewest back-to-backs over every order: best[mask][last] = cheapest way to play the Matches in mask ending on last.
  const full = (1 << n) - 1
  const best = Array.from({ length: full + 1 }, () => new Int8Array(n).fill(127))
  const from = Array.from({ length: full + 1 }, () => new Int8Array(n).fill(-1))
  for (let i = 0; i < n; i++) best[1 << i]![i] = 0
  for (let m = 1; m <= full; m++) {
    for (let l = 0; l < n; l++) {
      const c = best[m]![l]!
      if (c === 127) continue
      for (let k = 0; k < n; k++) {
        if (m & (1 << k)) continue
        const v = c + (clash(l, k) ? 1 : 0)
        if (v < best[m | (1 << k)]![k]!) {
          best[m | (1 << k)]![k] = v
          from[m | (1 << k)]![k] = l
        }
      }
    }
  }
  let l = 0
  for (let i = 1; i < n; i++) if (best[full]![i]! < best[full]![l]!) l = i
  const out: number[] = []
  for (let m = full; l >= 0; ) {
    out.push(l)
    const p = from[m]![l]!
    m &= ~(1 << l)
    l = p
  }
  return out.reverse().map((i) => pairs[i]!)
}

const roundRobin = (ids: string[]): [string, string][] => ids.flatMap((a, i) => ids.slice(i + 1).map((b): [string, string] => [a, b]))

/** Seeds 1..p in standard bracket order: 1 v p, then the rest so the top seeds meet last (p = 4: 1, 4, 2, 3). */
function bracketOrder(p: number): number[] {
  let o = [1, 2]
  for (let k = 2; k < p; k *= 2) o = o.flatMap((s) => [s, 2 * k + 1 - s])
  return o
}

const roundName = (left: number) => (left === 2 ? 'Final' : left === 4 ? 'SF' : left === 8 ? 'QF' : left === 16 ? 'R16' : `Round of ${left}`)

/**
 * The knockout path. entries are round 1 in bracket order: a Match (Pair) or a bye (one Side that skips to round 2). The
 * rounds are named by Teams left in the full bracket; later rounds take "Winner SF1" sides.
 */
function knockout(entries: (Pair | Side)[], p: number): Omit<Fixture, 'id' | 'ord'>[] {
  const out: Omit<Fixture, 'id' | 'ord'>[] = []
  let feeds: Side[]
  for (let left = p, es = entries; left >= 2; left /= 2) {
    const name = roundName(left)
    feeds = []
    let n = 0
    const next: Pair[] = []
    for (const e of es) {
      if (Array.isArray(e)) {
        n++
        const label = left === 2 ? 'Final' : left <= 8 ? `${name}${n}` : `R${left}-${n}`
        out.push({ stage: 'knockout', round: name, label, home_team: e[0].team, away_team: e[1].team, home_src: e[0].src, away_src: e[1].src })
        feeds.push({ team: null, src: `Winner ${label}` })
      } else feeds.push(e)
    }
    for (let i = 0; i < feeds.length; i += 2) next.push([feeds[i]!, feeds[i + 1]!])
    es = next
  }
  return out
}

/** Round 1 entries for p seeds placed as a bracket; seeds above `count` are missing, so their opponents get byes. */
function seeded(sides: Side[], p: number): (Pair | Side)[] {
  const o = bracketOrder(p)
  const es: (Pair | Side)[] = []
  for (let i = 0; i < p; i += 2) {
    const [a, b] = [o[i]!, o[i + 1]!]
    es.push(b > sides.length ? sides[a - 1]! : [sides[a - 1]!, sides[b - 1]!])
  }
  // No round 1 Match between two Teams of one group where avoidable: swap away sides between Matches.
  const grp = (x: Side) => x.src?.[0]
  const same = (e: Pair | Side | undefined): e is Pair => Array.isArray(e) && grp(e[0]) !== undefined && grp(e[0]) === grp(e[1])
  const pairs = es.filter(Array.isArray) as Pair[]
  for (const x of pairs) {
    if (!same(x)) continue
    const y = pairs.find((c) => c !== x && grp(c[0]) !== grp(x[1]) && grp(c[1]) !== grp(x[0]) && grp(c[0]) !== grp(x[0]) && grp(c[1]) !== grp(x[1]))
    if (y) [x[1], y[1]] = [y[1], x[1]]
  }
  return es
}

const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(n, 2)))

/**
 * The suggested Fixtures for a Structure, the approved Teams and the Draw: group Matches (no Team twice in a row where it can be
 * avoided) then the knockout path; a knockout-only bracket from the Draw slots (byes go to slots 1..b); or a League. Pure.
 */
export function suggestFixtures(structure: Structure, teams: { id: string }[], slots: Slot[]): Fixture[] {
  const rows: Omit<Fixture, 'id' | 'ord'>[] = []
  const row = (stage: Fixture['stage'], round: string, [h, a]: [string, string]) =>
    ({ stage, round, label: null, home_team: h, away_team: a, home_src: null, away_src: null })
  const k = structure.structure
  if (k === 'league') {
    orderPairs(roundRobin(teams.map((t) => t.id))).forEach((p) => rows.push(row('league', 'League', p)))
  } else if (k === 'groups_knockout' && structure.group_count && structure.qualifiers_per_group != null) {
    const groups = Array.from({ length: structure.group_count }, (_, g) => slots.filter((s) => s.grp === g + 1).sort((a, b) => a.pos - b.pos).map((s) => s.teamId))
    const named = groups.flatMap((ids, g) => roundRobin(ids).map((p): [string, string, string] => [...p, `Group ${String.fromCharCode(65 + g)}`]))
    const roundOf = new Map(named.map(([a, b, r]) => [`${a}|${b}`, r]))
    orderPairs(named.map(([a, b]) => [a, b])).forEach((p) => rows.push(row('group', roundOf.get(p.join('|'))!, p)))
    const sides: Side[] = []
    for (let q = 1; q <= structure.qualifiers_per_group; q++) groups.forEach((_, g) => sides.push({ team: null, src: `${String.fromCharCode(65 + g)}${q}` }))
    if (sides.length >= 2) rows.push(...knockout(seeded(sides, pow2(sides.length)), pow2(sides.length)))
  } else if (k === 'knockout') {
    const ids = slots.filter((s) => s.grp === 0).sort((a, b) => a.pos - b.pos).map((s) => s.teamId)
    if (ids.length >= 2) {
      const p = pow2(ids.length)
      const b = p - ids.length
      const byes: Side[] = ids.slice(0, b).map((id) => ({ team: id, src: 'Bye' }))
      const ms: Pair[] = []
      for (let i = b; i < ids.length; i += 2) ms.push([team(ids[i]!), team(ids[i + 1]!)])
      // Byes alternate with real Matches so two bye Teams don't meet in round 2.
      const es: (Pair | Side)[] = []
      while (byes.length || ms.length) es.push(byes.length && (es.length % 2 === 0 || !ms.length) ? byes.shift()! : ms.length ? ms.shift()! : byes.shift()!)
      rows.push(...knockout(es, p))
    }
  }
  return rows.map((r, i) => ({ id: crypto.randomUUID(), ord: i + 1, ...r }))
}
