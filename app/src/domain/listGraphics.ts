import { formatDate, inZone } from './format'
import { logoUrl, seasonSponsors, tournamentSetup, TIEBREAKS, type Structure } from './tournaments'
import { drawColumns } from './drawBoard'
import { matchMeta, type Match } from './matches'
import { supabase } from './supabase'
import type { Slot } from './draw'
import type { StandingRow } from './standings'
import type { Scorer } from './seasonAwards'
import type { Team } from './teams'

// The list Graphics (Story 5.5): Official Draw, Fixtures, Results and tables in the Classic list Template. Made on the device from current data; nothing is stored.

export type Brand = { tournament: string; logo: string | null; primary: string | null; secondary: string | null; venue: string; sponsors: { name: string; logo: string }[] }
export type MatchRow = { time: string; home: string; away: string; round: string; score: string | null; pens: string | null }
export type ListBody =
  | { kind: 'draw'; groups: { title: string; teams: { code: string; name: string; kit: string | null }[] }[] }
  | { kind: 'matches'; rows: MatchRow[] }
  | { kind: 'scorers'; rows: { rank: number; code: string; kit: string | null; name: string; goals: number }[] }
  | { kind: 'bracket'; rounds: { title: string; ties: { home: string; away: string; hs: string; as: string }[] }[] }
  | { kind: 'champions'; code: string; kit: string | null; name: string; score: string | null }
  | { kind: 'table'; rows: { pos: number; code: string; kit: string | null; p: number; w: number; d: number; l: number; gd: string; pts: number }[]; footnote: string }
/** title and sub are the Graphic's headline and day line; foot the venue; label names the card, its buttons and (as `heading`) its thumbnail. */
export type ListData = Brand & { body: ListBody; title: string; sub: string; foot: string[]; caption: string; label: string; file: string }

/** The Tournament's brand, Sponsors and the Season's venue, with no Match needed; { code } when the server can't be reached or doesn't answer. */
export async function seasonBrand(tournamentId: string, seasonId: string): Promise<Brand | { code: 'offline' | 'unknown' }> {
  const [t, s, v] = await Promise.all([tournamentSetup(tournamentId), seasonSponsors(seasonId), supabase.schema('app').from('season').select('venue').eq('id', seasonId).maybeSingle()])
  if ('code' in t) return t
  if (v.error || !t.tournament) return { code: 'unknown' }
  return {
    tournament: t.tournament.name, logo: t.tournament.logoPath ? logoUrl(t.tournament.logoPath) : null, primary: t.tournament.brandPrimary, secondary: t.tournament.brandSecondary,
    venue: (v.data as { venue: string | null } | null)?.venue ?? '', sponsors: 'code' in s ? [] : s.sponsors.map((x) => ({ name: x.caption, logo: logoUrl(x.logo_path) })),
  }
}

/** Matches per Graphic before a day splits into parts. */
export const PER_CARD = 8
const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
const group = (grp: number) => (grp === 0 ? 'League' : `Group ${String.fromCharCode(64 + grp)}`)

/** Official Draw (groups then knockout): each group's Teams in slot order. */
export function drawData(b: Brand, seasonNumber: number, structure: Structure, approved: Team[], slots: Slot[], today = inZone(Date.now()).date): ListData {
  const byId = new Map(approved.map((t) => [t.id, t]))
  const groups = drawColumns(structure, approved.length).filter((c) => c.grp > 0).map((c) => ({
    title: c.title,
    teams: slots.filter((s) => s.grp === c.grp && byId.has(s.teamId)).sort((x, y) => x.pos - y.pos).map((s) => { const t = byId.get(s.teamId)!; return { code: t.code, name: t.name, kit: t.kitColour } }),
  }))
  const day = formatDate(today)
  return {
    ...b, body: { kind: 'draw', groups }, title: 'Official Draw', sub: `Season ${seasonNumber} · ${day}`, foot: [], label: 'Official Draw Graphic', file: 'official-draw.png',
    caption: `Official draw, ${b.tournament} Season ${seasonNumber}. ${groups.map((g) => `${g.title}: ${g.teams.map((t) => t.name).join(', ')}.`).join(' ')} ${day}.`,
  }
}

/** A side as the Graphic shows it: the Team's code, or the source label while the Team is not known. */
const sideOf = (id: string | null, src: string | null, byId: Map<string, Team>) => (id ? `${byId.get(id)?.code ?? '?'}${src === 'Bye' ? ' (Bye)' : ''}` : src ?? '?')

/**
 * Fixtures or Results: Matches with a kick-off, one Graphic per Nepal-time day (a day over PER_CARD Matches splits into parts). Fixtures are the unfinished
 * Matches, soonest day first; Results the finished ones, latest day first. sides are the database's resolved Teams for knockout Matches.
 */
