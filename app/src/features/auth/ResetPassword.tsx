import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { requestPasswordReset, setNewPassword, verifyRecoveryOtp } from '../../domain/auth'
import { messages } from '../../domain/messages'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { blocked, checkCode, checkEmail, checkPassword, noop, useForm } from './form'
import { Problem, Screen } from './Screen'
import { useSession } from './session'
import { Turnstile } from './Turnstile'

// Reached from Forgot password (enter the code) or from the emailed recovery link (AuthCallback passes recovery).
export function ResetPassword() {
  const navigate = useNavigate()
  const session = useSession()
  const state = useLocation().state as { email?: string; recovery?: boolean } | null
  const known = state?.email || ''
  const { ref, showErrors, values } = useForm()
  const [token, setToken] = useState<string | null>(null)
  const [widget, setWidget] = useState(0)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [badCode, setBadCode] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  // True once the code was accepted here, so a failed password save doesn't ask for the used code again.
  const [codeOk, setCodeOk] = useState(false)

  if (session === undefined) {
    return (
      <main className="screen" aria-busy="true">
        <p className="body">Loading…</p>
      </main>
    )
  }
  const needsCode = !(session && (state?.recovery || codeOk))

  async function submit() {
    const v = values()
    if (!v || busy) return
    setBusy(true)
    setError(null)
    setSent(null)
    if (needsCode) {
      const failure = await verifyRecoveryOtp(known || v.email!, v['one-time-code']!)
      if (failure) {
        setBusy(false)
        setBadCode(failure.code === 'otp_expired' || failure.code === 'session_missing')
        return setError(failure.message)
      }
      setCodeOk(true)
    }
    const failure = await setNewPassword(v['new-password']!)
    setBusy(false)
    if (!failure) return navigate('/', { replace: true })
    setBadCode(failure.code === 'session_missing')
    setError(failure.message)
  }

  async function resend() {
    if (sending || token === null) return
    const email = known || ref.current?.querySelector<HTMLInputElement>('input[autocomplete="email"]')?.value.trim() || ''
    if (checkEmail(email)) return void values()
    setSending(true)
    setError(null)
    setSent(null)
    const failure = await requestPasswordReset(email, token)
    setSending(false)
    setToken(null)
    setWidget((n) => n + 1)
    if (failure) return setError(failure.message)
    setBadCode(false)
    setCodeOk(false)
    setSent(`We sent a new code to ${email}.`)
  }

  const showCode = needsCode || badCode
  const resendBlocked = sending ? null : token === null ? messages.captcha_wait : null
  return (
    <Screen title="Choose a new password">
      {showCode && (
        <p className="body">
          Enter the code we sent{known ? <> to <strong>{known}</strong></> : ''}, or tap the link in the same email.
        </p>
      )}
      <form ref={ref} noValidate onSubmit={(e) => (e.preventDefault(), void submit())}>
        {showCode && !known && (
          <Field label="Email" type="email" autoComplete="email" inputMode="email" value="" onSave={noop}
            required validate={checkEmail} showErrors={showErrors} />
        )}
        {needsCode && (
          <Field label="Code" autoComplete="one-time-code" inputMode="numeric" value="" onSave={noop}
            required validate={checkCode} showErrors={showErrors} />
        )}
        <Field label="New password" type="password" autoComplete="new-password" value="" onSave={noop}
          required validate={checkPassword} showErrors={showErrors} />
        <Problem text={error} />
        <p role="status" className="body">{sent}</p>
        <PrimaryButton label="Save new password" onClick={() => void submit()} {...blocked(busy && 'Saving…')} />
        {showCode && <Turnstile key={widget} onToken={setToken} quiet />}
        {badCode && (
          <>
            <SecondaryButton label={sending ? 'Sending…' : 'Send a new code'} onClick={() => void resend()} />
            {resendBlocked && <p className="meta">{resendBlocked}</p>}
          </>
        )}
      </form>
    </Screen>
  )
}
