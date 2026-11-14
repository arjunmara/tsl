// Story 3.2 fixtures check: ordering is the exhaustive minimum of back-to-back Matches, the group + knockout shape, knockout
// 8 and 6 with byes, and league pairs. Pure, no browser. `npm run check:fixtures`.
import assert from 'node:assert/strict'
import { suggestFixtures } from '../src/domain/fixtures.ts'

const T = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}` }))
const slots = (sizes) => sizes.flatMap((n, g) => Array.from({ length: n }, (_, i) => ({ id: `s${g}${i}`, grp: g + 1, pos: i + 1, teamId: `g${g + 1}t${i + 1}` })))
const gk = (g, q) => ({ structure: 'groups_knockout', group_count: g, qualifiers_per_group: q })
const b2b = (fx) => fx.filter((f, i) => i && [f.home_team, f.away_team].some((t) => [fx[i - 1].home_team, fx[i - 1].away_team].includes(t))).length

// Independent exhaustive minimum: memoised search over every order.
function minimum(pairs) {
  const memo = new Map()
  const go = (mask, last) => {
    if (mask === (1 << pairs.length) - 1) return 0
    const key = mask * 32 + last
    if (memo.has(key)) return memo.get(key)
    let best = 1e9
    for (let k = 0; k < pairs.length; k++) {
      if (mask & (1 << k)) continue
      best = Math.min(best, (last >= 0 && pairs[last].some((t) => pairs[k].includes(t)) ? 1 : 0) + go(mask | (1 << k), k))
    }
    memo.set(key, best)
    return best
  }
  return go(0, -1)
}
const allPairs = (ids) => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b]))
for (const size of [3, 4, 5]) {
  const fx = suggestFixtures({ structure: 'groups_knockout', group_count: 1, qualifiers_per_group: 0 }, [], slots([size]))
  assert.equal(fx.length, size * (size - 1) / 2)
  assert.equal(b2b(fx), minimum(allPairs(slots([size]).map((s) => s.teamId))), `group of ${size}`)
}
assert.equal(b2b(suggestFixtures({ structure: 'groups_knockout', group_count: 1, qualifiers_per_group: 0 }, [], slots([3]))), 2)
const lg = suggestFixtures({ structure: 'league' }, T(6), [])
assert.equal(lg.length, 15)
assert.ok(lg.every((f) => f.stage === 'league' && !f.home_src))
assert.equal(new Set(lg.map((f) => [f.home_team, f.away_team].sort().join())).size, 15)
assert.equal(b2b(lg), minimum(allPairs(T(6).map((t) => t.id))))
assert.deepEqual(lg.map((f) => f.ord), lg.map((_, i) => i + 1))

// 2 groups of 4, 2 qualify: 12 group Matches with no Team twice in a row, then SF1, SF2, Final.
const g2 = suggestFixtures(gk(2, 2), [], slots([4, 4]))
const view = (f) => [f.label ?? f.round, f.home_team ?? f.home_src, f.away_team ?? f.away_src]
assert.equal(g2.length, 15)
assert.equal(b2b(g2.slice(0, 12)), 0)
assert.equal(g2.slice(0, 12).filter((f) => f.round === 'Group A').length, 6)
assert.deepEqual(g2.slice(12).map(view), [['SF1', 'A1', 'B2'], ['SF2', 'B1', 'A2'], ['Final', 'Winner SF1', 'Winner SF2']])
assert.deepEqual(g2.slice(12).map((f) => f.round), ['SF', 'SF', 'Final'])
// 4 groups, 2 qualify: 8 seeds, QF1 A1 v D2.
const g4 = suggestFixtures(gk(4, 2), [], slots([3, 3, 3, 3]))
assert.deepEqual(g4.filter((f) => f.stage === 'knockout').map(view).slice(0, 4), [['QF1', 'A1', 'D2'], ['QF2', 'D1', 'A2'], ['QF3', 'B1', 'C2'], ['QF4', 'C1', 'B2']])
// 3 groups, 2 qualify: 6 seeds in a bracket of 8: seeds 1 and 2 (A1, B1) have byes.
const g3 = suggestFixtures(gk(3, 2), [], slots([3, 3, 3])).filter((f) => f.stage === 'knockout')
assert.deepEqual(g3.map((f) => f.label), ['QF1', 'QF2', 'SF1', 'SF2', 'Final'])
assert.deepEqual(g3.map(view), [['QF1', 'A2', 'C2'], ['QF2', 'C1', 'B2'], ['SF1', 'A1', 'Winner QF1'], ['SF2', 'B1', 'Winner QF2'], ['Final', 'Winner SF1', 'Winner SF2']])

const ko = (n) => suggestFixtures({ structure: 'knockout' }, [], Array.from({ length: n }, (_, i) => ({ id: `s${i}`, grp: 0, pos: i + 1, teamId: `t${i + 1}` })))
assert.deepEqual(ko(8).map(view), [['QF1', 't1', 't2'], ['QF2', 't3', 't4'], ['QF3', 't5', 't6'], ['QF4', 't7', 't8'],
  ['SF1', 'Winner QF1', 'Winner QF2'], ['SF2', 'Winner QF3', 'Winner QF4'], ['Final', 'Winner SF1', 'Winner SF2']])
const k6 = ko(6)
assert.deepEqual(k6.map(view), [['QF1', 't3', 't4'], ['QF2', 't5', 't6'], ['SF1', 't1', 'Winner QF1'], ['SF2', 't2', 'Winner QF2'], ['Final', 'Winner SF1', 'Winner SF2']])
assert.deepEqual([k6[2].home_src, k6[3].home_src], ['Bye', 'Bye'])
assert.deepEqual(ko(3).map(view), [['SF1', 't2', 't3'], ['Final', 't1', 'Winner SF1']])
assert.deepEqual(ko(2).map(view), [['Final', 't1', 't2']])
assert.equal(ko(1).length, 0)
assert.equal(new Set(k6.map((f) => f.id)).size, 5)
console.log('ok')
