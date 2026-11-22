import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { send, useOutbox } from '../../domain/commands'
import { packData, type Pack, type PlayerData, type ResultData } from '../../domain/graphics'
import { dayData, seasonBrand, tableData, type Brand, type ListData } from '../../domain/listGraphics'
import { messages } from '../../domain/messages'
import { logoUrl, tournamentSetup, TEMPLATES, type Template, type TournamentSetup } from '../../domain/tournaments'
import { backIcon, IconButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { useMatches } from '../home/Fixtures'
import { useStandings } from '../home/Standings'
import { useTeams } from '../home/Teams'
import { SaveStatusBar } from '../save-status/SaveStatusBar'
import { Unavailable, UUID } from '../setup/Setup'
import { token } from '../setup/brand'
import { List } from './List'
import { Player } from './Player'
import { Result } from './templates'
import './graphics.css'

const NAMES: Record<Template, string> = { classic: 'Classic', split: 'Split', minimal: 'Minimal', gradient: 'Gradient', spotlight: 'Spotlight' }
const KINDS = [['result', 'Result'], ['goal', 'Goal'], ['fixtures', 'Fixtures'], ['table', 'Table']] as const
type Kind = (typeof KINDS)[number][0]
const W = 1080

/** The preview's data for a kind: real when the Tournament has it, else sample Teams "Red Tigers RTM" and "Blue Eagles BLE" (no date, so no BS/AD line is faked). */
function sampleResult(b: Brand): ResultData {
  const side = (code: string, name: string, kit: string, score: number, goals: ResultData['home']['goals']) => ({ code, name, kit, score, goals })
  return {
    ...b, round: 'Group A', pens: null, date: '', home: side('RTM', 'Red Tigers', token('--live'), 3, [{ who: 'Sample Player', minute: 12 }, { who: 'Sample Player', minute: 31 }]),
    away: side('BLE', 'Blue Eagles', token('--surface-dark'), 1, [{ who: 'Sample Player', minute: 20 }]), sponsors: b.sponsors,
  }
}
const sampleGoal = (b: Brand): PlayerData => ({
  kind: 'goal', base: sampleResult(b), word: 'GOAL', label: 'Goal', name: 'Sample Player', team: 'Red Tigers', minute: 12, assist: null, cutout: null, title: '', caption: '', file: '',
})
const sampleList = (b: Brand, kind: 'fixtures' | 'table'): ListData => ({
  ...b, title: kind === 'table' ? 'Group A table' : 'Fixtures', sub: 'Sample', foot: b.venue ? [b.venue] : [], caption: '', label: '', file: '',
  body: kind === 'table'
    ? { kind: 'table', footnote: 'Level on points: head to head', rows: [
      { pos: 1, code: 'RTM', kit: token('--live'), p: 2, w: 2, d: 0, l: 0, gd: '+3', pts: 6 }, { pos: 2, code: 'BLE', kit: token('--surface-dark'), p: 2, w: 0, d: 0, l: 2, gd: '-3', pts: 0 }] }
    : { kind: 'matches', rows: [{ time: '10:00', home: 'RTM', away: 'BLE', round: 'Group A', score: null, pens: null }, { time: '12:00', home: 'BLE', away: 'RTM', round: 'Group A', score: null, pens: null }] },
})

/** A real Graphic component scaled down to its 4:5 box: the same markup as the PNG, "Made with" included. */
function Scaled({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.3)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / W)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return <div ref={box} className="graphic-thumb"><div className="graphic-stage" style={{ transform: `scale(${scale})` }}>{children}</div></div>
}

/** /t/:tournamentId/settings/graphics: Choose a graphics template (Story 5.7). */
export function TemplatePicker() {
  const { tournamentId = '' } = useParams()
  if (!UUID.test(tournamentId)) return <><SaveStatusBar /><Unavailable /></>
  return <Load key={tournamentId} tournamentId={tournamentId} />
}

function Load({ tournamentId }: { tournamentId: string }) {
  const navigate = useNavigate()
  const [found, setFound] = useState<TournamentSetup | 'missing' | 'offline' | 'unknown' | null>(null)
  const [chosen, setChosen] = useState<Template | null>(null)
  const [attempt, setAttempt] = useState(0)
  const outbox = useOutbox().entries
  const pending = outbox.length
  // A load that starts while a set_template is still queued must not clear `chosen`: the server may not have it yet. The load after the entry leaves does.
  const held = outbox.some((e) => e.name === 'set_template')
  useEffect(() => {
    let live = true
    void tournamentSetup(tournamentId).then((r) => {
      if (!live) return
      if ('code' in r) return setFound((f) => (typeof f === 'object' && f ? f : r.code))
      setFound(r.tournament?.season ? r.tournament : 'missing')
      if (!held) setChosen(null)
    })
    return () => {
      live = false
    }
  }, [tournamentId, attempt, pending, held])
  const bar = (
    <header className="home-bar">
      <IconButton label="Back to settings" onClick={() => navigate(`/t/${tournamentId}/settings`)}>{backIcon}</IconButton>
      <h1 className="title home-title">Choose a graphics template</h1>
      <SaveStatusBar />
    </header>
  )
  if (found === 'missing') return <><SaveStatusBar /><Unavailable /></>
  if (typeof found === 'string') {
    return <main className="home">{bar}<Problem text={found === 'offline' ? messages.offline : messages.graphic_failed} /><SecondaryButton label="Try loading the templates again" onClick={() => (setFound(null), setAttempt((n) => n + 1))} /></main>
  }
  if (!found) return <main className="home">{bar}<div aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div></main>
  return <main className="home">{bar}<Picker tournamentId={tournamentId} t={found} chosen={chosen} onChoose={setChosen} /></main>
}

