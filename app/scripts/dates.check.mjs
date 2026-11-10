// Story 1.9 unit test of the BS/AD formatter (src/domain/format.ts): the first and last day of every month of
// 2082–2084 BS against the published month lengths, walked from 1 Baisakh 2082 = 14 Apr 2025, plus the dates in the UX
// examples. `npm run check:dates` (Node 22 strips the TypeScript types).
import assert from 'node:assert/strict'
import { BS_RANGE, formatDate, inZone, toBs } from '../src/domain/format.ts'

// Nepal's published calendar (Baisakh..Chaitra), written out here independently of the formatter's table.
const published = {
  2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2083: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2084: [31, 31, 32, 31, 31, 30, 30, 30, 29, 30, 30, 30],
}
const DAY = 86_400_000
const iso = (t) => new Date(t).toISOString().slice(0, 10)
let t = Date.UTC(2025, 3, 14)
for (const [y, months] of Object.entries(published)) {
  for (const [m, n] of months.entries()) {
    assert.deepEqual(toBs(iso(t)), { year: Number(y), month: m + 1, day: 1 }, `first day of ${y}-${m + 1} (${iso(t)})`)
    const last = t + (n - 1) * DAY
    assert.deepEqual(toBs(iso(last)), { year: Number(y), month: m + 1, day: n }, `last day of ${y}-${m + 1} (${iso(last)})`)
    t = last + DAY
  }
}
assert.equal(iso(t), '2028-04-13', '1 Baisakh 2085')
assert.deepEqual(toBs('2028-04-13'), { year: 2085, month: 1, day: 1 })

// The UX examples.
assert.equal(formatDate('2026-10-31'), 'Saturday · Kartik 14, 2083 BS (31 Oct 2026)')
assert.equal(formatDate('2026-11-07'), 'Saturday · Kartik 21, 2083 BS (7 Nov 2026)')
assert.equal(formatDate('2026-11-03'), 'Tuesday · Kartik 17, 2083 BS (3 Nov 2026)')
assert.equal(formatDate('2026-11-14'), 'Saturday · Kartik 28, 2083 BS (14 Nov 2026)')
assert.equal(formatDate('2026-09-15'), 'Tuesday · Bhadra 30, 2083 BS (15 Sep 2026)')

// Outside the table: AD only; malformed or impossible days: nothing.
assert.deepEqual(BS_RANGE, { min: '2023-04-14', max: '2034-04-13' })
assert.equal(toBs('2023-04-13'), null)
assert.equal(formatDate('2023-04-13'), 'Thursday · 13 Apr 2023')
assert.deepEqual(toBs(BS_RANGE.max), { year: 2090, month: 12, day: 30 })
assert.equal(toBs('2034-04-14'), null)
for (const bad of ['', '2026-02-30', '2026-13-01', '31/10/2026', '2026-1-5']) {
  assert.equal(toBs(bad), null, bad)
  assert.equal(formatDate(bad), '', bad)
}

// A timestamp's day and time in Kathmandu (UTC+5:45): 19:00 UTC is 00:45 the next day.
assert.deepEqual(inZone('2026-11-09T19:00:00Z'), { date: '2026-11-10', time: '00:45' })
assert.deepEqual(inZone('2026-11-10T04:15:00Z'), { date: '2026-11-10', time: '10:00' })
console.log('ok')
