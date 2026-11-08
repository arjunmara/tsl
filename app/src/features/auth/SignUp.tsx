import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { signUp } from '../../domain/auth'
import { messages } from '../../domain/messages'
import { PrimaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { blocked, checkEmail, checkPassword, noop, useForm } from './form'
import { Problem, Screen } from './Screen'
import { Turnstile } from './Turnstile'

export function SignUp() {
  const navigate = useNavigate()
  const { ref, showErrors, values } = useForm()
  const [token, setToken] = useState<string | null>(null)
  const [widget, setWidget] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exists, setExists] = useState(false)

  async function submit() {
    const v = values()
    if (!v || token === null || busy) return
    setBusy(true)
    setError(null)
    setExists(false)
    const failure = await signUp(v.email!, v['new-password']!, token)
    setBusy(false)
    if (!failure) return navigate('/check-email', { state: { email: v.email } })
    setError(failure.message)
    setExists(failure.code === 'user_already_exists')
    setToken(null)
    setWidget((n) => n + 1)
  }

  return (
    <Screen title="Create your account">
      <form ref={ref} noValidate onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="Email" type="email" autoComplete="email" inputMode="email" value="" onSave={noop}
          required validate={checkEmail} showErrors={showErrors} />
        <Field label="Password" type="password" autoComplete="new-password" value="" onSave={noop}
          required validate={checkPassword} showErrors={showErrors} />
        <Turnstile key={widget} onToken={setToken} />
        <Problem text={error} />
        {exists && (
          <p className="body"><Link to="/sign-in">Sign in</Link> or <Link to="/forgot-password">reset your password</Link>.</p>
        )}
        <PrimaryButton label="Create account" onClick={() => void submit()}
          {...blocked(busy ? 'Creating your account…' : token === null && messages.captcha_needed)} />
      </form>
      <p className="body">Already have an account? <Link to="/sign-in">Sign in</Link></p>
    </Screen>
  )
}
