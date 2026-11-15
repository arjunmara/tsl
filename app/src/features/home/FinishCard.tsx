import { useEffect, useState } from 'react'
import { runCommand, useOutbox } from '../../domain/commands'
import { supabase } from '../../domain/supabase'
import { messageFor } from '../../domain/messages'
import { PrimaryButton } from '../../ui/Button'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { Problem } from '../auth/Screen'
import { useOnline } from '../app/online'

type Check = { ready: boolean; reason: string }

/** app.finish_check for the Season: read again when changes send, the signal returns or a finish is refused. Offline, nothing is read. */
function useFinishCheck(seasonId: string) {
  const [check, setCheck] = useState<Check | null>(null)
  const [attempt, setAttempt] = useState(0)
  const pending = useOutbox().entries.length
  const online = useOnline()
  useEffect(() => {
    if (!online) return
    let live = true
    void supabase.schema('app').rpc('finish_check', { p_season_id: seasonId }).then(({ data, error }) => {
      const c = data as Check | null
      if (live && !error && c && typeof c.reason === 'string') setCheck(c)
    })
    return () => {
      live = false
    }
  }, [seasonId, attempt, pending, online])
  return { check, reload: () => setAttempt((n) => n + 1) }
}

/**
 * The Finish card on the Matches tab while the Season is started (Story 3.8): the reason in words (a polite live region), and
 * "Finish season" behind a destructive Confirm sheet. The database decides readiness (app.finish_check); the command re-checks it.
 */
export function FinishCard({ tournamentId, seasonId, number, onFinished }: { tournamentId: string; seasonId: string; number: number; onFinished: () => void }) {
  const { check, reload } = useFinishCheck(seasonId)
  const online = useOnline()
  const waiting = useOutbox().entries.filter((e) => e.scope === tournamentId && e.state === 'pending').length > 0
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function finish() {
    if (busy) return
    setBusy(true)
    setProblem(null)
    const r = await runCommand('finish_season', { season_id: seasonId })
    if (r.ok || r.code === 'season_finished') {
      onFinished()
    } else {
      setProblem(r.code === 'finish_blocked' && r.message ? r.message : messageFor(r.code))
      reload()
    }
    setBusy(false)
  }

  return (
    <div className="finish-card card">
      <div role="status" aria-live="polite" className="body-strong">{check && online ? check.reason : null}</div>
      <Problem text={problem} />
      {!online ? <p className="meta">Finishing the season needs a signal.</p>
        : !check ? <PrimaryButton label="Finish season" disabled disabledReason="Checking what is left to do." />
          : waiting ? <PrimaryButton label="Finish season" disabled disabledReason="Waiting for your changes to send." />
            : !check.ready ? <PrimaryButton label="Finish season" disabled disabledReason="Finish what is listed above first." />
              : <PrimaryButton label="Finish season" onClick={() => setConfirm(true)} />}
      <ConfirmSheet open={confirm} destructive title={`Finish Season ${number}?`} before="Started" after="Finished"
        note="Squads, Fixtures and results lock for good, and eligibility scans are deleted." actionLabel="Finish season"
        onConfirm={() => void finish()} onClose={() => setConfirm(false)} />
    </div>
  )
}
