import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { isLinkType, verifyLink } from '../../domain/auth'
import { messages } from '../../domain/messages'
import { PrimaryButton } from '../../ui/Button'
import { Problem, Screen } from './Screen'
import { useSession } from './session'

// The emailed link lands here: /auth/callback?token_hash=…&type=signup|email|recovery
export function AuthCallback() {
  const navigate = useNavigate()
  const session = useSession()
  const [params] = useSearchParams()
  const hash = params.get('token_hash')
  const type = params.get('type')
  const valid = !!hash && isLinkType(type)
  const [failed, setFailed] = useState<'offline' | 'bad_link' | null>(null)
  const [attempt, setAttempt] = useState(0)
  // A link works once: verify each attempt only once (StrictMode runs effects twice in development).
  const done = useRef(-1)

  useEffect(() => {
    if (!valid || done.current === attempt) return
    done.current = attempt
    void verifyLink(hash, type).then((failure) => {
      if (!failure) navigate(type === 'recovery' ? '/reset-password' : '/', { replace: true, state: { recovery: type === 'recovery' } })
      else setFailed(failure.code === 'offline' ? 'offline' : 'bad_link')
    })
  }, [valid, hash, type, navigate, attempt])

  const problem = valid ? failed : 'bad_link'
  // An already-used verify link while already signed in and verified: nothing left to do.
  if (problem === 'bad_link' && type !== 'recovery' && session?.verified) return <Navigate to="/" replace />
  return (
    <Screen title={problem ? 'Link not working' : 'Checking your link'}>
      {problem === 'offline' ? (
        <>
          <Problem text={messages.offline} />
          <PrimaryButton label="Try again" onClick={() => (setFailed(null), setAttempt((n) => n + 1))} />
        </>
      ) : problem ? (
        <>
          <Problem text={messages.bad_link} />
          <PrimaryButton label="Send a new code"
            onClick={() => navigate(type === 'recovery' ? '/forgot-password' : '/check-email', { replace: true })} />
        </>
      ) : (
        <p className="body" aria-busy="true">Checking your link…</p>
      )}
    </Screen>
  )
}
