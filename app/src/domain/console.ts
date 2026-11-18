import { runCommand, type CommandResult } from './commands'
import { supabase } from './supabase'

// The scoring console's pre-match (Story 4.2, FR-22): who holds scoring, the line-ups and the kit colours of the day.

export type SquadPlayer = { playerId: string; name: string; shirt: number }
export type Lineup = { starters: string[]; bench: string[]; kitColour: string; version: number }
export type ConsoleTeam = { teamId: string; name: string; code: string; registeredKit: string | null; side: 'home' | 'away'; squad: SquadPlayer[]; lineup: Lineup | null }
/** The Match clock (Story 4.3): elapsedMs plus, while running, the time since anchorAt. period 0: not started; interval: between periods. */
export type ClockState = { running: boolean; anchorAt: string | null; elapsedMs: number; period: number; interval: boolean }
/** A Period divider (or clock correction) of the Event log; home and away: the score then. */
export type MatchEvent = {
  id: string; kind: 'period_start' | 'period_end' | 'match_end' | 'clock_set' | 'goal'; period: number; minute: number; enteredAt: string; home: number | null; away: number | null
  /** Goals (Story 4.4): the Team it counts for, the scorer (none: own goal or unknown scorer), the assist, and the goal's version for edits. */
  teamId?: string | null; playerId?: string | null; assistId?: string | null; ownGoal?: boolean; version?: number
}
export type Console = {
  match: { id: string; seasonId: string; tournamentId: string; stage: string; round: string; label: string | null; kickOff: string | null; status: string; seasonStatus: string; version: number }
  /** periods: regular periods; extraTimePeriods: 0 unless this is a knockout Match with extra time on. */
  rules: { starters: number; maxBench: number; periods: number; extraTimePeriods: number; periodMinutes: number; extraTimeMinutes: number }
  clock: ClockState
  score: { home: number; away: number }
  /** Newest first. */
  events: MatchEvent[]
  /** This device holds scoring; held: some device does; onAir: this is the Tournament's On-air Match. */
  holder: boolean; held: boolean; onAir: boolean
  /** Home first. */
  teams: ConsoleTeam[]
}

type Row = {
  match: { id: string; season_id: string; tournament_id: string; stage: string; round: string; label: string | null; kick_off: string | null; status: string; season_status: string; version: number }
  rules: { starters: number; max_bench: number; periods: number; extra_time_periods: number; period_minutes?: number; extra_time_minutes?: number }
  clock: { running: boolean; anchor_at: string | null; elapsed_ms: number; period: number; interval: boolean }
  score: { home: number; away: number }
  events: { id: string; kind: MatchEvent['kind']; period: number; minute: number; entered_at: string; home: number | null; away: number | null
    team_id?: string | null; player_id?: string | null; assist_id?: string | null; own_goal?: boolean; version?: number }[]
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
        kickOff: r.match.kick_off, status: r.match.status, seasonStatus: r.match.season_status, version: r.match.version },
      rules: { starters: r.rules.starters, maxBench: r.rules.max_bench, periods: r.rules.periods, extraTimePeriods: r.rules.extra_time_periods,
        periodMinutes: r.rules.period_minutes ?? 20, extraTimeMinutes: r.rules.extra_time_minutes ?? 5 },
      clock: { running: r.clock.running, anchorAt: r.clock.anchor_at, elapsedMs: r.clock.elapsed_ms, period: r.clock.period, interval: r.clock.interval },
      score: r.score,
      events: r.events.map((e) => ({ id: e.id, kind: e.kind, period: e.period, minute: e.minute, enteredAt: e.entered_at, home: e.home, away: e.away,
        teamId: e.team_id, playerId: e.player_id, assistId: e.assist_id, ownGoal: e.own_goal, version: e.version })),
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

// The Match clock (Story 4.3). Every phone shows the same time: elapsedMs plus, while running, the server-corrected time since anchorAt.

/** The clock's time in milliseconds at `now`. */
export const elapsedAt = (c: ClockState, now: Date): number =>
  c.elapsedMs + (c.running && c.anchorAt ? Math.max(0, now.getTime() - Date.parse(c.anchorAt)) : 0)

/** "12:40"; past an hour the minutes keep counting ("105:00"). */
export const formatClock = (ms: number): string => {
  const t = Math.floor(Math.max(0, ms) / 1000)
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** "14:05" or "105:00" as milliseconds; null when it isn't a time. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(text.trim())
  return m && Number(m[1]) <= 360 && (Number(m[1]) < 360 || m[2] === '00') ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null
}

/** "1st half" and "2nd half" for two periods, else "period 3"; then "extra time", "extra time 2". */
export function periodName(n: number, rules: Console['rules']): string {
  if (n > rules.periods) return n === rules.periods + 1 ? 'extra time' : `extra time ${n - rules.periods}`
  return rules.periods === 2 ? ['1st half', '2nd half'][n - 1]! : `period ${n}`
}

