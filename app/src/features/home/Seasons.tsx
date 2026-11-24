import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { runCommand } from '../../domain/commands'
import { messageFor } from '../../domain/messages'
import type { SeasonSummary } from '../../domain/tournaments'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { backIcon, IconButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { SaveStatusBar } from '../save-status/SaveStatusBar'
import { forgetRead, Unavailable, UUID } from '../setup/Setup'
import { forgetHead, readHead, type Head } from './Home'
import { statusLabel } from '../tournaments/MyTournaments'

/**
 * The Tournament's Seasons, newest first: the current one, each past one opening its settings read-only, and "Start new season"
 * (only while the latest Season is finished) behind a Confirm sheet. The server decides too (app.new_season).
 */
export function Seasons({ tournamentId, seasons, viewing }: { tournamentId: string; seasons: SeasonSummary[]; viewing?: string }) {
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // The ids of the confirmed start, kept until the server answers definitely, so a retry replays the same command.
  const attempt = useRef<{ commandId: string; seasonId: string } | null>(null)
  const cur = seasons[0]
  if (!cur) return null

  async function start() {
    if (busy) return
    setBusy(true)
    setProblem(null)
    const a = (attempt.current ??= { commandId: crypto.randomUUID(), seasonId: crypto.randomUUID() })
    const r = await runCommand('new_season', { tournament_id: tournamentId, season_id: a.seasonId }, a.commandId)
    // Offline or a server error may have run it: keep the ids so the retry gets the stored answer.
    if (r.code !== 'offline' && r.code !== 'unknown') attempt.current = null
    if (r.ok) {
      forgetHead(tournamentId)
      forgetRead(tournamentId)
      navigate(`/t/${tournamentId}/setup/3`)
    } else setProblem(messageFor(r.code))
    setBusy(false)
  }

  return (
    <>
      <ul className="cards home-list">
        {seasons.map((s, i) => (
          <li key={s.id} className="card">
            <h2 className="body-strong">Season {s.number} · {statusLabel[s.status]}{i === 0 ? ' · current' : ''}</h2>
            {s.id !== (viewing ?? cur.id) && <SecondaryButton label={`Open Season ${s.number}`} onClick={() => navigate(i === 0 ? `/t/${tournamentId}` : `/t/${tournamentId}?season=${s.id}`)} />}
            {i > 0 && <SecondaryButton label={`Open Season ${s.number} settings`} onClick={() => navigate(`/t/${tournamentId}/settings?season=${s.id}`)} />}
          </li>
        ))}
      </ul>
      <Problem text={problem} />
      {busy ? <PrimaryButton label="Start new season" disabled disabledReason={`Starting Season ${cur.number + 1}…`} />
        : cur.status === 'finished'
        ? <PrimaryButton label="Start new season" onClick={() => setConfirm(true)} />
        : <PrimaryButton label="Start new season" disabled
          disabledReason={`Season ${cur.number} is still running. Finish it before starting Season ${cur.number + 1}.`} />}
      <ConfirmSheet open={confirm} title={`Copy branding, rules, Format and Structure from Season ${cur.number}?`} before={`Season ${cur.number}`}
        after={`Season ${cur.number + 1}`} note="Teams, Squads and dates are not copied. Sponsors are." actionLabel="Copy and continue"
        onConfirm={() => void start()} onClose={() => setConfirm(false)} />
    </>
  )
}

/** /t/:tournamentId/settings/seasons: the same list as the Season switcher. */
export function SeasonsPage() {
  const { tournamentId = '' } = useParams()
  const navigate = useNavigate()
  const [head, setHead] = useState<Head | 'missing' | 'offline' | 'unknown' | null>(null)
  const valid = UUID.test(tournamentId)
  useEffect(() => {
    if (!valid) return
    let live = true
    void readHead(tournamentId).then((h) => live && setHead(h))
    return () => {
      live = false
    }
  }, [tournamentId, valid])
  if (!valid || head === 'missing') return <><SaveStatusBar /><Unavailable /></>
  return (
    <main className="home">
      <header className="home-bar">
        <IconButton label="Back to settings" onClick={() => navigate(`/t/${tournamentId}/settings`)}>{backIcon}</IconButton>
        <h1 className="title home-title">Seasons</h1>
        <SaveStatusBar />
      </header>
      {head && typeof head === 'object' ? <Seasons tournamentId={tournamentId} seasons={head.seasons} />
        : head ? <Problem text="Can't load the Seasons. Check your signal, then reload." /> : <div className="skeleton-card" aria-busy="true" />}
    </main>
  )
}
