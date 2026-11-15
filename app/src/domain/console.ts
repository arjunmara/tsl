import { runCommand, type CommandResult } from './commands'
import { supabase } from './supabase'

// The scoring console's pre-match (Story 4.2, FR-22): who holds scoring, the line-ups and the kit colours of the day.

export type SquadPlayer = { playerId: string; name: string; shirt: number }
export type Lineup = { starters: string[]; bench: string[]; kitColour: string; version: number }
export type ConsoleTeam = { teamId: string; name: string; code: string; registeredKit: string | null; side: 'home' | 'away'; squad: SquadPlayer[]; lineup: Lineup | null }
export type Console = {
  match: { id: string; seasonId: string; tournamentId: string; stage: string; round: string; label: string | null; kickOff: string | null; status: string; seasonStatus: string }
  rules: { starters: number; maxBench: number }
  /** This device holds scoring; held: some device does; onAir: this is the Tournament's On-air Match. */
  holder: boolean; held: boolean; onAir: boolean
  /** Home first. */
  teams: ConsoleTeam[]
}

type Row = {
  match: { id: string; season_id: string; tournament_id: string; stage: string; round: string; label: string | null; kick_off: string | null; status: string; season_status: string }
  rules: { starters: number; max_bench: number }
  holder: boolean; held: boolean; on_air: boolean
  teams: { team_id: string; name: string; code: string; registered_kit: string | null; side: 'home' | 'away'; squad: { player_id: string; name: string; shirt: number }[]
    lineup: { starters: string[]; bench: string[]; kit_colour: string; version: number } | null }[]
}

/** The console of one Match for an Organiser or an approved Scorer phone: 'none' for anyone else or an unknown Match. */
export async function readConsole(matchId: string): Promise<Console | 'none' | { code: 'offline' | 'unknown' }> {
  try {
    const { data, error, status } = await supabase.schema('app').rpc('console_match', { p_match_id: matchId })
    if (error) return { code: status === 0 || !navigator.onLine ? 'offline' : 'unknown' }
    if (!data) return 'none'
    const r = data as Row
    return {
      match: { id: r.match.id, seasonId: r.match.season_id, tournamentId: r.match.tournament_id, stage: r.match.stage, round: r.match.round, label: r.match.label,
        kickOff: r.match.kick_off, status: r.match.status, seasonStatus: r.match.season_status },
      rules: { starters: r.rules.starters, maxBench: r.rules.max_bench },
      holder: r.holder, held: r.held, onAir: r.on_air,
      teams: r.teams.map((t) => ({ teamId: t.team_id, name: t.name, code: t.code, registeredKit: t.registered_kit, side: t.side,
        squad: t.squad.map((p) => ({ playerId: p.player_id, name: p.name, shirt: p.shirt })),
        lineup: t.lineup && { starters: t.lineup.starters, bench: t.lineup.bench, kitColour: t.lineup.kit_colour, version: t.lineup.version } })),
    }
  } catch {
    return { code: 'offline' }
  }
}

/** Opening a Match takes scoring when nobody holds it. Needs a signal, so it is never queued. 'scoring_elsewhere': read-only. */
export const takeScoring = (seasonId: string, matchId: string): Promise<CommandResult> =>
  runCommand('take_scoring', { season_id: seasonId, match_id: matchId })

/** A Scorer phone's Matches: the live ones and the next scheduled one. */
export type ScorerMatch = { matchId: string; round: string; label: string | null; kickOff: string | null; status: string; homeCode: string | null; awayCode: string | null; held: boolean; mine: boolean }
export async function scorerMatches(seasonId: string): Promise<ScorerMatch[] | { code: 'offline' | 'unknown' }> {
  try {
    const { data, error, status } = await supabase.schema('app').rpc('scorer_matches', { p_season_id: seasonId })
    if (error) return { code: status === 0 || !navigator.onLine ? 'offline' : 'unknown' }
    return (data as { match_id: string; round: string; label: string | null; kick_off: string | null; status: string; home_code: string | null; away_code: string | null; held: boolean; mine: boolean }[])
      .map((r) => ({ matchId: r.match_id, round: r.round, label: r.label, kickOff: r.kick_off, status: r.status, homeCode: r.home_code, awayCode: r.away_code, held: r.held, mine: r.mine }))
  } catch {
    return { code: 'offline' }
  }
}

/** Why the line-up can't be confirmed yet, in words (the server says the same); null when it can. */
export function lineupReason(starters: number, bench: number, rules: Console['rules']): string | null {
  if (starters !== rules.starters) return `Line-up needs ${rules.starters} ${rules.starters === 1 ? 'starter' : 'starters'}. You've picked ${starters}.`
  if (bench > rules.maxBench) return `Bench can hold up to ${rules.maxBench}. You've picked ${bench}.`
  return null
}
