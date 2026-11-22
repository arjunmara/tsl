import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { combinedCaption, emptyReason, graphicFile, packData, type Kind, type Pack as PackT } from '../../domain/graphics'
import { matchMeta, seasonMatches, type Match } from '../../domain/matches'
import { messages } from '../../domain/messages'
import { backIcon, IconButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { sideText, useMatches } from '../home/Fixtures'
import { readHead } from '../home/Home'
import { Unavailable, UUID } from '../setup/Setup'
import { useTeams } from '../home/Teams'
import { canShareFiles, PlayerCard, ResultCard, saveBlob, type CardState } from './GraphicCard'

const KINDS: Kind[] = ['goal', 'card', 'missed', 'mom', 'fair']

/** /t/:tournamentId/m/:matchId/pack: the Post-match pack of a finished Match (Story 5.4), read fresh at every opening. Nothing is uploaded or written. */
export function PackPage() {
  const { tournamentId = '', matchId = '' } = useParams()
  if (!UUID.test(tournamentId) || !UUID.test(matchId)) return <Unavailable />
  return <Load key={matchId} tournamentId={tournamentId} matchId={matchId} />
}

function Load({ tournamentId, matchId }: { tournamentId: string; matchId: string }) {
  const navigate = useNavigate()
  const [found, setFound] = useState<{ seasonId: string; match: Match } | 'missing' | 'offline' | 'unknown' | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    void (async () => {
      const h = await readHead(tournamentId)
      if (!live) return
      if (typeof h === 'string') return setFound(h)
      const r = await seasonMatches(h.season.id)
      if (!live) return
      const match = 'code' in r ? null : r.matches.find((m) => m.id === matchId)
      setFound('code' in r ? r.code : match ? { seasonId: h.season.id, match } : 'missing')
    })()
    return () => {
      live = false
    }
  }, [tournamentId, matchId, attempt])
  if (found === 'missing') return <Unavailable />
  return (
    <main className="home">
      <header className="home-bar">
        <IconButton label="Back to the Match" onClick={() => navigate(`/t/${tournamentId}/m/${matchId}`)}>{backIcon}</IconButton>
        <h1 className="title home-title">Post-match pack</h1>
      </header>
      <div className="home-panel">
        {found === null ? (
          <div aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>
        ) : typeof found === 'string' ? (
          <>
            <Problem text={found === 'offline' ? messages.offline : messages.fixtures_unknown} />
            <SecondaryButton label="Try loading the pack again" onClick={() => (setFound(null), setAttempt((n) => n + 1))} />
          </>
        ) : found.match.status !== 'finished' ? (
          <>
            <p className="body">{messages.pack_not_finished}</p>
            <SecondaryButton label="Check the pack again" onClick={() => (setFound(null), setAttempt((n) => n + 1))} />
          </>
        ) : <PackBody tournamentId={tournamentId} seasonId={found.seasonId} match={found.match} />}
      </div>
    </main>
  )
}

