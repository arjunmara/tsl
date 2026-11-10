import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { requestPasswordReset } from '../../domain/auth'
import { messages } from '../../domain/messages'
import { PrimaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { blocked, checkEmail, noop, useForm } from './form'
import { Problem, Screen } from './Screen'
import { Turnstile } from './Turnstile'

export function ForgotPassword() {
  const navigate = useNavigate()
  const { ref, showErrors, values } = useForm()
  const [token, setToken] = useState<string | null>(null)
  const [widget, setWidget] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const v = values()
    if (!v || busy) return
    setBusy(true)
    setError(null)
    const failure = await requestPasswordReset(v.email!, token ?? undefined)
    setBusy(false)
    if (!failure) return navigate('/reset-password', { state: { email: v.email } })
    setError(failure.message)
    setToken(null)
    setWidget((n) => n + 1)
  }

  return (
    <Screen title="Reset your password">
      <p className="body">We'll email you a code and a link. Either one lets you choose a new password.</p>
      <form ref={ref} noValidate onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="Email" type="email" autoComplete="email" inputMode="email" value="" onSave={noop}
          required validate={checkEmail} showErrors={showErrors} />
        <Turnstile key={widget} onToken={setToken} quiet />
        <Problem text={error} />
        <PrimaryButton label="Email me a reset code" onClick={() => void submit()} {...blocked(busy ? 'Sending…' : token === null && messages.captcha_wait)} />
      </form>
      <p className="body"><Link to="/sign-in">Back to sign in</Link></p>
    </Screen>
  )
}
