import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { signOut } from '../../domain/auth'
import { forgetRefused, send } from '../../domain/commands'
import { messageFor, messages } from '../../domain/messages'
import { invitePreview } from '../../domain/tournaments'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { EmailCode } from './EmailCode'
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

/**
 * /invite/:token: a co-organiser invite. Signed out: which Tournament and email it's for, then a code emailed there signs
 * the person in (account made if needed) and accepts. Verified: "Accept this invite".
 */
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
  const signedOut = session === null
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof invitePreview>> | null>(null)
  const [loads, setLoads] = useState(0)
  useEffect(() => {
    if (!valid || !signedOut) return
    let live = true
    void invitePreview(token).then((p) => {
      if (!live) return
      setPreview(p)
      // A dead link isn't worth coming back to after signing in.
      if (!('code' in p) && p.status !== 'pending') dropInvite()
    })
    return () => {
      live = false
    }
  }, [valid, signedOut, token, loads])
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
    if (!preview) return <main className="screen" aria-busy="true"><p className="ui-visually-hidden">Loading</p></main>
    if ('code' in preview) {
      return (
        <Screen title="Help run a tournament">
          <Problem text={messageFor(preview.code)} />
          <PrimaryButton label="Load the invite again" onClick={() => (setPreview(null), setLoads((n) => n + 1))} />
          <SecondaryButton label="Sign in with a password" onClick={() => navigate('/sign-in')} />
        </Screen>
      )
    }
    if (preview.status !== 'pending') {
      return (
        <Screen title="This invite isn't working">
          <Problem text={messageFor(`invite_${preview.status}`)} />
          <SecondaryButton label="Open the sign-in page" onClick={() => navigate('/sign-in')} />
        </Screen>
      )
    }
    return (
      <Screen title="Help run a tournament">
        <p className="body">
          You've been invited to organise <strong>{preview.tournamentName}</strong>, with full rights in that tournament
          only. The invite is for <strong>{preview.email}</strong>. We'll email a code there to sign you in; no password
          needed.
        </p>
        <EmailCode email={preview.email} create sendLabel="Email me a code" verifyLabel="Accept this invite"
          verifyingLabel="Accepting the invite…" onSignedIn={() => void accept()} />
        <SecondaryButton label="Sign in with a password" onClick={() => navigate('/sign-in')} />
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

  // Back to this invite signed out, which offers a code to the invited email.
  async function switchAccount() {
    keep(token)
    await signOut()
    setProblem(null)
    setWrongEmail(false)
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
      {wrongEmail && <SecondaryButton label="Sign out and use the invited email" onClick={() => void switchAccount()} />}
      {(problem || queued) && <SecondaryButton label="Open My tournaments" onClick={() => navigate('/', { replace: true })} />}
    </Screen>
  )
}
