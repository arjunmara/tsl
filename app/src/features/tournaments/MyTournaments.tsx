import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useOutbox } from '../../domain/commands'
import { messages } from '../../domain/messages'
import { myTournaments, type SeasonStatus, type TournamentSummary } from '../../domain/tournaments'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { StatusPill } from '../../ui/StatusPill'
import { Problem } from '../auth/Screen'
import { useOnline } from '../app/online'
import { useSession } from '../auth/session'
import { AccountMenu } from './AccountMenu'

const statusLabel: Record<SeasonStatus, string> = { setup: 'Setup', registration: 'Registration', started: 'Started', finished: 'Finished' }

export function MyTournaments() {
  const navigate = useNavigate()
  const session = useSession()
  const online = useOnline()
  // undefined while loading.
  const [list, setList] = useState<TournamentSummary[] | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // This user's creates still on the device; the list reloads as each one is sent.
  const queued = useOutbox().entries.filter((e) => e.name === 'create_tournament')

  // Loads on open, on "Try loading again", and again when the signal comes back.
  useEffect(() => {
    const again = () => setAttempt((n) => n + 1)
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [])
  useEffect(() => {
    let live = true
    void myTournaments().then((r) => {
      if (!live) return
      if ('tournaments' in r) return (setList(r.tournaments), setError(null))
      setList([])
      setError(r.code === 'offline' ? messages.offline : messages.tournaments_unknown)
    })
    return () => { live = false }
  }, [attempt, queued.length])

  // A create already in the loaded list (sent, answer lost) shows once, as the real card.
  const waiting = queued.filter((e) => !list?.some((t) => t.id === e.args.tournament_id)).map((e) => (
    <li key={e.seq} className="card-waiting">
      <h2 className="body-strong">{String(e.args.name ?? '')}</h2>
      <p className="body">
        <StatusPill state="pending" label={e.state === 'failed' ? "Couldn't save" : 'Waiting to send'} />
      </p>
    </li>
  ))
  const create = <PrimaryButton label="Create new tournament" onClick={() => navigate('/new')} />
  return (
    <main className="screen">
      <div className="app-bar">
        <h1 className="title">My tournaments</h1>
        <AccountMenu email={session?.email ?? ''} />
      </div>
      {!online && <p role="status" className="banner body-strong">{messages.offline_banner}</p>}
      {list === undefined ? (
        <div aria-busy="true">
          <p className="ui-visually-hidden">Loading</p>
          <ul className="cards">{waiting}{[0, 1, 2].map((i) => <li key={i} className="skeleton-card" />)}</ul>
        </div>
      ) : error ? (
        <>
          <Problem text={error} />
          <SecondaryButton label="Try loading again" onClick={() => (setList(undefined), setError(null), setAttempt((n) => n + 1))} />
          {waiting.length > 0 && <ul className="cards">{waiting}</ul>}
          {create}
        </>
      ) : list.length === 0 && waiting.length === 0 ? (
        <div className="empty">
          <p className="body-strong">No tournaments yet.</p>
          {create}
        </div>
      ) : (
        <>
          <ul className="cards">
            {waiting}
            {list.map((t) => (
              <li key={t.id} className="card">
                <h2 className="body-strong">{t.name}</h2>
                {t.season && (
                  <p className="body">
                    Season {t.season.number} · <StatusPill state={t.season.status === 'finished' ? 'done' : 'pending'} label={statusLabel[t.season.status]} />
                  </p>
                )}
              </li>
            ))}
          </ul>
          {create}
        </>
      )}
    </main>
  )
}