function PackBody({ tournamentId, seasonId, match }: { tournamentId: string; seasonId: string; match: Match }) {
  const [pack, setPack] = useState<PackT | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [gen, setGen] = useState(0)
  const sharing = useRef(false)
  const [states, setStates] = useState<CardState[]>([])
  const [notice, setNotice] = useState('')
  const [words, setWords] = useState('')
  const shown = useRef('')
  useEffect(() => {
    let live = true
    void packData(tournamentId, seasonId, match).then((r) => {
      if (!live) return
      if ('code' in r) return setProblem(r.code === 'offline' ? messages.offline : messages.graphic_failed)
      setProblem(null)
      // Signing makes a new URL every read: only changed content (the cut-out aside) needs new PNGs.
      const k = JSON.stringify({ ...r, players: r.players.map((d) => ({ ...d, base: 0, cutout: !!d.cutout })), result: r.result })
      if (k === shown.current) return
      shown.current = k
      // New content: forget the PNGs of the old one and make every card afresh.
      setStates([])
      setGen((n) => n + 1)
      setPack(r)
    })
    return () => {
      live = false
    }
  }, [tournamentId, seasonId, match, attempt])

  const again = () => setAttempt((n) => n + 1)
  const set = (i: number) => (s: CardState) => setStates((x) => (x[i] === s ? x : Object.assign([...x], { [i]: s })))
  // Cards are made one at a time in pack order: a card waits until each one before it has a PNG or a failure.
  const canRender = (i: number) => Array.from({ length: i }, (_, j) => states[j]).every((s) => !!s)

  const total = pack ? 1 + pack.players.length : 0
  const pngs = states.slice(0, total).filter((s): s is Blob => s instanceof Blob)
  const allReady = !!pack && pngs.length === total

  async function shareAll() {
    if (!pack || !allReady || sharing.current) return
    sharing.current = true
    try {
      await send()
    } finally {
      sharing.current = false
    }
  }

  async function send() {
    if (!pack) return
    setNotice('')
    setWords('')
    const names = [graphicFile(pack.result), ...pack.players.map((p) => p.file)]
    const files = pngs.map((b, i) => new File([b], names[i]!, { type: 'image/png' }))
    const text = combinedCaption(pack)
    if (canShareFiles(files)) {
      try {
        await navigator.share({ files, text })
        return
      } catch (e) {
        // Cancelling the share sheet is not a problem.
        if (e instanceof DOMException && e.name === 'AbortError') return
      }
    }
    pngs.forEach((b, i) => saveBlob(b, names[i]!))
    try {
      await navigator.clipboard.writeText(text)
      setNotice(messages.images_saved)
    } catch {
      setNotice(messages.images_saved_no_copy)
      setWords(text)
    }
  }

  if (!pack) {
    return problem ? (
      <>
        <Problem text={problem} />
        <SecondaryButton label="Try loading the pack again" onClick={again} />
      </>
    ) : <div aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>
  }
  return (
    <>
      <p className="meta">{matchMeta(match)}</p>
      {allReady
        ? <PrimaryButton label="Share all Graphics" onClick={() => void shareAll()} />
        : <PrimaryButton label="Share all Graphics" disabled disabledReason="Available once every Graphic is made." />}
      <p role="status" aria-live="polite" className="body-strong">{notice}</p>
      {words && <p className="body graphic-caption">{words}</p>}
      <Problem text={problem} />
      <ResultCard key={`${gen}-0`} data={pack.result} onRetry={again} canRender={canRender(0)} onState={set(0)} />
      {KINDS.map((k) => {
        const cards = pack.players.map((d, i) => ({ d, i: i + 1 })).filter((x) => x.d.kind === k)
        return cards.length === 0
          ? <p key={k} className="meta">{emptyReason[k]}</p>
          : cards.map(({ d, i }) => <PlayerCard key={`${gen}-${i}`} data={d} onRetry={again} canRender={canRender(i)} onState={set(i)} />)
      })}
    </>
  )
}

/** "Open the post-match pack" for a finished Match. */
export function PackLink({ tournamentId, matchId }: { tournamentId: string; matchId: string }) {
  return <p className="body"><Link to={`/t/${tournamentId}/m/${matchId}/pack`}>Open the post-match pack</Link></p>
}

/** The Graphics tab: one entry per finished Match of the Season, newest first. */
export function PackList({ tournamentId, seasonId }: { tournamentId: string; seasonId: string }) {
  const { matches } = useMatches(tournamentId, seasonId)
  const { teams } = useTeams(tournamentId, seasonId)
  if (matches === null || teams === null) return <div aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>
  if (typeof matches === 'string') return <Problem text={matches === 'offline' ? messages.offline : messages.fixtures_unknown} />
  const byId = new Map(Array.isArray(teams) ? teams.map((t) => [t.id, t]) : [])
  const done = matches.filter((m) => m.status === 'finished').sort((a, b) => (b.kickOff ?? '').localeCompare(a.kickOff ?? '') || b.ord - a.ord)
  if (done.length === 0) return <p className="body">No finished Matches yet</p>
  return (
    <ul className="cards">
      {done.map((m) => (
        <li key={m.id}>
          <Link className="card match-card" to={`/t/${tournamentId}/m/${m.id}/pack`}>
            {`${sideText(m.homeTeamId, m.homeSrc, byId)} ${m.hg ?? 0}–${m.ag ?? 0} ${sideText(m.awayTeamId, m.awaySrc, byId)} · ${m.round}`}
          </Link>
        </li>
      ))}
    </ul>
  )
}
