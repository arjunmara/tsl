import type { OutboxEntry } from './commands'
import { supabase } from './supabase'

/** A Fixture: a side is a Team id, or while unknown a source label ("A1", "Winner SF1"); src is "Bye" for a Team that skipped round 1. */
export type Match = {
  id: string; stage: 'group' | 'knockout' | 'league'; round: string; label: string | null; ord: number
  homeTeamId: string | null; awayTeamId: string | null; homeSrc: string | null; awaySrc: string | null; kickOff: string | null; version: number
  /** scheduled, live or finished. */
  status?: string
  /** The result of a finished Match, and its shootout (Story 4.6). */
  hg?: number | null; ag?: number | null; homePens?: number | null; awayPens?: number | null
}
type Row = { id: string; stage: Match['stage']; round: string; label: string | null; ord: number; home_team_id: string | null; away_team_id: string | null
  home_src: string | null; away_src: string | null; kick_off: string | null; version: number; status?: string
  hg?: number | null; ag?: number | null; home_pens?: number | null; away_pens?: number | null }

// The last read per Season, kept on the device (ids and labels only): offline, the cards show it.
const key = (seasonId: string) => `tsl-matches:${seasonId}`

/** The Season's Fixtures in order. Offline, the last read kept on this device; else { code }. */
export async function seasonMatches(seasonId: string): Promise<{ matches: Match[]; published: boolean } | { code: 'offline' | 'unknown' }> {
  const kept = () => {
    try {
      const last = JSON.parse(localStorage.getItem(key(seasonId)) ?? 'null') as { matches: Match[]; published: boolean } | null
      if (last && Array.isArray(last.matches)) return last
    } catch {
      // Blocked or bad storage: nothing kept.
    }
    return { code: 'offline' as const }
  }
  // Offline, skip the network: its retries would hold the pending swaps and kick-offs back for seconds.
  if (!navigator.onLine) return kept()
  try {
    const { data, error, status } = await supabase.schema('app').from('match')
      .select('id, stage, round, label, ord, home_team_id, away_team_id, home_src, away_src, kick_off, version, status, hg, ag, home_pens, away_pens').eq('season_id', seasonId).order('ord')
    const season = await supabase.schema('app').from('season').select('fixtures_published_at').eq('id', seasonId)
    const bad = error ?? season.error ? (error ? status : season.status) : null
    if (bad !== null) return bad === 0 || !navigator.onLine ? kept() : { code: 'unknown' }
    const matches = (data as Row[]).map((r): Match => ({ id: r.id, stage: r.stage, round: r.round, label: r.label, ord: r.ord, homeTeamId: r.home_team_id,
      awayTeamId: r.away_team_id, homeSrc: r.home_src, awaySrc: r.away_src, kickOff: r.kick_off, version: r.version ?? 1, status: r.status ?? 'scheduled',
      hg: r.hg, ag: r.ag, homePens: r.home_pens, awayPens: r.away_pens }))
    const published = !!(season.data as { fixtures_published_at: string | null }[] | null)?.[0]?.fixtures_published_at
    try {
      localStorage.setItem(key(seasonId), JSON.stringify({ matches, published }))
    } catch {
      // Storage full or blocked: only the offline fallback is lost.
    }
    return { matches, published }
  } catch {
    return kept()
  }
}

/** "SF · SF1", "Group A": the round, with the label when it adds something. */
export const matchMeta = (m: Match) => (m.label && m.label !== m.round ? `${m.round} · ${m.label}` : m.round)

/** The Fixtures as this device should show them: the read with this user's pending swaps and kick-offs laid over (each bumps the versions; one whose version no longer matches the read is already applied). */
export function overlayMatches(base: Match[], queued: OutboxEntry[], seasonId: string): Match[] {
  const ms = base.map((m) => ({ ...m }))
  for (const { name, args: a } of queued) {
    if (a.season_id !== seasonId) continue
    if (name === 'swap_fixtures') {
      const x = ms.find((m) => m.id === a.match_a)
      const y = ms.find((m) => m.id === a.match_b)
      if (x && y && x.version === a.version_a && y.version === a.version_b) [x.ord, y.ord, x.version, y.version] = [y.ord, x.ord, x.version + 1, y.version + 1]
    } else if (name === 'set_kick_off') {
      const m = ms.find((x) => x.id === a.match_id)
      if (m && m.version === a.expected_version) [m.kickOff, m.version] = [String(a.kick_off), m.version + 1]
    }
  }
  return ms.sort((p, q) => p.ord - q.ord)
}
