import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { scorerMatches, type ScorerMatch } from '../../domain/console'
import { kickOffText } from '../home/Fixtures'
import { hasSession, signInAnonymously, signOut } from '../../domain/auth'
import { serverNow } from '../../domain/clock'
import { messageFor, messages } from '../../domain/messages'
import { keepDevice, keepNumber, keptDevice, keptNumber, phoneStatus, requestApproval, type PhoneStatus } from '../../domain/scorer'
import { TOKEN } from '../../domain/teamCode'
import { SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { Turnstile } from '../auth/Turnstile'

type State =
  | { step: 'loading' | 'captcha' | 'bad' | 'form' }
  | { step: 'problem'; text: string }
  | { step: 'phone'; phone: PhoneStatus }

const POLL_MS = 3000

/**
 * /score#<token>: a Scorer's whole app (Story 4.1, AD-13). Sealed: no navigation. The phone passes Turnstile, signs in
 * anonymously (its own storage key, see domain/supabase.ts), names itself and asks; the Organiser taps the number shown here.
 * Until approved it can read nothing: its status comes only from app.scorer_status().
 */
export function Score() {
  const token = location.hash.slice(1)
  const [state, setState] = useState<State>({ step: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [captchaKey, setCaptchaKey] = useState(0)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [now, setNow] = useState(() => serverNow().getTime())
  useEffect(() => {
    const h = () => location.reload()
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])

  const phone = state.step === 'phone' ? state.phone : null
  const watching = phone?.status === 'pending' || phone?.status === 'approved'
  // This phone's request through this link is read once, then every 3 s while it waits or scores (revoking shows on the next read).
  // One read at a time: a tick never cancels or doubles a read in flight, and an explicit read asked meanwhile runs right after it.
  const first = useRef(true)
  const busyRead = useRef(false)
  const rerun = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function read() {
    if (busyRead.current) {
      rerun.current = true
      return
    }
    busyRead.current = true
    const show = (s: State) => alive.current && setState(s)
    try {
      if (!(await hasSession())) return show(TOKEN.test(token) ? { step: 'captcha' } : { step: 'bad' })
      const list = await phoneStatus()
      if ('code' in list) {
        // A poll that can't reach the server keeps what the phone last showed.
        if (first.current) show({ step: 'problem', text: list.code === 'offline' ? messages.offline : messages.scorer_unknown })
        return
      }
      first.current = false
      const kept = keptDevice(token)
      const p = kept ? list.find((d) => d.id === kept) : undefined
      if (p) return show({ step: 'phone', phone: p })
      show(TOKEN.test(token) ? { step: 'form' } : { step: 'bad' })
    } finally {
      busyRead.current = false
      if (rerun.current) {
        rerun.current = false
        void read()
      }
    }
  }
  useEffect(() => {
    void read()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, attempt])
  useEffect(() => {
    if (!watching) return
    const t = setInterval(() => {
      setNow(serverNow().getTime())
      if (!busyRead.current) void read()
    }, POLL_MS)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, token])

  async function signIn(captcha: string | null) {
    if (captcha === null) return
    setState({ step: 'loading' })
    const failure = await signInAnonymously(captcha)
    setCaptchaKey((k) => k + 1)
    if (failure?.code === 'session_missing') await signOut()
    if (failure) setState({ step: 'problem', text: failure.message })
    else setAttempt((n) => n + 1)
  }

  async function ask() {
    const name = label.trim()
    if (busy) return
    if (!name || name.length > 40) return setProblem(messages.label_invalid)
    setBusy(true)
    setProblem(null)
    const r = await requestApproval(token, name)
    setBusy(false)
    if (r.code === 'not_signed_in') {
      await signOut()
      return setState({ step: 'captcha' })
    }
    if (r.ok && r.device_id) keepDevice(token, r.device_id)
    if (r.ok && r.device_id && typeof r.number === 'number') keepNumber(r.device_id, r.number)
    if (r.ok) return setAttempt((n) => n + 1)
    if (r.code === 'link_dead') return setState({ step: 'problem', text: messages.link_dead })
    setProblem(r.code === 'offline' ? messages.offline : r.code === 'unknown' ? messages.scorer_unknown : messageFor(r.code))
  }

  const askAgain = (
    <button type="button" className="ui-button ui-primary" aria-label="Ask again for approval"
      onClick={() => (setState({ step: 'form' }), setProblem(null))}>Ask again</button>
  )
  return (
    <main className="screen score">
      <h1 className="title">Score matches</h1>
      {state.step === 'loading' && <p className="body" aria-busy="true">Opening the Scorer page…</p>}
      {state.step === 'captcha' && (
        <>
          <p className="body">{messages.captcha_wait}</p>
          <Turnstile key={captchaKey} quiet onToken={(t) => void signIn(t)} />
        </>
      )}
      {state.step === 'bad' && <Problem text={messages.link_incomplete} />}
      {state.step === 'problem' && (
        <>
          <Problem text={state.text} />
          <SecondaryButton label="Try the link again" onClick={() => (setState({ step: 'loading' }), setAttempt((n) => n + 1))} />
        </>
      )}
      {state.step === 'form' && (
        <form noValidate onSubmit={(e) => (e.preventDefault(), void ask())}>
          <label className="body-strong" htmlFor="score-label">Name this phone</label>
          <input id="score-label" className="ui-input" value={label} maxLength={40} autoComplete="off" placeholder="Bikash's phone"
            onChange={(e) => setLabel(e.target.value)} />
          <p className="meta">The organiser sees this name when they approve the phone.</p>
          <Problem text={problem} />
          <button type="submit" className="ui-button ui-primary" disabled={busy}>Ask for approval</button>
        </form>
      )}
      {phone && <Phone phone={phone} now={now} askAgain={askAgain} />}
    </main>
  )
}

function Phone({ phone, now, askAgain }: { phone: PhoneStatus; now: number; askAgain: React.ReactNode }) {
  const left = Math.ceil((Date.parse(phone.expiresAt) - now) / 60_000)
  const number = phone.status === 'pending' ? keptNumber(phone.id) : null
  if (phone.status === 'approved') return <ApprovedMatches seasonId={phone.seasonId} />
  if (phone.status === 'revoked') return <Problem text={messages.link_dead} />
  if (phone.status === 'rejected') return <><p className="body-strong">The organiser didn't approve this request.</p>{askAgain}</>
  if (phone.status === 'expired' || (phone.status === 'pending' && left <= 0)) return <><p className="body-strong">This request expired.</p>{askAgain}</>
  if (number === null) return <><p className="body-strong">This phone lost its number.</p>{askAgain}</>
  return (
    <>
      <p className="meta">Show this number to the organiser.</p>
      <p className="display-xl score-number" data-testid="score-number">{number}</p>
      <p className="body" role="status">Waiting for the organiser to approve this phone.</p>
      <p className="meta">Expires in {left} min</p>
    </>
  )
}

/** An approved phone: the Season's live Matches and its next scheduled one, each opening the console (Story 4.2). */
function ApprovedMatches({ seasonId }: { seasonId: string }) {
  const navigate = useNavigate()
  const { hash, state } = useLocation()
  const [note] = useState(() => (state as { note?: string } | null)?.note ?? '')
  const [list, setList] = useState<ScorerMatch[] | 'offline' | 'unknown' | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    void scorerMatches(seasonId).then((r) => live && setList('code' in r ? r.code : r))
    return () => {
      live = false
    }
  }, [seasonId, attempt])
  if (list === null) return <p className="body" aria-busy="true">Loading the matches…</p>
  if (typeof list === 'string') {
    return (
      <>
        <Problem text={list === 'offline' ? messages.offline : messages.fixtures_unknown} />
        <SecondaryButton label="Try loading the matches again" onClick={() => (setList(null), setAttempt((n) => n + 1))} />
      </>
    )
  }
  return (
    <>
      <p role="status" aria-live="polite" className="body-strong">{note}</p>
      {list.length === 0 && <p className="body-strong">No Match to score yet.</p>}
      <ul className="cards">
        {list.map((m) => (
          <li key={m.matchId} className="card match-card">
            <span className="meta">{m.status === 'live' ? 'Live · ' : ''}{m.round}{m.label && m.label !== m.round ? ` · ${m.label}` : ''}</span>
            <span className="match-sides">
              <span className="match-side">{m.homeCode ?? '?'}</span><span className="meta" aria-label="versus">v</span><span className="match-side">{m.awayCode ?? '?'}</span>
            </span>
            <span className="meta">{kickOffText(m.kickOff)}</span>
            {m.held && !m.mine && <span className="meta">Another phone is scoring this match.</span>}
            <button type="button" className="ui-button ui-primary" onClick={() => navigate({ pathname: `/score/${m.matchId}`, hash })}>Score this match</button>
          </li>
        ))}
      </ul>
    </>
  )
}
