import type { PlayerData, ResultData } from './graphics'
import type { Brand } from './listGraphics'
import { supabase } from './supabase'
import type { Team } from './teams'

// Season awards and top scorers (Story 5.6). The Top Scorer is derived from the goals and never stored; Best Goalkeeper and Player of the Tournament are
// rows an Organiser sets (set_season_award). Nothing here is a Graphic's own storage: the Graphics are made on the device from what this reads.

export type AwardKey = 'best_goalkeeper' | 'player_of_tournament'
export const AWARDS: Record<AwardKey, string> = { best_goalkeeper: 'Best Goalkeeper', player_of_tournament: 'Player of the Tournament' }
export type Scorer = { playerId: string; teamId: string; goals: number }
export type SeasonPlayer = { playerId: string; name: string; shirt: number | null; teamId: string }
export type AwardRow = { id: string; award: AwardKey; playerId: string; version: number }
export type SeasonAwardsData = { scorers: Scorer[]; players: SeasonPlayer[]; awards: AwardRow[] }

const key = (seasonId: string) => `tsl-awards:${seasonId}`

/** The Season's scorers, Players (names only) and set awards. Offline, the last read kept on this device; else { code }. */
export async function readSeasonAwards(seasonId: string, teamIds: string[]): Promise<SeasonAwardsData | { code: 'offline' | 'unknown' }> {
  const kept = () => {
    try {
      const last = JSON.parse(localStorage.getItem(key(seasonId)) ?? 'null') as SeasonAwardsData | null
      if (last && Array.isArray(last.scorers) && Array.isArray(last.players) && Array.isArray(last.awards)) return last
    } catch {
      // Blocked or bad storage: nothing kept.
    }
    return { code: 'offline' as const }
  }
  if (!navigator.onLine) return kept()
  try {
    const app = supabase.schema('app')
    const [sc, sq, aw] = await Promise.all([
      app.rpc('season_top_scorers', { p_season_id: seasonId }),
      teamIds.length ? app.from('squad_entry').select('team_id, shirt_number, player(id, name)').in('team_id', teamIds) : Promise.resolve({ data: [], error: null, status: 200 }),
      app.from('season_awards').select('id, award, player_id, version').eq('season_id', seasonId),
    ])
    const bad = sc.error ?? sq.error ?? aw.error
    if (bad) return sc.status === 0 || sq.status === 0 || aw.status === 0 || !navigator.onLine ? kept() : { code: 'unknown' }
    const list = (x: unknown) => (Array.isArray(x) ? (x as Record<string, unknown>[]) : [])
    const scorers = list(sc.data).map((r): Scorer => ({ playerId: r.player_id as string, teamId: r.team_id as string, goals: r.goals as number }))
    const players = list(sq.data).flatMap((r) => {
      const p = (Array.isArray(r.player) ? r.player[0] : r.player) as { id: string; name: string } | undefined
      return p ? [{ playerId: p.id, name: p.name, shirt: r.shirt_number as number | null, teamId: r.team_id as string }] : []
    })
    const awards = list(aw.data).map((r): AwardRow => ({ id: r.id as string, award: r.award as AwardKey, playerId: r.player_id as string, version: r.version as number }))
    const out = { scorers, players, awards }
    try {
      localStorage.setItem(key(seasonId), JSON.stringify(out))
    } catch {
      // Storage full or blocked: only the offline fallback is lost.
    }
    return out
  } catch {
    return kept()
  }
}

/** The Players level on the most goals (all of them, for a tie); none before any goal. */
export const topScorers = (scorers: Scorer[]) => {
  const most = Math.max(0, ...scorers.map((s) => s.goals))
  return most > 0 ? scorers.filter((s) => s.goals === most) : []
}

const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
const surname = (name: string) => name.trim().split(/\s+/).at(-1) ?? name

/**
 * The award Graphics that can be made now, in order: Top Scorer (every tied leader), Best Goalkeeper, Player of the Tournament. They use the Player Template on
 * a Season base (no Match); a cut-out only comes from `cutouts`, which the consent gate (cutOutUrls) filled. Tied leaders make one text-only Graphic.
 */
export function awardGraphics(b: Brand, seasonNumber: number, d: SeasonAwardsData, byId: Map<string, Team>, cutouts: Map<string, string>): PlayerData[] {
  const side = { code: '', name: '', kit: null, score: 0, goals: [] }
  const base: ResultData = { template: b.template, tournament: b.tournament, logo: b.logo, primary: b.primary, secondary: b.secondary, round: `Season ${seasonNumber} awards`, home: side, away: side,
    pens: null, date: '', venue: b.venue, sponsors: b.sponsors }
  const name = (id: string) => d.players.find((p) => p.playerId === id)?.name ?? ''
  const team = (id: string) => byId.get(d.players.find((p) => p.playerId === id)?.teamId ?? d.scorers.find((s) => s.playerId === id)?.teamId ?? '')
  const out: PlayerData[] = []
  const make = (label: string, ids: string[], goals: number | null) => {
    const who = ids.map((id) => ({ id, name: name(id), team: team(id) })).filter((x) => x.name)
    if (who.length === 0) return
    const one = who.length === 1 ? who[0]! : null
    const text = who.map((x) => `${x.name} (${x.team?.name ?? '?'})`).join(' and ')
    const n = goals === null ? '' : `, ${goals} goal${goals === 1 ? '' : 's'}`
    out.push({
      kind: 'award', base, word: one ? surname(one.name).toUpperCase() : 'TIED', label, name: one ? one.name : who.map((x) => x.name).join(' and '), team: one ? one.team?.name ?? null : null,
      minute: null, assist: null, cutout: one ? cutouts.get(one.id) ?? null : null,
      title: `${label} Graphic for ${who.map((x) => x.name).join(' and ')}`, caption: `${label}, ${b.tournament} Season ${seasonNumber}: ${text}${n}.`,
      file: `${slug(label)}.png`,
    })
  }
  const lead = topScorers(d.scorers).sort((x, y) => name(x.playerId).localeCompare(name(y.playerId)))
  make('Top Scorer', lead.map((s) => s.playerId), lead[0]?.goals ?? null)
  for (const k of Object.keys(AWARDS) as AwardKey[]) {
    const row = d.awards.find((a) => a.award === k)
    if (row) make(AWARDS[k], [row.playerId], null)
  }
  return out
}