export function dayData(kind: 'fixtures' | 'results', b: Brand, matches: Match[], byId: Map<string, Team>, sides: Map<string, { homeTeamId: string | null; awayTeamId: string | null }>): ListData[] {
  const done = kind === 'results'
  const days = new Map<string, { m: Match; time: string }[]>()
  for (const m of matches) {
    if (!m.kickOff || (m.status === 'finished') !== done) continue
    const z = inZone(m.kickOff)
    days.set(z.date, [...(days.get(z.date) ?? []), { m, time: z.time }])
  }
  const name = done ? 'Results' : 'Fixtures'
  return [...days.keys()].sort((x, y) => (done ? y.localeCompare(x) : x.localeCompare(y))).flatMap((date) => {
    const all = days.get(date)!.sort((x, y) => x.time.localeCompare(y.time) || x.m.ord - y.m.ord)
    const parts = Math.ceil(all.length / PER_CARD)
    return Array.from({ length: parts }, (_, i) => {
      const rows = all.slice(i * PER_CARD, (i + 1) * PER_CARD).map(({ m, time }): MatchRow => {
        const s = sides.get(m.id)
        return { time, home: sideOf(s ? s.homeTeamId : m.homeTeamId, m.homeSrc, byId), away: sideOf(s ? s.awayTeamId : m.awayTeamId, m.awaySrc, byId), round: matchMeta(m),
          score: done ? `${m.hg ?? 0}–${m.ag ?? 0}` : null, pens: done && m.homePens != null && m.awayPens != null ? `${m.homePens}–${m.awayPens} pens` : null }
      })
      const day = formatDate(date)
      const part = parts > 1 ? ` · Part ${i + 1} of ${parts}` : ''
      const entry = (r: MatchRow) => `${r.time} ${r.home} ${r.score ?? 'v'} ${r.away}${r.pens ? ` (${r.pens})` : ''} (${r.round})`
      return {
        ...b, body: { kind: 'matches', rows }, title: name, sub: day + part, foot: b.venue ? [b.venue] : [], label: `${name} Graphic for ${day}${part.replace(' · ', ', ')}`,
        file: `${name.toLowerCase()}-${date}${parts > 1 ? `-part-${i + 1}` : ''}.png`,
        caption: `${name}, ${b.tournament}, ${day}${part.replace(' · ', ', ')}: ${rows.map(entry).join('; ')}.${b.venue ? ` ${b.venue}.` : ''}`,
      }
    })
  })
}

/**
 * The table Graphics: one per group in order (a League has one), rows exactly as the database gave them. N in the caption is the number of Nepal-time days
 * with a finished Match in that group.
 */
export function tableData(b: Brand, structure: Structure, rows: StandingRow[], matches: Match[], byId: Map<string, Team>): ListData[] {
  if (structure.structure !== 'groups_knockout' && structure.structure !== 'league') return []
  const labels = new Map(TIEBREAKS)
  const footnote = `Level on points: ${structure.tiebreaks.map((k) => labels.get(k) ?? k).join(', ')}`
  return [...new Set(rows.map((r) => r.grp))].sort((x, y) => x - y).map((grp) => {
    const n = new Set(matches.filter((m) => m.status === 'finished' && m.kickOff && (grp === 0 ? m.stage === 'league' : m.stage === 'group' && m.round === group(grp))).map((m) => inZone(m.kickOff!).date)).size
    const list = rows.filter((r) => r.grp === grp).map((r) => {
      const t = byId.get(r.teamId)
      return { pos: r.pos, code: t?.code ?? '?', name: t?.name ?? '?', kit: t?.kitColour ?? null, p: r.p, w: r.w, d: r.d, l: r.l, gd: `${r.gd > 0 ? '+' : ''}${r.gd}`, pts: r.pts }
    })
    const name = group(grp)
    const after = `${name} table after match day ${n}`
    return {
      ...b, body: { kind: 'table', rows: list.map((r) => ({ pos: r.pos, code: r.code, kit: r.kit, p: r.p, w: r.w, d: r.d, l: r.l, gd: r.gd, pts: r.pts })), footnote }, title: `${name} table`, sub: `After match day ${n}`, foot: [], label: `${name} table Graphic`,
      file: `table-${slug(name)}.png`,
      caption: `${after}: ${list.map((r) => `${r.pos} ${r.name} ${r.pts} pts (${r.p}, ${r.w}, ${r.d}, ${r.l}, ${r.gd})`).join('; ')}.`,
    }
  })
}

