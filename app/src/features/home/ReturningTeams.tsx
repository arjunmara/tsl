import { useEffect, useRef, useState } from 'react'
import { forgetRefused, queuedFor, send } from '../../domain/commands'
import { messageFor, messages } from '../../domain/messages'
import { addReturning, seasonTeams, type Team } from '../../domain/teams'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { KitDot } from '../../ui/KitDot'
import { Sheet } from '../../ui/Sheet'
import { blocked } from '../auth/form'
import { Problem } from '../auth/Screen'

/**
 * "Add returning Teams" on the Teams tab: lists the previous Season's Teams (withdrawn unticked) and sends the ticked ones as one
 * command (app.add_returning_teams). A row already added, or whose code this Season already uses, is disabled with the reason.
 */
export function ReturningTeams({ tournamentId, seasonId, seasonStatus, sourceId, sourceNumber, current, currentLoaded, onSeasonChange, onSent }: {
  tournamentId: string; seasonId: string; seasonStatus: string; onSeasonChange: () => void; sourceId: string; sourceNumber: number; current: Team[]; currentLoaded: boolean; onSent: (notice: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<Team[] | 'offline' | 'unknown' | null>(null)
  const [queued, setQueued] = useState<string[]>([])
  const [flipped, setFlipped] = useState<Set<string>>(new Set())
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)

  useEffect(() => {
    if (!open) return
    let live = true
    void (async () => {
      const r = await seasonTeams(sourceId)
      const waiting = (await queuedFor(tournamentId)).filter((e) => e.name === 'add_returning_teams')
        .flatMap((e) => (e.args.teams as { from_team_id: string }[]).map((t) => t.from_team_id))
      if (!live) return
      setQueued(waiting)
      setSource('code' in r ? r.code : r.teams)
    })()
    return () => {
      live = false
    }
  }, [open, sourceId, tournamentId])

  const why = (t: Team) =>
    queued.includes(t.id) || current.some((c) => c.returningFrom === t.id) ? 'Already added'
      : current.some((c) => c.code === t.code) ? `Code ${t.code} is already used in this Season` : null
  // Ticked by default unless withdrawn; a tap flips that.
  const isTicked = (t: Team) => !why(t) && (t.status !== 'withdrawn') !== flipped.has(t.id)
  const ticked = Array.isArray(source) ? source.filter(isTicked).map((t) => t.id) : []

  const n = ticked.length
  const loaded = !!currentLoaded
  async function add() {
    if (sending.current || !n) return
    sending.current = true
    setBusy(true)
    setProblem(null)
    const r = await addReturning(tournamentId, seasonId, ticked)
    if (!r.ok && r.code !== 'queued') {
      sending.current = false
      setBusy(false)
      return setProblem(r.code === 'team_code_taken' ? 'A Team in this Season already uses that code. Reload and untick it.'
        : r.code === 'already_returned' ? 'One of these Teams is already in this Season. Untick the Teams already added.' : messageFor(r.code))
    }
    // As "Add this Team" does: the first Teams of a Season in setup open registration (not while an open is already waiting).
    let opened = ''
    if (seasonStatus === 'setup' && !(await queuedFor(tournamentId)).some((e) => e.name === 'open_registration')) {
      const o = await send('open_registration', { season_id: seasonId }, { scope: tournamentId })
      if (o.ok) onSeasonChange()
      else if (o.code !== 'queued') {
        if (o.commandId) void forgetRefused(o.commandId)
        opened = ` ${messageFor(o.code)}`
      }
    }
    sending.current = false
    sending.current = false
    setBusy(false)
    setOpen(false)
    const done = r.code === 'queued' ? `${messages.offline} The returning Teams will be added when the signal is back.`
      : `${n === 1 ? '1 returning Team' : `${n} returning Teams`} added. Share their links below.`
    onSent(done + opened)
  }

  return (
    <>
      <SecondaryButton label="Add returning Teams" onClick={() => (setProblem(null), setFlipped(new Set()), setSource(null), setOpen(true))} />
      <Sheet open={open} title={`Add returning Teams from Season ${sourceNumber}`} onClose={() => setOpen(false)}>
        {({ close }) => (
          <>
            {source === null ? <p className="body" aria-busy="true">Loading Season {sourceNumber}'s Teams</p>
              : !Array.isArray(source) ? <Problem text={source === 'offline' ? messages.offline : messages.teams_unknown} />
              : !source.length ? <p className="body">Season {sourceNumber} had no Teams.</p>
              : (
                <fieldset className="returning-list"><legend className="body-strong">Teams to add from Season {sourceNumber}</legend><ul className="cards">
                  {source.map((t) => {
                    const reason = why(t)
                    return (
                      <li key={t.id} className="card">
                        <label className="team-name">
                          <input type="checkbox" checked={isTicked(t)} disabled={!!reason}
                            onChange={() => setFlipped((s) => { const x = new Set(s); if (!x.delete(t.id)) x.add(t.id); return x })} />
                          <KitDot colour={t.kitColour} />
                          <span className="body-strong">{t.name}</span>
                          <span className="meta">{t.code}{t.status === 'withdrawn' ? ' · Withdrawn' : ''}</span>
                          {reason && <span className="meta">{reason}</span>}
                        </label>
                      </li>
                    )
                  })}
                </ul></fieldset>
              )}
            <Problem text={problem} />
            <div className="ui-sheet-actions">
              {n && !loaded ? <PrimaryButton label="Add returning Teams" disabled disabledReason="Wait for this Season's Teams to load." />
                : n ? <PrimaryButton label={n === 1 ? 'Add 1 returning Team' : `Add ${n} returning Teams`} onClick={() => void add()} {...blocked(busy && 'Adding the Teams…')} />
                : <PrimaryButton label="Add returning Teams" disabled disabledReason="Tick at least one Team." />}
              <SecondaryButton label="Close this list" onClick={close} />
            </div>
          </>
        )}
      </Sheet>
    </>
  )
}
