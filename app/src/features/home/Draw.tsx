import { useEffect, useState, type DragEvent } from 'react'
import { forgetRefused, queuedFor, send, useOutbox } from '../../domain/commands'
import { seasonDraw, type Slot } from '../../domain/draw'
import { drawColumns, overlayDraw } from '../../domain/drawBoard'
import { messageFor, messages } from '../../domain/messages'
import type { Team } from '../../domain/teams'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { KitDot } from '../../ui/KitDot'
import { Problem } from '../auth/Screen'
import { useOnline } from '../app/online'
import type { Head } from './Home'
import { useTeams } from './Teams'

/** The Season's placed Teams with this user's pending placements laid over; reloads as they send and when the signal returns. */
export function useDraw(tournamentId: string, seasonId: string) {
  const [slots, setSlots] = useState<Slot[] | 'offline' | 'unknown' | null>(null)
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
      const r = await seasonDraw(seasonId)
      const queued = await queuedFor(tournamentId)
      if (live) setSlots('code' in r ? r.code : overlayDraw(r.slots, queued, seasonId))
    })()
    return () => {
      live = false
    }
  }, [tournamentId, seasonId, attempt, pending])
  return { slots, reload: () => setAttempt((n) => n + 1) }
}

/**
 * The Matches tab's chit Draw (Story 3.1): approved Teams as chips, the Structure's slots as dashed boxes. Tap a chip then an
 * empty slot (or drag it); tap a placed Team to send it back. Each is its own command through the outbox.
 */
export function Draw({ tournamentId, head: h, fallback }: { tournamentId: string; head: Head; fallback: string }) {
  const { teams } = useTeams(tournamentId, h.season.id)
  const { slots, reload } = useDraw(tournamentId, h.season.id)
  const online = useOnline()
  const [opened, setOpened] = useState(false)
  const [picked, setPicked] = useState<Team | null>(null)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const editable = h.season.status === 'registration'

  if (!Array.isArray(teams) || !Array.isArray(slots)) {
    return teams === 'offline' || slots === 'offline' || teams === 'unknown' || slots === 'unknown'
      ? <Problem text={teams === 'unknown' || slots === 'unknown' ? messages.unknown : messages.offline} />
      : <div aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>
  }
  const approved = teams.filter((t) => t.status === 'approved')
  const byId = new Map(teams.map((t) => [t.id, t]))
  const columns = drawColumns(h.season.structure, approved.length)
  const placed = new Set(slots.map((s) => s.teamId))
  const chips = approved.filter((t) => !placed.has(t.id))
  const slotAt = (grp: number, pos: number) => slots.find((s) => s.grp === grp && s.pos === pos)

  if (!slots.length && !opened) {
    return editable && columns.length ? (
      <>
        <p className="body">Record the draw once registration closes.</p>
        {approved.length
          ? <PrimaryButton label="Record the draw" onClick={() => setOpened(true)} />
          : <PrimaryButton label="Record the draw" disabled disabledReason="Approve at least one Team first." />}
      </>
    ) : <p className="body">{fallback}</p>
  }

  async function run(name: string, args: Record<string, unknown>, said: string) {
    setProblem(null)
    const r = await send(name, { season_id: h.season.id, ...args }, { scope: tournamentId })
    // A conflict waits in the hand-back sheet (Keep theirs / Use mine); any other refusal is said here and dropped.
    if (!r.ok && r.code !== 'queued' && r.code !== 'version_conflict') {
      if (r.commandId) void forgetRefused(r.commandId)
      setProblem(messageFor(r.code))
    } else setNotice(said)
    reload()
    return r
  }

  function place(team: Team, grp: number, pos: number) {
    setPicked(null)
    const done = chips.length === 1
    void run('place_team_in_draw', { slot_id: crypto.randomUUID(), team_id: team.id, grp, pos }, done ? 'Draw complete' : `${team.code} placed`)
  }

  function tapSlot(grp: number, pos: number) {
    if (!editable) return
    const s = slotAt(grp, pos)
    if (s) {
      if (picked) return setNotice('That slot is taken.')
      const t = byId.get(s.teamId)
      return void run('unplace_team_from_draw', { team_id: s.teamId }, `${t?.code ?? 'Team'} is back with the chips`)
    }
    if (picked) place(picked, grp, pos)
    else setNotice('Tap a Team chip first, then an empty slot.')
  }

  function drop(e: DragEvent, grp: number, pos: number) {
    e.preventDefault()
    const t = byId.get(e.dataTransfer.getData('text/plain'))
    if (t && !slotAt(grp, pos) && !placed.has(t.id)) place(t, grp, pos)
  }

  async function random() {
    setBusy(true)
    await run('place_rest_at_random', {}, 'The rest are placed at random')
    setBusy(false)
  }

  const complete = approved.length > 0 && !chips.length
  return (
    <div className="draw">
      <p role="status" aria-live="polite" className="body-strong">{notice}</p>
      <Problem text={problem} />
      {h.season.status === 'started' && <p className="meta">{messages.season_started}</p>}
      {columns.length === 0 && <p className="body">{fallback}</p>}
      <div className="draw-cols">
        {columns.map((c) => (
          <section key={c.grp} className="draw-col" aria-label={c.title}>
            <h3 className="body-strong">{c.title}</h3>
            {Array.from({ length: c.size }, (_, i) => i + 1).map((pos) => {
              const s = slotAt(c.grp, pos)
              const t = s && byId.get(s.teamId)
              const where = c.grp ? `${c.title} slot ${pos}` : `Bracket slot ${pos}`
              return (
                <button key={pos} type="button" className={`draw-slot${s ? ' draw-slot-filled' : ''}`} disabled={!editable}
                  aria-label={s ? `${where}: ${t?.code ?? 'Team'}. Send ${t?.code ?? 'the Team'} back to the chips` : `${where}, empty`}
                  onClick={() => tapSlot(c.grp, pos)} onDragOver={(e) => !s && e.preventDefault()} onDrop={(e) => drop(e, c.grp, pos)}>
                  <span className="meta" aria-hidden="true">{pos}</span>
                  {t && <><KitDot colour={t.kitColour} /><span className="body-strong" aria-hidden="true">{t.code}</span></>}
                </button>
              )
            })}
          </section>
        ))}
      </div>
      <section aria-label="Teams still to place">
        <h3 className="body-strong">{complete ? 'Draw complete' : `Teams to place (${chips.length})`}</h3>
        <div className="draw-chips">
          {chips.map((t) => (
            <button key={t.id} type="button" className="draw-chip" aria-pressed={picked?.id === t.id} disabled={!editable} draggable={editable}
              onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
              onClick={() => (setPicked(picked?.id === t.id ? null : t), setNotice(picked?.id === t.id ? '' : `Placing ${t.code}: tap a slot`))}>
              <KitDot colour={t.kitColour} />
              <span className="body-strong">{t.code}</span>
              <span className="meta">{t.name}</span>
            </button>
          ))}
        </div>
      </section>
      {editable && chips.length > 0 && (
        <>
          <p className="meta">To seed a Team, place it first. The rest are placed around it.</p>
          {online && !busy
            ? <SecondaryButton label="Place the rest at random" onClick={() => void random()} />
            : <p className="meta">{busy ? 'Placing the rest…' : 'Placing the rest at random needs a signal. Place Teams one by one meanwhile.'}</p>}
        </>
      )}
    </div>
  )
}
