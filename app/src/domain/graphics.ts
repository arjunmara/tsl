import { goalsOf, readConsole, type Console, type ConsoleTeam, type MatchEvent } from './console'
import { formatDate, inZone } from './format'
import type { Match } from './matches'
import { cutOutUrls } from './playerPhotos'
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

type Loaded = { c: Console; d: ResultData }
/** The console and what every Template of a finished Match shows; { code } when the server can't be reached or doesn't answer. */
async function load(tournamentId: string, seasonId: string, match: Match): Promise<Loaded | { code: 'offline' | 'unknown' }> {
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
  const d: ResultData = {
    tournament: t.tournament.name, logo: t.tournament.logoPath ? logoUrl(t.tournament.logoPath) : null,
    primary: t.tournament.brandPrimary, secondary: t.tournament.brandSecondary, round: matchMetaOf(match),
    home: side(homeT, match.hg), away: side(awayT, match.ag),
    pens: c.match.homePens != null && c.match.awayPens != null ? { home: c.match.homePens, away: c.match.awayPens } : null,
    date: day ? formatDate(day) : '', venue: (v.data as { venue: string | null } | null)?.venue ?? '',
    sponsors: 'code' in s ? [] : s.sponsors.map((x) => ({ name: x.caption, logo: logoUrl(x.logo_path) })),
  }
  return { c, d }
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

// Player Graphics (Story 5.3) and the Post-match pack (Story 5.4): result, goals, cards, missed penalties, Man of the Match, Fair Player.

export type Kind = 'goal' | 'card' | 'missed' | 'mom' | 'fair' | 'award'
export type PlayerData = {
  kind: Kind
  base: ResultData
  /** The big word (GOAL, CARD, MISSED or an Award's surname), the label chip, the panel name, the Team line (none when text-only), the minute and assist (goals only). */
  word: string; label: string; name: string; team: string | null; minute: number | null; assist: string | null
  /** The signed cut-out, only for a Player the consent gate lets through. */
  cutout: string | null
  /** What the card is called ("goal Graphic for Roshan Adhikari 12′"), the share caption and the file name. */
  title: string; caption: string; file: string
}
export type Pack = { result: ResultData; players: PlayerData[] }

/** The line that stands in for a kind with no Graphics. */
export const emptyReason: Record<Kind, string> = {
  goal: 'No goals in this Match', card: 'No cards in this Match', missed: 'No missed penalties', mom: 'No Man of the Match chosen', fair: 'No Fair Player chosen', award: 'No Season award chosen',
}

/** One share caption for the whole pack: each Graphic's caption in pack order, a blank line between. */
export const combinedCaption = (p: Pack) => [caption(p.result), ...p.players.map((x) => x.caption)].join('\n\n')

/** The last word of a name. */
const surname = (name: string) => name.trim().split(/\s+/).at(-1) ?? name
const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'player'

/** The Post-match pack of a finished Match, read fresh; { code } when the server can't be reached or doesn't answer. */
export async function packData(tournamentId: string, seasonId: string, match: Match): Promise<Pack | { code: 'offline' | 'unknown' }> {
  const r = await load(tournamentId, seasonId, match)
  if (!('d' in r)) return r
  const { c, d } = r
  const teamOf = (id: string | null | undefined) => c.teams.find((t) => t.teamId === id)
  const player = (id: string | null | undefined) => {
    const t = c.teams.find((x) => x.squad.some((p) => p.playerId === id))
    return t && { team: t, name: t.squad.find((p) => p.playerId === id)!.name }
  }
  const inOrder = (f: (e: MatchEvent) => boolean) => [...c.events].reverse().filter(f).sort((a, b) => a.minute - b.minute)
  const goals = inOrder((e) => e.kind === 'goal' && !!e.teamId)
  const cards = inOrder((e) => e.kind === 'card' && (e.card === 'yellow' || e.card === 'red'))
  const missed = inOrder((e) => e.kind === 'missed_penalty')
  const awards = [['Man of the Match', c.match.momId], ['Fair Player', c.match.fairId]] as const
  const ids = [...goals.filter((e) => !e.ownGoal).map((e) => e.playerId), ...cards.map((e) => e.playerId), ...missed.map((e) => e.playerId), ...awards.map(([, id]) => id)].filter((id): id is string => !!id)
  const cutouts = await cutOutUrls(c.match.seasonId || seasonId, ids)
  const score = `${d.home.name} ${d.home.score}, ${d.away.name} ${d.away.score}`
  const when = [d.date, d.venue].filter(Boolean).join(', ')
  const out: PlayerData[] = []
  for (const e of goals) {
    const credited = teamOf(e.teamId)
    if (!credited) continue
    const who = e.ownGoal ? undefined : player(e.playerId)
    // Own goal: the scorer's own Team is the other one. No scorer: the Team the goal counts for.
    const name = who ? who.name : e.ownGoal ? `Own goal (${c.teams.find((t) => t.teamId !== credited.teamId)?.code ?? credited.code})` : `Goal (${credited.name})`
    const assist = e.assistId ? player(e.assistId)?.name ?? null : null
    out.push({
      kind: 'goal', base: d, word: 'GOAL', label: 'Goal', name, team: who ? who.team.name : null, minute: e.minute, assist: who ? assist : null, cutout: who ? cutouts.get(e.playerId!) ?? null : null,
      title: `goal Graphic for ${name} ${e.minute}′`,
      caption: [`Goal: ${who ? `${name} (${who.team.name})` : name} ${e.minute}′. ${score}.`, `${d.round}, ${d.tournament}.`, when && `${when}.`].filter(Boolean).join(' '),
      file: `${credited.code}-${who ? slug(surname(name)) : e.ownGoal ? 'own-goal' : 'goal'}-${e.minute}.png`,
    })
  }
  // Cards and missed penalties: the same Template; a Player with no name on record leaves "[label] ([Team name])" as text only.
  const events: [Kind, MatchEvent[], (e: MatchEvent) => string][] = [
    ['card', cards, (e) => (e.card === 'red' ? 'Red card' : 'Yellow card')], ['missed', missed, () => 'Missed penalty'],
  ]
  for (const [kind, list, labelOf] of events) {
    for (const e of list) {
      const label = labelOf(e)
      const who = player(e.playerId)
      const team = who?.team ?? teamOf(e.teamId)
      if (!team) continue
      const name = who ? who.name : `${label} (${team.name})`
      out.push({
        kind, base: d, word: kind === 'card' ? 'CARD' : 'MISSED', label, name, team: who ? team.name : null, minute: e.minute, assist: null, cutout: who ? cutouts.get(e.playerId!) ?? null : null,
        title: `${label.toLowerCase()} Graphic for ${name} ${e.minute}′`,
        caption: [`${label}: ${who ? `${name} (${team.name})` : name} ${e.minute}′.`, `${d.home.name} v ${d.away.name}, ${d.round}, ${d.tournament}.`, when && `${when}.`].filter(Boolean).join(' '),
        file: `${team.code}-${slug(label)}-${who ? `${slug(surname(name))}-` : ''}${e.minute}.png`,
      })
    }
  }
  for (const [award, id] of awards) {
    const who = id ? player(id) : undefined
    if (!who) continue
    out.push({
      kind: award === 'Fair Player' ? 'fair' : 'mom', base: d, word: surname(who.name).toUpperCase(), label: award, name: who.name, team: who.team.name, minute: null, assist: null, cutout: cutouts.get(id!) ?? null,
      title: `${award} Graphic for ${who.name}`,
      caption: [`${award}: ${who.name} (${who.team.name}). ${score}, ${d.round}, ${d.tournament}.`, when && `${when}.`].filter(Boolean).join(' '),
      file: `${who.team.code}-${slug(award)}.png`,
    })
  }
  // The same Graphic twice (two goals in one minute): number the later ones so labels and files stay distinct.
  const seen = { title: new Map<string, number>(), file: new Map<string, number>() }
  const nth = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1).get(k)!
  for (const d of out) {
    const t = nth(seen.title, d.title)
    const f = nth(seen.file, d.file)
    if (t > 1) d.title += ` (${t})`
    if (f > 1) d.file = d.file.replace(/\.png$/, `-${f}.png`)
  }
  return { result: d, players: out }
}
