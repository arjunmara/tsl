import { useEffect, useState, type ReactNode } from 'react'
import { drawComplete } from '../../domain/drawBoard'
import { dayData, drawData, seasonBrand, tableData, type Brand, type ListData } from '../../domain/listGraphics'
import { messages } from '../../domain/messages'
import { SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { useDraw } from '../home/Draw'
import { useMatches } from '../home/Fixtures'
import type { Head } from '../home/Home'
import { useStandings } from '../home/Standings'
import { useTeams } from '../home/Teams'
import { ListCard, type CardState } from './GraphicCard'
import { PackList } from './Pack'

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

  // Cards are made one at a time in this order: one waits until each card before it has a PNG or a failure.
  const set = (id: string) => (s: CardState) => setStates((x) => (x[id] === s ? x : { ...x, [id]: s }))
  const rendering = out.filter((c) => c.made).map((c) => c.id)
  return (
    <>
      <div className="graphics-grid">
        {out.map((c) => c.node(rendering.slice(0, Math.max(rendering.indexOf(c.id), 0)).every((id) => !!states[id]), set(c.id)))}
        {nodes}
      </div>
      {packs}
    </>
  )
}
