import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { forgetRefused, queuedFor, runCommand, send, useOutbox } from '../../domain/commands'
import { suggestFixtures } from '../../domain/fixtures'
import { formatDate, inZone } from '../../domain/format'
import { matchMeta, overlayMatches, seasonMatches, type Match } from '../../domain/matches'
import { messageFor, messages } from '../../domain/messages'
import type { Team } from '../../domain/teams'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { StatusPill } from '../../ui/StatusPill'
import { Problem } from '../auth/Screen'
import { useOnline } from '../app/online'
import { Draw, useDraw } from './Draw'
import type { Head } from './Home'
import { Standings, useStandings } from './Standings'
import { useTeams } from './Teams'

/** The Season's Fixtures in order, with this user's pending swaps and kick-offs laid over; reloads when the signal returns. */
export function useMatches(tournamentId: string, seasonId: string) {
  const [matches, setMatches] = useState<Match[] | 'offline' | 'unknown' | null>(null)
  const [published, setPublished] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const pending = useOutbox().entries.length
  useEffect(() => {
    const again = () => setAttempt((n) => n + 1)
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [])
  useEffect(() => {
    let live = true
    void (async () => {
      const r = await seasonMatches(seasonId)
      const queued = await queuedFor(tournamentId)
      if (!live) return
      setMatches('code' in r ? r.code : overlayMatches(r.matches, queued, seasonId))
      if (!('code' in r)) setPublished(r.published)
    })()
    return () => {
      live = false
    }
  }, [tournamentId, seasonId, attempt, pending])
  return { matches, published, reload: () => setAttempt((n) => n + 1), retry: () => (setMatches(null), setAttempt((n) => n + 1)) }
}

/** A side as the card shows it: the Team's code ("RTM (Bye)" after a bye), or the source label while the Team is not known. */
export const sideText = (teamId: string | null, src: string | null, byId: Map<string, Team>) =>
  teamId ? `${byId.get(teamId)?.code ?? '?'}${src === 'Bye' ? ' (Bye)' : ''}` : src ?? '?'

/** "Kick-off not set", or the BS and AD day with the time. */
export function kickOffText(kickOff: string | null) {
  if (!kickOff) return 'Kick-off not set'
  const z = inZone(kickOff)
  return `${formatDate(z.date)} · ${z.time}`
}

/**
 * The Matches tab from the Draw on (Stories 3.1, 3.2): the "Suggest fixtures" action, the Match cards, and the Draw board
 * below. The phone works out the pairings and sends the whole list in one command that needs a signal.
 */
export function Fixtures({ tournamentId, head: h, fallback }: { tournamentId: string; head: Head; fallback: string }) {
  const navigate = useNavigate()
  const { teams } = useTeams(tournamentId, h.season.id)
  const { slots } = useDraw(tournamentId, h.season.id)
  const { matches, published, reload, retry } = useMatches(tournamentId, h.season.id)
  const standings = useStandings(h.season.id, Array.isArray(matches) && matches.length > 0)
  const online = useOnline()
  const pending = useOutbox().entries.filter((e) => e.scope === tournamentId && e.state === 'pending').length
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  const inflight = useRef(false) // a swap sent, its result not on the cards yet: the versions shown are stale
  const moved = useRef<{ id: string; dir: 'up' | 'down'; idx: number } | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor))
  const league = h.season.structure.structure === 'league'
  const editable = h.season.status === 'registration'

  // After a Move up / Move down the card sits somewhere else in the list; put focus back on its button.
  useEffect(() => {
    inflight.current = false
    const m = moved.current
    if (!m || !Array.isArray(matches) || matches.findIndex((x) => x.id === m.id) === m.idx) return
    moved.current = null
    const card = list.current?.querySelector(`[data-card="${m.id}"]`)
    ;(card?.querySelector<HTMLElement>(`[data-dir="${m.dir}"]`) ?? card?.querySelector<HTMLElement>('[data-dir]'))?.focus()
  }, [matches])

  if (!Array.isArray(matches)) {
    return matches === null
      ? <div aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>
      : <>
        <Problem text={matches === 'offline' ? messages.offline : messages.fixtures_unknown} />
        <SecondaryButton label="Try loading the Fixtures again" onClick={retry} />
      </>
  }
  const approved = Array.isArray(teams) ? teams.filter((t) => t.status === 'approved') : []
  const approvedIds = new Set(approved.map((t) => t.id))
  const byId = new Map(Array.isArray(teams) ? teams.map((t) => [t.id, t]) : [])
  const placed = new Set(Array.isArray(slots) ? slots.map((s) => s.teamId) : [])
  const ready = league ? approved.length >= 2 : approved.length >= 2 && approved.every((t) => placed.has(t.id))

  async function suggest(replace: boolean) {
    if (busy) return
    setBusy(true)
    setNotice('')
    setProblem(null)
    const fixtures = suggestFixtures(h.season.structure, approved, (Array.isArray(slots) ? slots : []).filter((x) => approvedIds.has(x.teamId)))
    const r = await runCommand('suggest_fixtures', { season_id: h.season.id, fixtures, replace })
    if (r.ok) setNotice('Fixtures suggested')
    else setProblem(messageFor(r.code))
    setBusy(false)
    reload()
  }

  /** Sends one edit through the outbox. A conflict goes to the hand-back sheet; any other refusal is said here. */
  async function edit(name: string, args: Record<string, unknown>) {
    setProblem(null)
    const r = await send(name, { season_id: h.season.id, ...args }, { scope: tournamentId })
    if (!r.ok && r.code !== 'queued' && r.code !== 'version_conflict') {
      if (r.commandId) void forgetRefused(r.commandId)
      setProblem(messageFor(r.code))
    }
    if (!r.ok && r.code !== 'queued') {
      moved.current = null
      inflight.current = false
    }
  }
  const swap = (a: Match, b: Match) => inflight.current ? undefined : (inflight.current = true, edit('swap_fixtures', { match_a: a.id, version_a: a.version, match_b: b.id, version_b: b.version }))
  const move = (i: number, dir: 'up' | 'down') => {
    if (inflight.current) return
    moved.current = { id: matches[i]!.id, dir, idx: i }
    void swap(matches[i]!, matches[dir === 'up' ? i - 1 : i + 1]!)
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const a = matches.find((m) => m.id === active.id)
    const b = matches.find((m) => m.id === over?.id)
    if (a && b && a !== b) void swap(a, b)
  }
  async function publish() {
    if (busy) return
    setBusy(true)
    setNotice('')
    setProblem(null)
    const r = await runCommand('publish_fixtures', { season_id: h.season.id })
    if (r.ok) setNotice('Fixtures published')
    else setProblem(messageFor(r.code))
    setBusy(false)
    reload()
  }

  const waiting = pending > 0
  const missing = matches.filter((m) => !m.kickOff).length
  const action = !editable || !h.season.structure.structure ? null : matches.length ? (
    <>
      {arranging ? <PrimaryButton label="Finish arranging" onClick={() => (moved.current = null, setArranging(false))} />
        : <SecondaryButton label="Arrange fixtures" onClick={() => setArranging(true)} />}
      {!published && (!online ? <><p className="meta">Suggesting fixtures needs a signal.</p><p className="meta">Publishing fixtures needs a signal.</p></> : (
        <>
          <SecondaryButton label="Suggest fixtures again" onClick={() => setConfirm(true)} />
          {waiting ? <PrimaryButton label="Publish fixtures" disabled disabledReason="Waiting for your changes to send." />
            : missing ? <PrimaryButton label="Publish fixtures" disabled disabledReason={`${missing} ${missing === 1 ? 'Match has' : 'Matches have'} no kick-off time.`} />
            : <PrimaryButton label="Publish fixtures" onClick={() => void publish()} />}
        </>
      ))}
    </>
  ) : !online ? (
    <p className="meta">Suggesting fixtures needs a signal.</p>
  ) : ready ? (
    <PrimaryButton label="Suggest fixtures" onClick={() => void suggest(false)} />
  ) : (
    <PrimaryButton label="Suggest fixtures" disabled disabledReason={league ? 'Approve at least two Teams first.' : 'Record the whole draw first.'} />
  )

  const sides = new Map((standings.data?.sides ?? []).map((x) => [x.matchId, x]))
  const card = (m: Match, i: number) => {
    const s = sides.get(m.id)
    const home = sideText(s ? s.homeTeamId : m.homeTeamId, m.homeSrc, byId)
    const away = sideText(s ? s.awayTeamId : m.awayTeamId, m.awaySrc, byId)
    const body = (
      <>
        <span className="meta">{matchMeta(m)}</span>
        <span className="match-sides">
          <span className="match-side">{home}</span>
          <span className="meta" aria-label="versus">v</span>
          <span className="match-side">{away}</span>
        </span>
        <span className="meta">{kickOffText(m.kickOff)}</span>
      </>
    )
    if (!arranging) return (
      <li key={m.id}>
        <button type="button" className="card match-card" onClick={() => navigate(`/t/${tournamentId}/m/${m.id}`)}>
          {body}
          <svg className="match-chevron" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
        </button>
      </li>
    )
    return (
      <ArrangeCard key={m.id} id={m.id} name={`${home} v ${away}`} onUp={i > 0 ? () => move(i, 'up') : undefined}
        onDown={i < matches.length - 1 ? () => move(i, 'down') : undefined}>
        {body}
      </ArrangeCard>
    )
  }
  const rounds = published && !arranging ? [...new Set(matches.map((m) => m.round))] : null

  return (
    <div className="fixtures">
      {published && <StatusPill state="done" label="Published" />}
      {action}
      <p role="status" aria-live="polite" className="body-strong">{notice}</p>
      <Problem text={problem} />
      {matches.length > 0 && (rounds ? rounds.map((r) => (
        <section key={r}>
          <h3 className="body-strong">{r}</h3>
          <ul className="cards">{matches.map((m, i) => m.round === r && card(m, i))}</ul>
        </section>
      )) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <ul className="cards" ref={list}>{matches.map(card)}</ul>
        </DndContext>
      ))}
      {matches.length > 0 && !arranging && standings.data && (
        <Standings seasonId={h.season.id} rows={standings.data.rows} matches={matches} sides={sides} byId={byId}
          canRecord={h.season.status === 'started'} reload={standings.reload} />
      )}
      {league ? (!matches.length && !editable && <p className="body">{fallback}</p>)
        : ((editable && !published) || !matches.length) && <Draw tournamentId={tournamentId} head={h} fallback={fallback} />}
      {league && !matches.length && editable && !ready && <p className="body">{fallback}</p>}
      <ConfirmSheet open={confirm} title={`Replace the ${matches.length} suggested Fixtures?`} before={`${matches.length} suggested Fixtures`}
        after="a new suggestion" actionLabel="Replace the Fixtures" destructive onConfirm={() => void suggest(true)} onClose={() => setConfirm(false)} />
    </div>
  )
}

