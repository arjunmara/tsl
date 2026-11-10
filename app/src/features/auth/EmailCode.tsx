import { useState } from 'react'
import { emailSignInCode, verifySignInCode } from '../../domain/auth'
import { messages } from '../../domain/messages'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { blocked, checkCode, checkEmail, noop, useForm } from './form'
import { Problem } from './Screen'
import { Turnstile } from './Turnstile'

type Props = {
  /** The address to sign in; without it the person types one. */
  email?: string
  /** Make the account if the email has none. */
  create: boolean
  sendLabel: string
  verifyLabel: string
  verifyingLabel: string
  /** Runs once the code has signed the person in. */
  onSignedIn: () => void
}

/** Sign in with a code emailed to one address: "Email me a code", then the code field and "Send a new code". */
export function EmailCode({ email, create, sendLabel, verifyLabel, verifyingLabel, onSignedIn }: Props) {
  const { ref, showErrors, values } = useForm()
  const [token, setToken] = useState<string | null>(null)
  const [widget, setWidget] = useState(0)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // First send and "Send a new code": one request at a time, each with a fresh captcha token.
  async function send(again: boolean) {
    if (sending || token === null) return
    const to = sentTo ?? email ?? values()?.email
    if (!to) return
    setSending(true)
    setError(null)
    setNote(null)
    const failure = await emailSignInCode(to, create, token)
    setSending(false)
    setToken(null)
    setWidget((n) => n + 1)
    if (failure) return setError(failure.message)
    setSentTo(to)
    if (again) setNote(`We sent a new code to ${to}.`)
  }

  async function verify() {
    const v = values()
    if (!v || busy || !sentTo) return
    setBusy(true)
    setError(null)
    setNote(null)
    const failure = await verifySignInCode(sentTo, v['one-time-code']!)
    setBusy(false)
    if (failure) return setError(failure.message)
    onSignedIn()
  }

  const captcha = token === null && messages.captcha_wait
  return (
    <form ref={ref} noValidate onSubmit={(e) => (e.preventDefault(), void (sentTo ? verify() : send(false)))}>
      {!sentTo ? (
        <>
          {!email && (
            <Field label="Email" type="email" autoComplete="email" inputMode="email" value="" onSave={noop}
              required validate={checkEmail} showErrors={showErrors} />
          )}
          <Turnstile key={widget} onToken={setToken} quiet />
          <Problem text={error} />
          <PrimaryButton label={sendLabel} onClick={() => void send(false)} {...blocked(sending ? 'Sending…' : captcha)} />
        </>
      ) : (
        <>
          <p className="body">We sent a code to <strong>{sentTo}</strong>. Enter it here, or tap the link in the same email.</p>
          <Field label="Code" autoComplete="one-time-code" inputMode="numeric" value="" onSave={noop}
            required validate={checkCode} showErrors={showErrors} />
          <Problem text={error} />
          <p role="status" className="body">{note}</p>
          <PrimaryButton label={verifyLabel} onClick={() => void verify()} {...blocked(busy && verifyingLabel)} />
          <Turnstile key={widget} onToken={setToken} quiet />
          {/* SecondaryButton has no disabled state: the click is ignored and the reason shown instead. */}
          <SecondaryButton label={sending ? 'Sending…' : 'Send a new code'} onClick={() => void send(true)} />
          {!sending && captcha && <p className="meta">{captcha}</p>}
          {!email && <SecondaryButton label="Use another email" onClick={() => !sending && (setSentTo(null), setError(null), setNote(null))} />}
        </>
      )}
    </form>
  )
}
