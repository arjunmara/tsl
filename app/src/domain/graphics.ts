import { goalsOf, readConsole, type ConsoleTeam, type MatchEvent } from './console'
import { formatDate, inZone } from './format'
import type { Match } from './matches'
import { supabase } from './supabase'
import { logoUrl, seasonSponsors, tournamentSetup } from './tournaments'

// The Result Graphic's data and caption (Story 5.1). Nothing here is stored: the Graphic is made on the device from what the server says now.

export type Side = { code: string; name: string; kit: string | null; score: number; goals: { who: string; minute: number }[] }
export type ResultData = {
  tournament: string; logo: string | null; primary: string | null; secondary: string | null; round: string
  home: Side; away: Side; pens: { home: number; away: number } | null; date: string; venue: string; sponsors: { name: string; logo: string }[]
}

/** The Match's goals of one Team in minute order (ties keep the order they were recorded in; the list is newest first). */
function goalsOfTeam(events: MatchEvent[], t: ConsoleTeam, all: ConsoleTeam[]): Side['goals'] {
  const nameOf = (id: string | null | undefined) => all.flatMap((x) => x.squad).find((p) => p.playerId === id)?.name
  return [...events].reverse().filter((e) => e.kind === 'goal' && e.teamId === t.teamId)
    .map((e) => {
      const who = nameOf(e.playerId)
      return { who: e.ownGoal ? (who ? `${who} (og)` : '(og)') : who ?? 'Unknown', minute: e.minute }
    })
    .sort((a, b) => a.minute - b.minute)
}

/** Everything the Classic Template shows for a finished Match; { code } when the server can't be reached or doesn't answer. */
export async function resultData(tournamentId: string, seasonId: string, match: Match): Promise<ResultData | { code: 'offline' | 'unknown' }> {
  const [c, t] = await Promise.all([readConsole(match.id), tournamentSetup(tournamentId)])
  if (typeof c !== 'object' || !('match' in c)) return { code: c === 'none' ? 'unknown' : c.code }
  // The Match's own Season: the Tournament's latest one may be a later Season with another venue and other Sponsors.
  const own = c.match.seasonId || seasonId
  const [s, v] = await Promise.all([seasonSponsors(own), supabase.schema('app').from('season').select('venue').eq('id', own).maybeSingle()])
  if (v.error) return { code: 'unknown' }
  if ('code' in t) return t
  if (!t.tournament?.season) return { code: 'unknown' }
  const homeT = c.teams.find((x) => x.teamId === c.match.homeId) ?? c.teams[0]
  const awayT = c.teams.find((x) => x.teamId === c.match.awayId) ?? c.teams[1]
  if (!homeT || !awayT) return { code: 'unknown' }
  const side = (x: ConsoleTeam, scored: number | null | undefined): Side => ({
    code: x.code, name: x.name, kit: x.lineup?.kitColour ?? x.registeredKit, score: scored ?? goalsOf(c.events, x.teamId), goals: goalsOfTeam(c.events, x, c.teams) })
  const day = match.kickOff ? inZone(match.kickOff).date : ''
  return {
    tournament: t.tournament.name, logo: t.tournament.logoPath ? logoUrl(t.tournament.logoPath) : null,
    primary: t.tournament.brandPrimary, secondary: t.tournament.brandSecondary, round: matchMetaOf(match),
    home: side(homeT, match.hg), away: side(awayT, match.ag),
    pens: c.match.homePens != null && c.match.awayPens != null ? { home: c.match.homePens, away: c.match.awayPens } : null,
    date: day ? formatDate(day) : '', venue: (v.data as { venue: string | null } | null)?.venue ?? '',
    sponsors: 'code' in s ? [] : s.sponsors.map((x) => ({ name: x.caption, logo: logoUrl(x.logo_path) })),
  }
}
const matchMetaOf = (m: Match) => (m.label && m.label !== m.round ? `${m.round} · ${m.label}` : m.round)

/** The share caption, also the thumbnail's alt text. Blank parts (no venue, no Sponsors, no goals) are left out. */
export function caption(d: ResultData): string {
  const { home, away, pens } = d
  const goals = [home, away].flatMap((s) => s.goals.map((g) => `${s.code} ${g.who} ${g.minute}′`))
  const when = [d.date, d.venue].filter(Boolean).join(', ')
  return [
    `Full time: ${home.name} ${home.score}, ${away.name} ${away.score}.`,
    pens && `${pens.home > pens.away ? home.name : away.name} win ${Math.max(pens.home, pens.away)}–${Math.min(pens.home, pens.away)} on penalties.`,
    `${d.round}, ${d.tournament}.`,
    goals.length > 0 && `Goals: ${goals.join(', ')}.`,
    when && `${when}.`,
    d.sponsors.length > 0 && `Sponsored by ${d.sponsors.map((x) => x.name).join(', ')}.`,
  ].filter(Boolean).join(' ')
}

/** "RTM-v-RE8.png" */
export const graphicFile = (d: ResultData) => `${d.home.code}-v-${d.away.code}.png`
