import { supabase } from './supabase'

/** One Team's line in a group table, as the database works it out (app.standings). grp 0 is a League's one table. */
export type StandingRow = {
  grp: number; pos: number; teamId: string; p: number; w: number; d: number; l: number; gf: number; ga: number; gd: number; pts: number
  groupDone: boolean; provisional: boolean; shootoutWith: string | null
}
/** A Match's two sides as the database resolves them (app.match_sides): a Team id, or null with the label still to show. */
export type Sides = { matchId: string; homeTeamId: string | null; awayTeamId: string | null }
type Kept = { rows: StandingRow[]; sides: Sides[] }

const key = (seasonId: string) => `tsl-standings:${seasonId}`

// Rows come back as plain objects; anything else (an error body, a mock) reads as no rows.
const list = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x : [])

/** The Season's group tables and resolved Match sides. Offline, the last read kept on this device; else { code }. Standings are never worked out here. */
export async function seasonStandings(seasonId: string): Promise<Kept | { code: 'offline' | 'unknown' }> {
  const kept = () => {
    try {
      const last = JSON.parse(localStorage.getItem(key(seasonId)) ?? 'null') as Kept | null
      if (last && Array.isArray(last.rows) && Array.isArray(last.sides)) return last
    } catch {
      // Blocked or bad storage: nothing kept.
    }
    return { code: 'offline' as const }
  }
  if (!navigator.onLine) return kept()
  try {
    const app = supabase.schema('app')
    const [st, ms] = await Promise.all([app.rpc('standings', { p_season_id: seasonId }), app.rpc('match_sides', { p_season_id: seasonId })])
    const bad = st.error ?? ms.error
    if (bad) return (st.error ? st.status : ms.status) === 0 || !navigator.onLine ? kept() : { code: 'unknown' }
    const rows = list(st.data).map((r): StandingRow => ({ grp: r.grp as number, pos: r.pos as number, teamId: r.team_id as string, p: r.p as number,
      w: r.w as number, d: r.d as number, l: r.l as number, gf: r.gf as number, ga: r.ga as number, gd: r.gd as number, pts: r.pts as number,
      groupDone: !!r.group_done, provisional: !!r.provisional, shootoutWith: (r.shootout_with as string | null) ?? null }))
      .filter((r) => typeof r.teamId === 'string')
    const sides = list(ms.data).map((r): Sides => ({ matchId: r.match_id as string, homeTeamId: (r.home_team_id as string | null) ?? null,
      awayTeamId: (r.away_team_id as string | null) ?? null })).filter((s) => typeof s.matchId === 'string')
    try {
      localStorage.setItem(key(seasonId), JSON.stringify({ rows, sides }))
    } catch {
      // Storage full or blocked: only the offline fallback is lost.
    }
    return { rows, sides }
  } catch {
    return kept()
  }
}

/** The Teams a shootout is needed between: one pair per tie (a pair is listed once). */
export function shootoutsNeeded(rows: StandingRow[]): { grp: number; a: string; b: string }[] {
  const seen = new Set<string>()
  const out: { grp: number; a: string; b: string }[] = []
  for (const r of rows) {
    if (!r.provisional || !r.shootoutWith) continue
    const k = [r.teamId, r.shootoutWith].sort().join()
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ grp: r.grp, a: r.teamId, b: r.shootoutWith })
  }
  return out
}