export type ClockOp = 'start' | 'pause' | 'next' | 'set' | 'end'
export const clockCommand: Record<ClockOp, string> = { start: 'start_clock', pause: 'pause_clock', next: 'next_period', set: 'set_clock', end: 'end_match' }

/** The period button(s) now: what each does and the command it sends, as the server decides it. None before kick-off. */
export function periodButtons(c: ClockState, rules: Console['rules']): { label: string; op: 'next' | 'end' }[] {
  const last = rules.periods + rules.extraTimePeriods
  if (c.period === 0) return []
  if (c.interval) return [{ label: `Start ${periodName(c.period + 1, rules)}`, op: 'next' }]
  if (c.period === rules.periods && rules.extraTimePeriods > 0) return [{ label: 'Start extra time', op: 'next' }, { label: 'End the match', op: 'end' }]
  if (c.period >= last) return [{ label: 'End the match', op: 'end' }]
  return [{ label: c.period === 1 && rules.periods === 2 ? 'Start half-time' : 'Start interval', op: 'next' }]
}

/** What a clock command does to the clock and the Match status on this phone, mirroring the server; null when the server would refuse it. */
export function stepClock(c: ClockState, op: ClockOp, at: Date, rules: Console['rules'], ms?: number): { clock: ClockState; status?: string; event?: MatchEvent['kind'] } | null {
  const stamp = at.toISOString()
  const el = elapsedAt(c, at)
  const to = (p: Partial<ClockState>): ClockState => ({ ...c, anchorAt: stamp, ...p })
  if (op === 'start') {
    if (c.running || c.interval) return null
    return c.period === 0 ? { clock: to({ running: true, elapsedMs: 0, period: 1 }), status: 'live', event: 'period_start' } : { clock: to({ running: true }) }
  }
  if (op === 'pause') return c.running ? { clock: to({ running: false, elapsedMs: el }) } : null
  if (c.period === 0) return null
  if (op === 'set') return ms == null || ms < 0 ? null : { clock: to({ elapsedMs: ms }), event: 'clock_set' }
  if (op === 'end') return { clock: to({ running: false, elapsedMs: el }), status: 'finished', event: 'match_end' }
  const btn = periodButtons(c, rules)[0]
  if (!btn || btn.op !== 'next') return null
  if (c.interval || (c.period === rules.periods && rules.extraTimePeriods > 0)) return { clock: to({ running: true, elapsedMs: 0, period: c.period + 1, interval: false }), event: 'period_start' }
  return { clock: to({ running: false, elapsedMs: el, interval: true }), event: 'period_end' }
}

/** A divider in words: "2nd half started · 2 – 3". Null for events the log doesn't show. */
export function dividerText(e: MatchEvent, rules: Console['rules']): string | null {
  const score = ` · ${e.home ?? 0} – ${e.away ?? 0}`
  if (e.kind === 'period_start') return `${periodName(e.period, rules).replace(/^./, (x) => x.toUpperCase())} started${score}`
  if (e.kind === 'period_end') return `${e.period === 1 && rules.periods === 2 ? 'Half-time' : 'Interval'} started${score}`
  if (e.kind === 'match_end') return `Match ended${score}`
  return null
}

// Goals (Story 4.4). The score is never typed or stored on the phone: it is the undeleted goal events per Team.

/** Player names by id, filled when a console opens, for the hand-back's words. */
export const playerNames = new Map<string, string>()

/** The goals a Team has (an own goal counts for the Team it was recorded for). */
export const goalsOf = (events: MatchEvent[], teamId: string): number => events.filter((e) => e.kind === 'goal' && e.teamId === teamId).length

/** The minute of a goal: the minutes of the earlier periods, plus the whole minutes elapsed in this one, plus 1. */
export function goalMinute(c: ClockState, rules: Console['rules'], at: Date): number {
  let earlier = 0
  for (let p = 1; p < c.period; p++) earlier += p <= rules.periods ? rules.periodMinutes : rules.extraTimeMinutes
  return earlier + Math.floor(elapsedAt(c, at) / 60000) + 1
}

/** Who scored, in words: the Player's name, "Own goal" or "Unknown scorer". */
export const scorerName = (e: MatchEvent, team: ConsoleTeam | undefined): string =>
  e.ownGoal ? 'Own goal' : e.playerId ? team?.squad.find((p) => p.playerId === e.playerId)?.name ?? 'Unknown scorer' : 'Unknown scorer'

/** A Team's starters for the picker, from the line-up picks (on-pitch changes come with substitutions). */
export const starters = (t: ConsoleTeam, picks: Record<string, 'start' | 'bench'>): SquadPlayer[] => t.squad.filter((p) => picks[p.playerId] === 'start')
