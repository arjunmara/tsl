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
import { STEPS } from '../setup/Setup'
import { AccountMenu } from './AccountMenu'

/** "Step 1 is saved. Next: Description & rules." for k finished steps. */
const savedSteps = (k: number) =>
  `${k === 0 ? '' : k === 1 ? 'Step 1 is saved. ' : `Steps 1–${k} are saved. `}Next: ${STEPS[k]}.`

const statusLabel: Record<SeasonStatus, string> = { setup: 'Setup', registration: 'Registration', started: 'Started', finished: 'Finished' }

export function MyTournaments() {
  const navigate = useNavigate()
  const session = useSession()
  const online = useOnline()
  // undefined while loading.
  const [list, setList] = useState<TournamentSummary[] | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // This user's changes still on the device; the list reloads as each one is sent (setup steps included).
  const mine = useOutbox().entries
  const queued = mine.filter((e) => e.name === 'create_tournament')

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
  }, [attempt, mine.length])

  // A create already in the loaded list (sent, answer lost) shows once, as the real card.
  const waiting = queued.filter((e) => !list?.some((t) => t.id === e.args.tournament_id)).map((e) => (
    <li key={e.seq} className="card-waiting">
      <h2 className="body-strong">{String(e.args.name ?? '')}</h2>
      <p className="body">
        <StatusPill state="pending" label={e.state !== 'pending' ? "Couldn't save" : 'Waiting to send'} />
      </p>
      <PrimaryButton label="Continue setup" onClick={() => navigate(`/t/${String(e.args.tournament_id)}/setup/1`)} />
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
            {list.map((t) => t.season?.status === 'setup' && t.season.setupStep < 7 ? (
              <li key={t.id} className="card">
                <div className="resume-head">
                  {t.logoUrl ? <img className="resume-logo" src={t.logoUrl} alt="" />
                    : <span className="resume-logo resume-initial" aria-hidden="true">{[...t.name][0]?.toUpperCase()}</span>}
                  <h2 className="body-strong">{t.name}</h2>
                </div>
                <p className="body">Season {t.season.number} · Setup · step {t.season.setupStep + 1} of 7</p>
                <div className="wizard-progress" aria-hidden="true">
                  <div style={{ width: `${(t.season.setupStep / 7) * 100}%` }} />
                </div>
                <p className="meta">{savedSteps(t.season.setupStep)}</p>
                <PrimaryButton label="Continue setup" onClick={() => navigate(`/t/${t.id}/setup/${t.season!.setupStep + 1}`)} />
              </li>
            ) : (
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