function Picker({ tournamentId, t, chosen, onChoose }: { tournamentId: string; t: TournamentSetup; chosen: Template | null; onChoose: (x: Template) => void }) {
  const season = t.season!
  const { entries } = useOutbox()
  const { teams } = useTeams(tournamentId, season.id)
  const { matches, published } = useMatches(tournamentId, season.id)
  const standings = useStandings(season.id, Array.isArray(matches) && matches.length > 0)
  const [kind, setKind] = useState<Kind>('result')
  const [brand, setBrand] = useState<Brand | null>(null)
  const [pack, setPack] = useState<Pack | null>(null)
  const row = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    void seasonBrand(tournamentId, season.id).then((b) => live && setBrand('code' in b
      ? { template: t.template, tournament: t.name, logo: t.logoPath ? logoUrl(t.logoPath) : null, primary: t.brandPrimary, secondary: t.brandSecondary, venue: season.answers.venue, sponsors: [] } : b))
    return () => {
      live = false
    }
  }, [tournamentId, season, t])

  // The latest finished Match, read as the Post-match pack is (the Player Graphic only gets a cut-out the consent gate allows).
  const finished = useMemo(() => (Array.isArray(matches) ? matches.filter((m) => m.status === 'finished')
    .sort((a, b) => (b.kickOff ?? '').localeCompare(a.kickOff ?? '') || b.ord - a.ord)[0] : undefined), [matches])
  useEffect(() => {
    if (!finished) return
    let live = true
    void packData(tournamentId, season.id, finished).then((p) => live && setPack('code' in p ? null : p))
    return () => {
      live = false
    }
  }, [tournamentId, season.id, finished])

  const queued = entries.filter((e) => e.name === 'set_template' && e.args.tournament_id === tournamentId).at(-1)?.args.template as Template | undefined
  const inUse: Template = queued ?? chosen ?? t.template

  const previews = useMemo(() => {
    if (!brand) return null
    const byId = new Map((Array.isArray(teams) ? teams : []).map((x) => [x.id, x]))
    const sides = new Map((standings.data?.sides ?? []).map((x) => [x.matchId, x]))
    const day = published && Array.isArray(matches) ? dayData('fixtures', brand, matches, byId, sides)[0] : undefined
    const table = Array.isArray(matches) && standings.data ? tableData(brand, t.season!.structure, standings.data.rows, matches, byId)[0] : undefined
    return {
      result: (finished && pack?.result) || sampleResult(brand), goal: (finished && pack?.players.find((p) => p.kind === 'goal')) || sampleGoal(brand),
      fixtures: day ?? sampleList(brand, 'fixtures'), table: table ?? sampleList(brand, 'table'),
    }
  }, [brand, pack, finished, teams, matches, published, standings.data, t.season])

  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const slides = () => [...(row.current?.querySelectorAll<HTMLElement>('.picker-slide') ?? [])]
  function show(i: number) {
    const el = slides()[i]
    if (!el) return
    el.focus({ preventScroll: true })
    el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', inline: 'center', block: 'nearest' })
  }
  function keys(e: KeyboardEvent) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    const at = slides().findIndex((s) => s.contains(document.activeElement))
    if (at < 0 || e.target instanceof HTMLButtonElement) return
    e.preventDefault()
    show(Math.min(Math.max(at + step, 0), TEMPLATES.length - 1))
  }
  const use = (x: Template) => {
    onChoose(x)
    void send('set_template', { tournament_id: tournamentId, template: x }, { scope: tournamentId, versionOf: tournamentId })
  }

  const draw = (x: Template) => {
    if (!previews) return <div className="graphic-thumb skeleton-card" aria-busy="true" />
    if (kind === 'result') return <Scaled><Result data={{ ...previews.result, template: x }} /></Scaled>
    if (kind === 'goal') return <Scaled><Player data={{ ...previews.goal, base: { ...previews.goal.base, template: x } }} /></Scaled>
    return <Scaled><List data={{ ...previews[kind], template: x }} /></Scaled>
  }

  return (
    <>
      <div className="tab-bar picker-kinds" role="group" aria-label="Graphic to preview">
        {KINDS.map(([k, label]) => (
          <button key={k} type="button" className="tab body-strong" aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>
        ))}
      </div>
      <nav aria-label="Templates">
        <ul className="picker-names">
          {TEMPLATES.map((x, i) => <li key={x}><SecondaryButton label={`Show ${NAMES[x]} template`} onClick={() => show(i)} /></li>)}
        </ul>
      </nav>
      <div ref={row} className="picker-row" role="group" aria-label="Template previews. Swipe, or use the left and right arrow keys." onKeyDown={keys}>
        {TEMPLATES.map((x) => (
          <section key={x} className="card picker-slide" tabIndex={0} aria-label={`${NAMES[x]} template`} data-template={x}>
            <h2 className="body-strong">{NAMES[x]}</h2>
            {draw(x)}
            {inUse === x
              ? <p className="label ui-pill ui-pill-done picker-inuse"><span aria-hidden="true">✓ </span>In use</p>
              : <PrimaryButton label="Use this template" onClick={() => use(x)} />}
          </section>
        ))}
      </div>
    </>
  )
}
