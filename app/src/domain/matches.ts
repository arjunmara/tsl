import { supabase } from './supabase'

/** A Fixture: a side is a Team id, or while unknown a source label ("A1", "Winner SF1"); src is "Bye" for a Team that skipped round 1. */
export type Match = {
  id: string; stage: 'group' | 'knockout' | 'league'; round: string; label: string | null; ord: number
  homeTeamId: string | null; awayTeamId: string | null; homeSrc: string | null; awaySrc: string | null; kickOff: string | null
}
type Row = { id: string; stage: Match['stage']; round: string; label: string | null; ord: number; home_team_id: string | null; away_team_id: string | null
  home_src: string | null; away_src: string | null; kick_off: string | null }

// The last read per Season, kept on the device (ids and labels only): offline, the cards show it.
const key = (seasonId: string) => `tsl-matches:${seasonId}`

/** The Season's Fixtures in order. Offline, the last read kept on this device; else { code }. */
export async function seasonMatches(seasonId: string): Promise<{ matches: Match[] } | { code: 'offline' | 'unknown' }> {
  const kept = () => {
    try {
      const last = JSON.parse(localStorage.getItem(key(seasonId)) ?? 'null') as Match[] | null
      if (Array.isArray(last)) return { matches: last }
    } catch {
      // Blocked or bad storage: nothing kept.
    }
    return { code: 'offline' as const }
  }
  try {
    const { data, error, status } = await supabase.schema('app').from('match')
      .select('id, stage, round, label, ord, home_team_id, away_team_id, home_src, away_src, kick_off').eq('season_id', seasonId).order('ord')
    if (error) return status === 0 || !navigator.onLine ? kept() : { code: 'unknown' }
    const matches = (data as Row[]).map((r): Match => ({ id: r.id, stage: r.stage, round: r.round, label: r.label, ord: r.ord, homeTeamId: r.home_team_id,
      awayTeamId: r.away_team_id, homeSrc: r.home_src, awaySrc: r.away_src, kickOff: r.kick_off }))
    try {
      localStorage.setItem(key(seasonId), JSON.stringify(matches))
    } catch {
      // Storage full or blocked: only the offline fallback is lost.
    }
    return { matches }
  } catch {
    return kept()
  }
}

/** "SF · SF1", "Group A": the round, with the label when it adds something. */
export const matchMeta = (m: Match) => (m.label && m.label !== m.round ? `${m.round} · ${m.label}` : m.round)
