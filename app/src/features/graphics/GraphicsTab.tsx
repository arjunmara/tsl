import { useEffect, useState, type ReactNode } from 'react'
import { drawComplete } from '../../domain/drawBoard'
import { bracketData, championsData, dayData, drawData, scorersData, seasonBrand, tableData, winnerOf, type Brand, type ListData } from '../../domain/listGraphics'
import { messages } from '../../domain/messages'
import { awardGraphics } from '../../domain/seasonAwards'
import { SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { useDraw } from '../home/Draw'
import { useMatches } from '../home/Fixtures'
import type { Head } from '../home/Home'
import { useStandings } from '../home/Standings'
import { useTeams } from '../home/Teams'
import { ListCard, PlayerCard, type CardState } from './GraphicCard'
import { PackList } from './Pack'
import { SeasonAwards, useSeasonAwards } from './SeasonAwards'

/** A card that can't be made yet says what it needs. */
const Needs = ({ title, text }: { title: string; text: string }) => (
  <section className="card graphic-card"><h2 className="body-strong">{title}</h2><p className="meta">{text}</p></section>
)

/**
 * The Graphics tab (Story 5.5): Official Draw, Fixtures (a card per day), Results (latest day first) and the tables, all made on this device from current
 * data, then the Post-match packs. Nothing is uploaded or written.
 */
export function GraphicsTab({ tournamentId, head: h }: { tournamentId: string; head: Head }) {
  const seasonId = h.season.id
  const { teams } = useTeams(tournamentId, seasonId)
  const { slots } = useDraw(tournamentId, seasonId)
  const { matches, published } = useMatches(tournamentId, seasonId)
  const standings = useStandings(seasonId, Array.isArray(matches) && matches.length > 0)
  const awards = useSeasonAwards(seasonId, Array.isArray(teams) ? teams : null)
  const [brand, setBrand] = useState<Brand | { code: 'offline' | 'unknown' } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [states, setStates] = useState<Record<string, CardState>>({})
  useEffect(() => {
    let live = true
    void seasonBrand(tournamentId, seasonId).then((b) => live && setBrand(b))
    return () => {
      live = false
    }
  }, [tournamentId, seasonId, attempt])

  const packs = <><h2 className="body-strong">Post-match packs</h2><PackList tournamentId={tournamentId} seasonId={seasonId} /></>
  if (brand && 'code' in brand) {
    return <><Problem text={brand.code === 'offline' ? messages.offline : messages.graphic_failed} /><SecondaryButton label="Try loading the Graphics again" onClick={() => (setBrand(null), setAttempt((n) => n + 1))} />{packs}</>
  }
  if (typeof matches === 'string') return <><Problem text={matches === 'offline' ? messages.offline : messages.fixtures_unknown} />{packs}</>
  if (!brand || !matches || !Array.isArray(teams) || !Array.isArray(slots)) {
    return <div aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>
  }

  const structure = h.season.structure
  const byId = new Map(teams.map((t) => [t.id, t]))
  const approved = teams.filter((t) => t.status === 'approved')
  const sides = new Map((standings.data?.sides ?? []).map((x) => [x.matchId, x]))
  const out: { id: string; made: boolean; node: (ok: boolean, set: (s: CardState) => void) => ReactNode }[] = []
  const awardCards: typeof out = []
  const nodes: ReactNode[] = []
  const card = (d: ListData) => out.push({ id: d.file, made: true, node: (canRender, onState) => <ListCard key={d.file} data={d} onRetry={() => setAttempt((n) => n + 1)} canRender={canRender} onState={onState} /> })
  const needs = (title: string, text: string) => out.push({ id: title, made: false, node: () => <Needs key={title} title={title} text={text} /> })

  if (structure.structure === 'groups_knockout') {
    if (drawComplete(approved, slots)) card(drawData(brand, h.season.number, structure, approved, slots))
    else needs('Official Draw Graphic', 'Available once the Draw is complete')
  }
  const fixtures = published ? dayData('fixtures', brand, matches, byId, sides) : []
  if (fixtures.length) fixtures.forEach(card)
  else needs('Fixtures Graphics', published ? 'No Matches left to play' : 'Available once fixtures are published')
  const results = dayData('results', brand, matches, byId, sides)
  if (results.length) results.forEach(card)
  else needs('Results Graphics', 'Available once a Match is finished')
  if (structure.structure === 'groups_knockout' || structure.structure === 'league') {
    if (standings.data) tableData(brand, structure, standings.data.rows, matches, byId).forEach(card)
    else if (matches.length === 0) needs('Table Graphics', 'Available once fixtures are published')
    else if (standings.failed) {
      nodes.push(<div key="t"><Problem text={standings.failed === 'offline' ? messages.offline : messages.fixtures_unknown} /><SecondaryButton label="Try loading the tables again" onClick={standings.reload} /></div>)
    }
    else nodes.push(<div key="t" aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>)
  }

  // Top scorers, the bracket and champions (Story 5.6).
  if (awards.data) {
    const names = new Map(awards.data.players.map((p) => [p.playerId, p.name]))
    const top = scorersData(brand, h.season.number, awards.data.scorers, names, byId)
    if (top) card(top)
    else needs('Top scorers Graphic', 'Available once a goal is scored')
  } else if (awards.failed) {
    nodes.push(<div key="a"><Problem text={awards.failed === 'offline' ? messages.offline : messages.awards_unknown} /><SecondaryButton label="Try loading the Season awards again" onClick={awards.reload} /></div>)
  } else nodes.push(<div key="a" aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>)
  const loadingSides = matches.length > 0 && !standings.data && !standings.failed
  if (!published) {
    if (matches.some((m) => m.stage === 'knockout')) needs('Bracket Graphic', 'Available once fixtures are published')
    needs('Champions Graphic', 'Available once fixtures are published')
  } else if (loadingSides) {
    nodes.push(<div key="b" aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>)
  } else {
    const bracket = bracketData(brand, h.season.number, matches, byId, sides)
    if (bracket) card(bracket)
    const final = matches.filter((m) => m.stage === 'knockout' && m.round === 'Final').sort((x, y) => y.ord - x.ord)[0]
    const champion = structure.structure === 'league'
      ? (matches.some((m) => m.stage === 'league') && matches.every((m) => m.stage !== 'league' || m.status === 'finished') ? standings.data?.rows.find((r) => r.grp === 0 && r.pos === 1)?.teamId : undefined)
      : final?.status === 'finished' ? winnerOf(final, sides.get(final.id)) : undefined
    const champTeam = champion ? byId.get(champion) : undefined
    if (champTeam) card(championsData(brand, h.season.number, champTeam, structure.structure === 'league' ? null : final ?? null))
    else needs('Champions Graphic', structure.structure === 'league' ? 'Available once every league Match is played' : 'Available once the final is played')
  }
  const seasonAwards = awards.data && (h.season.status === 'started' || h.season.status === 'finished') ? awardGraphics(brand, h.season.number, awards.data, byId, awards.cutouts) : []
  seasonAwards.forEach((d) => awardCards.push({ id: d.file, made: true, node: (canRender, onState) => <PlayerCard key={d.file} data={d} onRetry={() => setAttempt((n) => n + 1)} canRender={canRender} onState={onState} /> }))

  // Cards are made one at a time in this order: one waits until each card before it has a PNG or a failure.
  const set = (id: string) => (s: CardState) => setStates((x) => (x[id] === s ? x : { ...x, [id]: s }))
  const rendering = [...out, ...awardCards].filter((c) => c.made).map((c) => c.id)
  const node = (c: (typeof out)[number]) => c.node(rendering.slice(0, Math.max(rendering.indexOf(c.id), 0)).every((id) => !!states[id]), set(c.id))
  return (
    <>
      <div className="graphics-grid">
        {out.map(node)}
        {nodes}
      </div>
      {awards.data && (h.season.status === 'started' || h.season.status === 'finished') && (
        <>
          <h2 className="body-strong">Season awards</h2>
          <SeasonAwards seasonId={seasonId} data={awards.data} byId={byId} onSaved={awards.reload} />
          <div className="graphics-grid">{awardCards.map(node)}</div>
        </>
      )}
      {packs}
    </>
  )
}
