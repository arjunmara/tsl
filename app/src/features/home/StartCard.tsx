import { Fragment, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { runCommand, useOutbox } from '../../domain/commands'
import { supabase } from '../../domain/supabase'
import { messageFor } from '../../domain/messages'
import { PrimaryButton } from '../../ui/Button'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { Problem } from '../auth/Screen'
import { useOnline } from '../app/online'

type Check = { ready: boolean; reason: string; teams: { id: string; code: string }[] }

/** app.start_check for the Season: read again when changes send, the signal returns or a start is refused. Offline, nothing is read. */
function useStartCheck(seasonId: string) {
  const [check, setCheck] = useState<Check | null>(null)
  const [attempt, setAttempt] = useState(0)
  const pending = useOutbox().entries.length
  const online = useOnline()
  useEffect(() => {
    if (!online) return
    let live = true
    void supabase.schema('app').rpc('start_check', { p_season_id: seasonId }).then(({ data, error }) => {
      const c = data as Check | null
      if (live && !error && c && typeof c.reason === 'string') setCheck({ ...c, teams: Array.isArray(c.teams) ? c.teams : [] })
    })
    return () => {
      live = false
    }
  }, [seasonId, attempt, pending, online])
  return { check, reload: () => setAttempt((n) => n + 1) }
}

/** The reason as the card shows it: the Team codes inside the brackets link to their Team pages. */
function Reason({ check, tournamentId }: { check: Check; tournamentId: string }) {
  const m = /^(.*\()(.*)(\).*)$/.exec(check.reason)
  if (!m || !check.teams.length) return <>{check.reason}</>
  return (
    <>
      {m[1]}
      {check.teams.map((t, i) => (
        <Fragment key={t.id}>{i > 0 && ', '}<Link to={`/t/${tournamentId}/teams/${t.id}`}>{t.code}</Link></Fragment>
      ))}
      {m[3]}
    </>
  )
}

/**
 * The Start card on the Matches tab while the Season is in registration (Story 3.5): the reason in words (a polite live region),
 * and "Start tournament" behind a Confirm sheet. The database decides readiness (app.start_check); the command re-checks it.
 */
export function StartCard({ tournamentId, seasonId, number, onStarted }: { tournamentId: string; seasonId: string; number: number; onStarted: () => void }) {
  const { check, reload } = useStartCheck(seasonId)
  const online = useOnline()
  const waiting = useOutbox().entries.filter((e) => e.scope === tournamentId && e.state === 'pending').length > 0
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function start() {
    if (busy) return
    setBusy(true)
    setProblem(null)
    const r = await runCommand('start_season', { season_id: seasonId })
    if (r.ok || r.code === 'season_started') {
      onStarted()
    } else {
      setProblem(r.code === 'start_blocked' && r.message ? r.message : messageFor(r.code))
      reload()
    }
    setBusy(false)
  }

  return (
    <div className="start-card card">
      <div role="status" aria-live="polite" className="body-strong">{check && online ? <Reason check={check} tournamentId={tournamentId} /> : null}</div>
      <Problem text={problem} />
      {!online ? <p className="meta">Starting the tournament needs a signal.</p>
        : !check ? <PrimaryButton label="Start tournament" disabled disabledReason="Checking what is left to do." />
          : waiting ? <PrimaryButton label="Start tournament" disabled disabledReason="Waiting for your changes to send." />
            : !check.ready ? <PrimaryButton label="Start tournament" disabled disabledReason="Finish what is listed above first." />
              : <PrimaryButton label="Start tournament" onClick={() => setConfirm(true)} />}
      <ConfirmSheet open={confirm} title={`Start Season ${number}?`} before="Registration" after="Started"
        note="Teams and the Draw lock and you can't go back to registration." actionLabel="Start" onConfirm={() => void start()} onClose={() => setConfirm(false)} />
    </div>
  )
}
