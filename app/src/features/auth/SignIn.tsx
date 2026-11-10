import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { signIn } from '../../domain/auth'
import { databaseRef } from '../../domain/env'
import { messages } from '../../domain/messages'
import { PrimaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { EmailCode } from './EmailCode'
import { blocked, checkEmail, noop, useForm } from './form'
import { Problem, Screen } from './Screen'
import { Turnstile } from './Turnstile'

export function SignIn() {
  const navigate = useNavigate()
  const { ref, showErrors, values } = useForm()
  const [token, setToken] = useState<string | null>(null)
  const [widget, setWidget] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const db = databaseRef()

  async function submit() {
    const v = values()
    if (!v || busy) return
    setBusy(true)
    setError(null)
    const failure = await signIn(v.email!, v['current-password']!, token ?? undefined)
    setBusy(false)
    if (!failure) return navigate('/', { replace: true })
    if (failure.code === 'email_not_confirmed') return navigate('/check-email', { state: { email: v.email } })
    setError(failure.message)
    setToken(null)
    setWidget((n) => n + 1)
  }

  return (
    <Screen title="Sign in">
      <form ref={ref} noValidate onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="Email" type="email" autoComplete="email" inputMode="email" value="" onSave={noop}
          required validate={checkEmail} showErrors={showErrors} />
        <Field label="Password" type="password" autoComplete="current-password" value="" onSave={noop}
          required showErrors={showErrors} />
        <Turnstile key={widget} onToken={setToken} quiet />
        <Problem text={error} />
        <PrimaryButton label="Sign in" onClick={() => void submit()} {...blocked(busy ? 'Signing in…' : token === null && messages.captcha_wait)} />
      </form>
      <p className="body"><Link to="/sign-in/code">Email me a sign-in code</Link></p>
      <p className="body"><Link to="/forgot-password">Forgot your password?</Link></p>
      <p className="body">New here? <Link to="/sign-up">Create an account</Link></p>
      <p className="meta">{db ? `Database: ${db}` : 'No database configured'}</p>
    </Screen>
  )
}

/** /sign-in/code: sign in to an existing account with an emailed code instead of the password. */
export function SignInCode() {
  const navigate = useNavigate()
  return (
    <Screen title="Sign in with a code">
      <p className="body">We'll email you a code and a link. Either one signs you in.</p>
      <EmailCode create={false} sendLabel="Email me a sign-in code" verifyLabel="Sign in with this code" verifyingLabel="Signing in…"
        onSignedIn={() => navigate('/', { replace: true })} />
      <p className="body"><Link to="/sign-in">Sign in with a password</Link></p>
    </Screen>
  )
}
