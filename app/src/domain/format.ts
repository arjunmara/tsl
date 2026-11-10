// The one place dates are turned into words. Dates are stored as AD (`date` / `timestamptz`) and shown in BS and
// AD together: "Saturday · Kartik 14, 2083 BS (31 Oct 2026)". BS comes only from the table below, never an offset.
//
// Money (recorded here so every screen follows one rule): store and pass integer paisa (minor units) plus an ISO 4217
// currency code, never a float, e.g. { paisa: 150000, currency: 'NPR' } for Rs 1,500.
export type Money = { paisa: number; currency: string }

// Days in each BS month, Baisakh to Chaitra, from 2040 BS (dates of birth need the older years). The rows agree in nepali-date-converter 3.4.2,
// @sbmdkl/nepali-date-converter 2.0.5 and bikram-sambat 1.8.1 (checked 2026-11-10). Add a row per year as the
// calendar committee publishes it; dates past the last row show in AD only. 2040–2079 agree in the same three
// packages (checked 2026-11-10).
const FIRST_YEAR = 2040
const LENGTHS = [
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2040
  [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30], // 2041
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], // 2042
  [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 30, 30], // 2043
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2044
  [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30], // 2045
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], // 2046
  [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], // 2047
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2048
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30], // 2049
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], // 2050
  [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], // 2051
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2052
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30], // 2053
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], // 2054
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2055
  [31, 31, 32, 31, 32, 30, 30, 29, 30, 29, 30, 30], // 2056
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], // 2057
  [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], // 2058
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2059
  [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30], // 2060
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], // 2061
  [30, 32, 31, 32, 31, 31, 29, 30, 29, 30, 29, 31], // 2062
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2063
  [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30], // 2064
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], // 2065
  [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 29, 31], // 2066
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2067
  [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30], // 2068
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], // 2069
  [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 30, 30], // 2070
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2071
  [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30], // 2072
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], // 2073
  [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], // 2074
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2075
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30], // 2076
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], // 2077
  [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], // 2078
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2079
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30], // 2080
  [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], // 2081
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2082
  [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], // 2083
  [31, 31, 32, 31, 31, 30, 30, 30, 29, 30, 30, 30], // 2084
  [31, 32, 31, 32, 30, 31, 30, 30, 29, 30, 30, 30], // 2085
  [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30], // 2086
  [31, 31, 32, 31, 31, 31, 30, 30, 29, 30, 30, 30], // 2087
  [30, 31, 32, 32, 30, 31, 30, 30, 29, 30, 30, 30], // 2088
  [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30], // 2089
  [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30], // 2090
]
const DAY = 86_400_000
/** 1 Baisakh 2040 BS. */
const FIRST_DAY = Date.UTC(1983, 3, 14)
const TOTAL = LENGTHS.flat().reduce((a, b) => a + b, 0)
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)

export const BS_MONTHS = ['Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Aswin', 'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra']
const AD_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Limits for Season date inputs, as YYYY-MM-DD: 1 Baisakh 2080 BS to the table's last day. */
export const BS_RANGE = { min: iso(Date.UTC(2023, 3, 14)), max: iso(FIRST_DAY + (TOTAL - 1) * DAY) }

/** Midnight UTC of a real YYYY-MM-DD day, else null. */
function utc(ad: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ad)
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return iso(t) === ad ? t : null
}

/** The BS day for an AD day (YYYY-MM-DD); null outside the table or for a malformed day. Month is 1–12. */
export function toBs(ad: string): { year: number; month: number; day: number } | null {
  const t = utc(ad)
  if (t === null) return null
  let days = Math.round((t - FIRST_DAY) / DAY)
  if (days < 0) return null
  for (const [y, months] of LENGTHS.entries()) {
    for (const [m, n] of months.entries()) {
      if (days < n) return { year: FIRST_YEAR + y, month: m + 1, day: days + 1 }
      days -= n
    }
  }
  return null
}

/** "Saturday · Kartik 14, 2083 BS (31 Oct 2026)"; outside the table "Saturday · 31 Oct 2026". '' for a malformed day. */
export function formatDate(ad: string): string {
  const t = utc(ad)
  if (t === null) return ''
  const d = new Date(t)
  const day = `${d.getUTCDate()} ${AD_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  const bs = toBs(ad)
  const week = WEEKDAYS[d.getUTCDay()]
  return bs ? `${week} · ${BS_MONTHS[bs.month - 1]} ${bs.day}, ${bs.year} BS (${day})` : `${week} · ${day}`
}

/** The calendar day (YYYY-MM-DD) and 24-hour time (HH:MM) of a timestamp in a time zone (default Asia/Kathmandu). */
export function inZone(ts: string | number | Date, timeZone = 'Asia/Kathmandu'): { date: string; time: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}

/** "Kartik 14, 2083 BS (31 Oct 2026)": formatDate without the weekday, for sentences such as the Deadline banner. */
export const formatDay = (ad: string) => formatDate(ad).replace(/^\w+ · /, '')