/* eslint-disable react-hooks/refs -- dnd-kit's setters and props, not React refs read in render */
/** One Match card while arranging: a drag handle, the card (also where a drag can land), and Move up / Move down at 48px, 8px apart. */
function ArrangeCard({ id, name, onUp, onDown, children }: { id: string; name: string; onUp?: () => void; onDown?: () => void; children: React.ReactNode }) {
  const drag = useDraggable({ id })
  const drop = useDroppable({ id })
  const t = drag.transform
  return (
    <li ref={(n) => (drag.setNodeRef(n), drop.setNodeRef(n))} data-card={id}
      className={`card match-arrange${drag.isDragging ? ' is-dragging' : ''}${drop.isOver && !drag.isDragging ? ' is-over' : ''}`}
      style={t ? { transform: `translate(${t.x}px, ${t.y}px)` } : undefined}>
      <button type="button" ref={drag.setActivatorNodeRef} className="match-handle" aria-label={`Drag ${name} to another place`}
        {...drag.listeners} {...drag.attributes}>
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
          <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
          <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
        </svg>
      </button>
      <div className="match-arrange-body">{children}</div>
      <div className="match-moves">
        {onUp && <button type="button" data-dir="up" className="ui-button ui-secondary" aria-label={`Move up ${name}`} onClick={onUp}>Move up</button>}
        {onDown && <button type="button" data-dir="down" className="ui-button ui-secondary" aria-label={`Move down ${name}`} onClick={onDown}>Move down</button>}
      </div>
    </li>
  )
}
/* eslint-enable react-hooks/refs */
