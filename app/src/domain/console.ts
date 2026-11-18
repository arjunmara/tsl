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
  id: string; kind: 'period_start' | 'period_end' | 'match_end' | 'clock_set' | 'goal' | EventKind; period: number; minute: number; enteredAt: string; home: number | null; away: number | null
  /** Goals (Story 4.4): the Team it counts for, the scorer (none: own goal or unknown scorer), the assist, and the goal's version for edits. */
  teamId?: string | null; playerId?: string | null; assistId?: string | null; ownGoal?: boolean; version?: number
  /** Cards, subs and the rest (Story 4.5): the card, the Player coming on (a sub: playerId goes off) and the clock's milliseconds in the period. */
  card?: 'yellow' | 'red' | null; playerOnId?: string | null; clockMs?: number | null
}
export type EventKind = 'card' | 'foul' | 'sub' | 'timeout' | 'missed_penalty'
export type Console = {
  match: { id: string; seasonId: string; tournamentId: string; stage: string; round: string; label: string | null; kickOff: string | null; status: string; seasonStatus: string; version: number }
  /** periods: regular periods; extraTimePeriods: 0 unless this is a knockout Match with extra time on. */
  rules: { starters: number; maxBench: number; periods: number; extraTimePeriods: number; periodMinutes: number; extraTimeMinutes: number
    /** Season settings (Story 4.5); null when off. */
    foulWarning: number | null; timeoutsPerPeriod: number | null; limitedSubs: boolean; maxSubs: number | null; powerPlayMinutes: number | null }
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
  rules: { starters: number; max_bench: number; periods: number; extra_time_periods: number; period_minutes?: number; extra_time_minutes?: number
    foul_warning?: number | null; timeouts_per_period?: number | null; substitutions?: string; max_substitutions?: number | null; power_play_minutes?: number | null }
  clock: { running: boolean; anchor_at: string | null; elapsed_ms: number; period: number; interval: boolean }
  score: { home: number; away: number }
  events: { id: string; kind: MatchEvent['kind']; period: number; minute: number; entered_at: string; home: number | null; away: number | null
    team_id?: string | null; player_id?: string | null; assist_id?: string | null; own_goal?: boolean; version?: number
    card?: 'yellow' | 'red' | null; player_on_id?: string | null; clock_ms?: number | null }[]
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
        periodMinutes: r.rules.period_minutes ?? 20, extraTimeMinutes: r.rules.extra_time_minutes ?? 5,
        foulWarning: r.rules.foul_warning ?? null, timeoutsPerPeriod: r.rules.timeouts_per_period ?? null, limitedSubs: r.rules.substitutions === 'limited',
        maxSubs: r.rules.max_substitutions ?? null, powerPlayMinutes: r.rules.power_play_minutes ?? null },
      clock: { running: r.clock.running, anchorAt: r.clock.anchor_at, elapsedMs: r.clock.elapsed_ms, period: r.clock.period, interval: r.clock.interval },
      score: r.score,
      events: r.events.map((e) => ({ id: e.id, kind: e.kind, period: e.period, minute: e.minute, enteredAt: e.entered_at, home: e.home, away: e.away,
        teamId: e.team_id, playerId: e.player_id, assistId: e.assist_id, ownGoal: e.own_goal, version: e.version,
        card: e.card, playerOnId: e.player_on_id, clockMs: e.clock_ms })),
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

/** A Team's starters from the line-up picks (before any substitution). */
export const starters = (t: ConsoleTeam, picks: Record<string, 'start' | 'bench'>): SquadPlayer[] => t.squad.filter((p) => picks[p.playerId] === 'start')

// Cards, fouls, substitutions, timeouts and power play (Story 4.5). Everything is derived from the event list, so a delete or edit re-derives it.

/** Oldest first by time; events at the same time keep the order they were recorded in (the list is newest first), as the server's created_at does. */
const chronological = (events: MatchEvent[]) => [...events].reverse().sort((a, b) => Date.parse(a.enteredAt) - Date.parse(b.enteredAt))

/** On the pitch now (the starters with each sub applied in order, as the server does) and the rest of the line-up, in Squad order. */
export function pitchOf(t: ConsoleTeam, picks: Record<string, 'start' | 'bench'>, events: MatchEvent[]): { on: SquadPlayer[]; bench: SquadPlayer[] } {
  const on = new Set(starters(t, picks).map((p) => p.playerId))
  for (const e of chronological(events)) {
    if (e.kind === 'sub' && e.teamId === t.teamId && e.playerId && e.playerOnId && on.has(e.playerId) && !on.has(e.playerOnId)) (on.delete(e.playerId), on.add(e.playerOnId))
  }
  // A red-carded Player has left the pitch for good.
  const red = new Set(events.filter((e) => e.kind === 'card' && e.card === 'red' && e.teamId === t.teamId).map((e) => e.playerId))
  return { on: t.squad.filter((p) => on.has(p.playerId) && !red.has(p.playerId)), bench: t.squad.filter((p) => !on.has(p.playerId) && picks[p.playerId] && !red.has(p.playerId)) }
}