/** Top scorers (Story 5.6): at most 10 rows, ranked by goals; Players level share a rank (1, 1, 3) and sort by name. null before any goal. */
export function scorersData(b: Brand, seasonNumber: number, scorers: Scorer[], names: Map<string, string>, byId: Map<string, Team>): ListData | null {
  const sorted = scorers.filter((s) => s.goals > 0).map((s) => ({ ...s, name: names.get(s.playerId) ?? '?' })).sort((x, y) => y.goals - x.goals || x.name.localeCompare(y.name))
  if (sorted.length === 0) return null
  const rows = sorted.slice(0, 10).map((s) => {
    const t = byId.get(s.teamId)
    return { rank: sorted.findIndex((x) => x.goals === s.goals) + 1, code: t?.code ?? '?', kit: t?.kitColour ?? null, name: s.name, goals: s.goals }
  })
  return {
    ...b, body: { kind: 'scorers', rows }, title: 'Top scorers', sub: `Season ${seasonNumber}`, foot: [], label: 'Top scorers Graphic', file: 'top-scorers.png',
    caption: `Top scorers, ${b.tournament} Season ${seasonNumber}: ${rows.map((r) => `${r.rank} ${r.name} (${r.code}) ${r.goals}`).join('; ')}.`,
  }
}

/** The result as the Graphic shows it: "2–1", with the shootout when the Match went to one. */
const resultOf = (m: Match) => `${m.hg ?? 0}–${m.ag ?? 0}${m.homePens != null && m.awayPens != null ? ` (${m.homePens}–${m.awayPens} pens)` : ''}`

/** The road to the final: one column per knockout round in Fixture order. Sides are the database's resolved Teams; a side not known yet shows its source label. null with no knockout Match. */
export function bracketData(b: Brand, seasonNumber: number, matches: Match[], byId: Map<string, Team>, sides: Map<string, { homeTeamId: string | null; awayTeamId: string | null }>): ListData | null {
  const ko = matches.filter((m) => m.stage === 'knockout').sort((x, y) => x.ord - y.ord)
  if (ko.length === 0) return null
  const rounds = [...new Set(ko.map((m) => m.round))].map((title) => ({
    title,
    ties: ko.filter((m) => m.round === title).map((m) => {
      const s = sides.get(m.id)
      const done = m.status === 'finished'
      const pen = (n: number | null | undefined) => (done && m.homePens != null && m.awayPens != null && n != null ? ` (${n})` : '')
      const home = sideOf(s ? s.homeTeamId : m.homeTeamId, m.homeSrc, byId)
      const away = sideOf(s ? s.awayTeamId : m.awayTeamId, m.awaySrc, byId)
      return { tie: { home, away, hs: done ? `${m.hg ?? 0}${pen(m.homePens)}` : '', as: done ? `${m.ag ?? 0}${pen(m.awayPens)}` : '' }, text: `${title}: ${home} ${done ? resultOf(m) : 'v'} ${away}` }
    }),
  }))
  return {
    ...b, body: { kind: 'bracket', rounds: rounds.map((r) => ({ title: r.title, ties: r.ties.map((t) => t.tie) })) }, title: 'Road to the final', sub: `Season ${seasonNumber}`, foot: [],
    label: 'Bracket Graphic', file: 'bracket.png',
    caption: `Road to the final, ${b.tournament} Season ${seasonNumber}: ${rounds.flatMap((r) => r.ties.map((t) => t.text)).join('; ')}.`,
  }
}

/**
 * Champions: the winner of the finished final (its score or shootout), or for a League the table leader. The caller passes the winner's Team id and the final
 * Match (null for a League). The winner is read from the finished result; no table or bracket is worked out here.
 */
export function championsData(b: Brand, seasonNumber: number, team: Team, final: Match | null): ListData {
  return {
    ...b, body: { kind: 'champions', code: team.code, kit: team.kitColour, name: team.name, score: final ? resultOf(final) : null }, title: 'Champions', sub: `Season ${seasonNumber}`, foot: [],
    label: 'Champions Graphic', file: 'champions.png', caption: `Champions, ${b.tournament} Season ${seasonNumber}: ${team.name}.`,
  }
}

/** The Team that won a finished Match: the higher score, else the shootout. null if level with no shootout. */
export function winnerOf(m: Match, s: { homeTeamId: string | null; awayTeamId: string | null } | undefined): string | null {
  const [h, a] = [s ? s.homeTeamId : m.homeTeamId, s ? s.awayTeamId : m.awayTeamId]
  const [x, y] = (m.hg ?? 0) === (m.ag ?? 0) ? [m.homePens, m.awayPens] : [m.hg, m.ag]
  return x == null || y == null || x === y ? null : x > y ? h : a
}
