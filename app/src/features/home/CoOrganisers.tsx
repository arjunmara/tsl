import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { inviteUrl } from '../../domain/appUrl'
import { forgetRefused, send, useOutbox, type CommandResult } from '../../domain/commands'
import { formatDate, inZone } from '../../domain/format'
import { messageFor, messages } from '../../domain/messages'
import { coOrganisers, type Invite, type Organiser } from '../../domain/tournaments'
import { backIcon, DestructiveButton, IconButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { blocked, checkEmail, noop, useForm } from '../auth/form'
import { Problem } from '../auth/Screen'
import { useSession } from '../auth/session'
import { Unavailable, UUID } from '../setup/Setup'

type Data = { organisers: Organiser[]; invites: Invite[] }

/** /t/:tournamentId/settings/co-organisers: the Organisers (remove, leave), invites waiting (share, cancel), a new invite. */
export function CoOrganisers() {
  const { tournamentId = '' } = useParams()
  if (!UUID.test(tournamentId)) return <Unavailable />
  return <Manage key={tournamentId} tournamentId={tournamentId} />
}

function Manage({ tournamentId }: { tournamentId: string }) {
  const navigate = useNavigate()
  const session = useSession()
  const { ref, showErrors, values } = useForm()
  const [data, setData] = useState<Data | 'missing' | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // A refusal shows beside what was tried: the invite form, or the lists.
  const [problem, setProblem] = useState<{ text: string; at: 'form' | 'list' } | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<{ email: string; link: string } | null>(null)
  const [formKey, setFormKey] = useState(0)
  // Reloads as this user's queued changes are sent, and when the signal comes back.
  const pending = useOutbox().entries.length

  useEffect(() => {
    const again = () => setAttempt((n) => n + 1)
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [])
  useEffect(() => {
    let live = true
    void coOrganisers(tournamentId).then((r) => {
      if (!live) return
      if ('code' in r) return setLoadError(r.code === 'offline' ? messages.offline : messages.organisers_unknown)
      setLoadError(null)
      // No Organisers visible: not the caller's Tournament (or they were just removed).
      setData(r.organisers.length ? r : 'missing')
    })
    return () => {
      live = false
    }
  }, [tournamentId, attempt, pending])

  /** Sends a command; a definite refusal is shown here and dropped from the queue. Returns the answer. */
  async function run(name: string, args: Record<string, unknown>, offlineText: string): Promise<CommandResult | null> {
    const at = name === 'invite_organiser' ? 'form' : 'list'
    setProblem(null)
    setNotice('')
    const r = await send(name, { tournament_id: tournamentId, ...args }, { scope: tournamentId })
    if (r.code === 'queued') return (setNotice(`${messages.offline} ${offlineText}`), null)
    if (!r.ok) {
      if (r.commandId) void forgetRefused(r.commandId)
      setProblem({ text: messageFor(r.code), at })
      return null
    }
    setAttempt((n) => n + 1)
    return r
  }

  async function invite() {
    const v = values()
    if (!v || busy) return
    const email = v['invite-email']!.toLowerCase()
    setBusy(true)
    setMade(null)
    const r = await run('invite_organiser', { invite_id: crypto.randomUUID(), email },
      'The invite will be made when the signal is back; its link then shows under Invites waiting.')
    setBusy(false)
    const token = (r as { token?: unknown } | null)?.token
    if (typeof token !== 'string') return
    setMade({ email, link: inviteUrl(token) })
    setFormKey((n) => n + 1)
  }

  async function share(email: string, link: string) {
    setNotice('')
    const text = 'Help me run our tournament on TSL. Open this link and sign in with this email address to join.'
    try {
      if (navigator.share) return void (await navigator.share({ title: 'Invite to organise a tournament', text, url: link }))
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
    }
    try {
      await navigator.clipboard.writeText(link)
      setNotice(`Invite link copied. Paste it in a message to ${email}.`)
    } catch {
      setNotice(`Copy the invite link above and send it to ${email}.`)
    }
  }

  async function remove(o: Organiser) {
    const me = o.userId === session?.id
    const r = await run('remove_organiser', { user_id: o.userId },
      me ? 'You will leave this tournament when the signal is back.' : `${o.email} will be removed when the signal is back.`)
    if (!r) return
    if (me) return navigate('/', { replace: true })
    setNotice(`${o.email} no longer organises this tournament.`)
  }

  async function cancel(i: Invite) {
    const r = await run('cancel_invite', { invite_id: i.id }, `The invite for ${i.email} will be cancelled when the signal is back.`)
    if (r) setNotice(`The invite for ${i.email} is cancelled. Its link no longer works.`)
  }

  if (data === 'missing') return <Unavailable />
  return (
    <main className="home">
      <header className="home-bar">
        <IconButton label="Back to settings" onClick={() => navigate(`/t/${tournamentId}/settings`)}>{backIcon}</IconButton>
        <h1 className="title home-title">Co-organisers</h1>
      </header>
      <div className="home-panel co-organisers">
        <p role="status" className="body">{notice}</p>
        <Problem text={problem?.at === 'list' ? problem.text : null} />
        {loadError ? (
          <>
            <Problem text={loadError} />
            <SecondaryButton label="Try loading again" onClick={() => (setLoadError(null), setAttempt((n) => n + 1))} />
          </>
        ) : !data ? (
          <p className="body" aria-busy="true">Loading the organisers…</p>
        ) : (
          <>
            <section>
              <h2 className="body-strong">Organisers</h2>
              <ul className="cards">
                {data.organisers.map((o) => (
                  <li key={o.userId} className="card">
                    <p className="body">{o.email}{o.userId === session?.id && ' (you)'}</p>
                    {o.userId === session?.id ? (
                      <DestructiveButton label="Leave this tournament" sheetTitle="Leave this tournament?" before="You organise this tournament"
                        after="You can't see or change it unless you're invited again" actionLabel="Leave this tournament" onConfirm={() => void remove(o)} />
                    ) : (
                      <DestructiveButton label="Remove organiser" accessibleLabel={`Remove organiser ${o.email}`} sheetTitle={`Remove ${o.email}?`}
                        before={`${o.email} organises this tournament`} after={`${o.email} can't see or change it`} actionLabel="Remove organiser"
                        onConfirm={() => void remove(o)} />
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h2 className="body-strong">Invites waiting</h2>
              {data.invites.length ? (
                <ul className="cards">
                  {data.invites.map((i) => (
                    <li key={i.id} className="card">
                      <p className="body">{i.email}</p>
                      <p className="meta">Link works until {formatDate(inZone(i.expiresAt).date)}</p>
                      <button type="button" className="ui-button ui-secondary" aria-label={`Share invite link for ${i.email}`}
                        onClick={() => void share(i.email, inviteUrl(i.token))}>Share invite link</button>
                      <DestructiveButton label="Cancel invite" accessibleLabel={`Cancel invite for ${i.email}`} sheetTitle={`Cancel the invite for ${i.email}?`}
                        before="The link lets them join" after="The link stops working" actionLabel="Cancel invite" onConfirm={() => void cancel(i)} />
                    </li>
                  ))}
                </ul>
              ) : <p className="body">No invites waiting.</p>}
            </section>
          </>
        )}
        <section>
          <h2 className="body-strong">Invite a co-organiser</h2>
          <p className="body">
            A co-organiser can see and change everything in this tournament, and nothing in your other tournaments. They
            join by opening the invite link and signing in with this email.
          </p>
          <form key={formKey} ref={ref} noValidate onSubmit={(e) => (e.preventDefault(), void invite())}>
            <Field label="Their email" name="invite-email" type="email" inputMode="email" autoComplete="off" value="" onSave={noop}
              required requiredMessage="Add the email to invite." validate={checkEmail} showErrors={showErrors} />
            <Problem text={problem?.at === 'form' ? problem.text : null} />
            <PrimaryButton label="Send invite" onClick={() => void invite()} {...blocked(busy && 'Making the invite…')} />
          </form>
          {made && (
            <div className="card invite-made">
              <label className="body-strong" htmlFor="invite-link">Invite link for {made.email}</label>
              <input id="invite-link" className="ui-input" readOnly value={made.link} onFocus={(e) => e.currentTarget.select()} />
              <SecondaryButton label="Share invite link" onClick={() => void share(made.email, made.link)} />
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