/** The period a Team's foul count is for: extra time carries the last regular period's count. */
const foulPeriod = (c: Console): number => Math.min(c.clock.period, c.rules.periods)
/** Fouls count per regular period; in extra time the last regular period's count carries on and the extra-time fouls add to it. */
export const foulsIn = (c: Console, teamId: string): number =>
  c.events.filter((e) => e.kind === 'foul' && e.teamId === teamId && (e.period === foulPeriod(c) || (c.clock.period > c.rules.periods && e.period > c.rules.periods))).length

/** Why a Team can't take a timeout now, in words; null when it can (the server says the same). Null too when the Format has none. */
export function timeoutReason(c: Console, t: ConsoleTeam): string | null {
  const per = c.rules.timeoutsPerPeriod
  if (!per) return null
  if (c.clock.period > c.rules.periods) return 'No timeouts in extra time.'
  const used = c.events.filter((e) => e.kind === 'timeout' && e.teamId === t.teamId && e.period === c.clock.period).length
  return used >= per ? `${t.code} has used ${per === 1 ? 'its timeout' : `all ${per} timeouts`} this ${c.rules.periods === 2 ? 'half' : 'period'}.` : null
}

/** Why a Team can't make another substitution, in words; null when it can. */
export function subsReason(c: Console, t: ConsoleTeam): string | null {
  const max = c.rules.limitedSubs ? c.rules.maxSubs : null
  return max != null && c.events.filter((e) => e.kind === 'sub' && e.teamId === t.teamId).length >= max ? `${t.code} has used all ${max} substitutions.` : null
}

/** Why a change to a sub is refused (it would leave a later sub without its Player on the pitch), as the server says it; null when fine. op 'delete' or 'edit' (player: the new Player going off). */
export function subChangeReason(t: ConsoleTeam, picks: Record<string, 'start' | 'bench'>, events: MatchEvent[], id: string, op: 'edit' | 'delete', player: string | null): string | null {
  const on = new Set(starters(t, picks).map((p) => p.playerId))
  for (const e of chronological(events)) {
    if (e.kind !== 'sub' || e.teamId !== t.teamId || (e.id === id && op === 'delete')) continue
    const off = e.id === id ? player : e.playerId
    if (!off || !on.has(off) || !e.playerOnId || on.has(e.playerOnId)) return 'That change would leave a later substitution without its Player on the pitch.'
    on.delete(off)
    on.add(e.playerOnId)
  }
  return null
}

/** The Players who may come on for a Team: the bench and, when rolling, those subbed off earlier (never those on the pitch). */
export function benchFor(c: Console, t: ConsoleTeam, picks: Record<string, 'start' | 'bench'>): SquadPlayer[] {
  const off = new Set(c.events.filter((e) => e.kind === 'sub' && e.teamId === t.teamId).map((e) => e.playerId))
  return pitchOf(t, picks, c.events).bench.filter((p) => !c.rules.limitedSubs || !off.has(p.playerId))
}

/**
 * The power plays running at `elapsed` (the Match clock's elapsed ms in the current period): one per red card (Format's power_play_minutes) for the
 * opponent, with the time left. Time counts only while the clock runs: the rest of the card's period, whole earlier periods, then this one.
 * It ends at 0 or when the opponent scores after the card. ponytail: a period is taken to have run its full length.
 */
export function powerPlays(c: Console, elapsed: number): { teamId: string; leftMs: number }[] {
  const pp = c.rules.powerPlayMinutes
  if (!pp || !c.clock.period || c.match.status === 'finished') return []
  const order = chronological(c.events)
  const length = (p: number) => (p <= c.rules.periods ? c.rules.periodMinutes : c.rules.extraTimeMinutes) * 60000
  const out: { teamId: string; leftMs: number }[] = []
  for (const e of c.events) {
    if (e.kind !== 'card' || e.card !== 'red' || !e.teamId) continue
    const against = c.teams.find((t) => t.teamId !== e.teamId)?.teamId
    if (!against || order.some((g) => g.kind === 'goal' && g.teamId === against && order.indexOf(g) > order.indexOf(e))) continue
    let played = e.period === c.clock.period ? elapsed - (e.clockMs ?? 0) : length(e.period) - (e.clockMs ?? 0) + elapsed
    for (let p = e.period + 1; p < c.clock.period; p++) played += length(p)
    if (e.period > c.clock.period) continue
    // The clock may have been corrected backwards: never more than the whole power play.
    const left = pp * 60000 - Math.max(0, played)
    if (left > 0) out.push({ teamId: against, leftMs: Math.min(left, pp * 60000) })
  }
  return out
}

/** One event of the log in words: "Yellow card · Ramesh Chudara", "Sub · A off, B on". Goals and dividers read elsewhere. */
export function eventText(e: MatchEvent, team: ConsoleTeam | undefined): string {
  const name = (id: string | null | undefined) => team?.squad.find((p) => p.playerId === id)?.name ?? 'Unknown player'
  if (e.kind === 'card') return `${e.card === 'red' ? 'Red' : 'Yellow'} card · ${name(e.playerId)}`
  if (e.kind === 'foul') return `Foul · ${team?.code}`
  if (e.kind === 'sub') return `Sub · ${name(e.playerId)} off, ${name(e.playerOnId)} on`
  if (e.kind === 'timeout') return `Timeout · ${team?.code}`
  return `Missed penalty · ${name(e.playerId)}`
}
