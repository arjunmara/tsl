import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { signOut } from '../../domain/auth'
import { forgetRefused, send } from '../../domain/commands'
import { messageFor, messages } from '../../domain/messages'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { blocked } from './form'
import { Problem, Screen } from './Screen'
import { useSession } from './session'

// An invite opened while signed out or unverified is kept on this device for a day, so signing in, signing up or
// verifying (which all land on My tournaments) comes back to it. It is dropped once the invite page shows to a verified
// account, and on sign-out, so a shared phone doesn't send the next person to someone else's invite.
const KEY = 'tsl-invite'
const KEEP_MS = 24 * 60 * 60 * 1000
export function pendingInvite(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { token?: unknown; at?: unknown } | null
    if (v && typeof v.token === 'string' && typeof v.at === 'number' && Date.now() - v.at < KEEP_MS) return v.token
  } catch {
    // Blocked or bad storage.
  }
  dropInvite()
  return null
}
function keep(token: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token, at: Date.now() }))
  } catch {
    // Blocked storage: the person opens the link again after signing in.
  }
}
export function dropInvite() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing kept.
  }
}

// app.invite_organiser makes 43-character base64url tokens.
const TOKEN = /^[A-Za-z0-9_-]{40,64}$/

/** /invite/:token: a co-organiser invite. Signed out: sign in or sign up first. Verified: "Accept this invite". */
export function Invite() {
  const { token = '' } = useParams()
  const session = useSession()
  const navigate = useNavigate()
  const valid = TOKEN.test(token)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [wrongEmail, setWrongEmail] = useState(false)
  const [queued, setQueued] = useState(false)
  const verified = !!session?.verified
  // Kept from the moment the session is known until a verified account sees the invite.
  useEffect(() => {
    if (!valid || session === undefined) return
    if (verified) dropInvite()
    else keep(token)
  }, [valid, session, verified, token])

  if (session === undefined) return <main className="screen" aria-busy="true"><p className="ui-visually-hidden">Loading</p></main>
  if (!valid) {
    return (
      <Screen title="This invite isn't working">
        <Problem text={messages.invite_missing} />
        <SecondaryButton label="Open My tournaments" onClick={() => navigate('/', { replace: true })} />
      </Screen>
    )
  }
  if (session && !session.verified) return <Navigate to="/check-email" replace state={{ email: session.email }} />
  if (!session) {
    return (
      <Screen title="Help run a tournament">
        <p className="body">
          You've been invited to organise a tournament. Sign in, or create an account, with the email this invite was sent
          to. You'll come back to this invite afterwards.
        </p>
        <PrimaryButton label="Sign in to accept the invite" onClick={() => navigate('/sign-in')} />
        <SecondaryButton label="Create an account to accept the invite" onClick={() => navigate('/sign-up')} />
      </Screen>
    )
  }

  async function accept() {
    if (busy) return
    setBusy(true)
    setProblem(null)
    setWrongEmail(false)
    // Its own scope (never the token: a discarded change's scope is stored on the server), so a refused accept holds
    // back nothing else.
    const r = await send('accept_invite', { token }, { scope: 'invite' })
    setBusy(false)
    const tournamentId = (r as { tournament_id?: unknown }).tournament_id
    if (r.ok) return navigate(typeof tournamentId === 'string' ? `/t/${tournamentId}` : '/', { replace: true })
    if (r.code === 'queued') return setQueued(true)
    if (r.commandId) void forgetRefused(r.commandId)
    setProblem(messageFor(r.code))
    setWrongEmail(r.code === 'invite_wrong_email')
  }

  async function switchAccount() {
    keep(token)
    await signOut()
    navigate('/sign-in', { replace: true })
  }

  return (
    <Screen title="Help run a tournament">
      <p className="body">
        You've been invited to organise a tournament, with full rights in that tournament only. You're signed in
        as <strong>{session.email}</strong>.
      </p>
      <Problem text={problem} />
      {queued ? (
        <p role="status" className="body">
          {messages.offline} You'll join once the invite is sent; the tournament then shows on My tournaments.
        </p>
      ) : !problem && (
        <PrimaryButton label="Accept this invite" onClick={() => void accept()} {...blocked(busy && 'Accepting the invite…')} />
      )}
      {wrongEmail && <SecondaryButton label="Sign out to use another account" onClick={() => void switchAccount()} />}
      {(problem || queued) && <SecondaryButton label="Open My tournaments" onClick={() => navigate('/', { replace: true })} />}
    </Screen>
  )
}
