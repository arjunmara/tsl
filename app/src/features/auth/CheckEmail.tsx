import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { checkVerified, resendSignupCode, verifyEmailOtp } from '../../domain/auth'
import { messages } from '../../domain/messages'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { blocked, checkCode, checkEmail, noop, useForm } from './form'
import { Problem, Screen } from './Screen'
import { useSession } from './session'
import { Turnstile } from './Turnstile'

export function CheckEmail() {
  const navigate = useNavigate()
  const session = useSession()
  const known = (useLocation().state as { email?: string } | null)?.email || session?.email || ''
  const { ref, showErrors, values } = useForm()
  const [token, setToken] = useState<string | null>(null)
  const [widget, setWidget] = useState(0)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  // Verified with the link on another device: coming back to this tab picks it up.
  useEffect(() => {
    const check = async () => {
      if (document.visibilityState === 'visible' && (await checkVerified()) === 'verified') navigate('/', { replace: true })
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [navigate])

  async function verified() {
    setError(null)
    setSent(null)
    const state = await checkVerified()
    if (state === 'verified') navigate('/', { replace: true })
    else if (state === 'none') navigate('/sign-in')
    else setError(messages.not_verified_yet)
  }

  async function verify() {
    const v = values()
    if (!v || busy) return
    setBusy(true)
    setError(null)
    setSent(null)
    const failure = await verifyEmailOtp(known || v.email!, v['one-time-code']!)
    setBusy(false)
    if (!failure) return navigate('/', { replace: true })
    setError(failure.message)
  }

  async function resend() {
    if (sending || token === null) return
    const email = known || ref.current?.querySelector<HTMLInputElement>('input[autocomplete="email"]')?.value.trim() || ''
    if (checkEmail(email)) return void values()
    setSending(true)
    setError(null)
    setSent(null)
    const failure = await resendSignupCode(email, token)
    setSending(false)
    setToken(null)
    setWidget((n) => n + 1)
    if (failure) setError(failure.message)
    else setSent(`We sent a new code to ${email}.`)
  }

  // SecondaryButton has no disabled state: the click is ignored and the reason shown instead.
  const resendBlocked = sending ? null : token === null ? messages.captcha_wait : null
  return (
    <Screen title="Check your email">
      <p className="body">
        {known ? <>We sent a code to <strong>{known}</strong>.</> : 'We sent a code to your email.'} Enter it here, or tap
        the link in the same email. Either one works.
      </p>
      <form ref={ref} noValidate onSubmit={(e) => (e.preventDefault(), void verify())}>
        {!known && (
          <Field label="Email" type="email" autoComplete="email" inputMode="email" value="" onSave={noop}
            required validate={checkEmail} showErrors={showErrors} />
        )}
        <Field label="Code" autoComplete="one-time-code" inputMode="numeric" value="" onSave={noop}
          required validate={checkCode} showErrors={showErrors} />
        <Problem text={error} />
        <p role="status" className="body">{sent}</p>
        <PrimaryButton label="Verify email" onClick={() => void verify()} {...blocked(busy && 'Checking the code…')} />
        <SecondaryButton label="I've verified my email" onClick={() => void verified()} />
        <Turnstile key={widget} onToken={setToken} quiet />
        <SecondaryButton label={sending ? 'Sending…' : 'Send a new code'} onClick={() => void resend()} />
        {resendBlocked && <p className="meta">{resendBlocked}</p>}
      </form>
    </Screen>
  )
}
