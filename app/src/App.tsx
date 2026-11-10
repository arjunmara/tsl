import { Component, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import { reportError } from './domain/report'
import { AuthCallback } from './features/auth/AuthCallback'
import { CheckEmail } from './features/auth/CheckEmail'
import { ForgotPassword } from './features/auth/ForgotPassword'
import { ResetPassword } from './features/auth/ResetPassword'
import { RequireSession, RequireVerified, SessionProvider } from './features/auth/session'
import { SignIn } from './features/auth/SignIn'
import { SignUp } from './features/auth/SignUp'
import { MyTournaments } from './features/tournaments/MyTournaments'
import { NewTournament } from './features/tournaments/NewTournament'
import { SaveStatusBar } from './features/save-status/SaveStatusBar'
import { PrimaryButton } from './ui/Button'

/** Catches a render error in the screen below, reports it and offers a reload. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    reportError(error)
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="screen">
        <p role="alert" className="body-strong">Something went wrong on this screen.</p>
        <PrimaryButton label="Reload this page" onClick={() => location.reload()} />
      </main>
    )
  }
}

/** The boundary starts afresh on every navigation, so another screen works again. */
function ScreenBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary key={useLocation().pathname}>{children}</ErrorBoundary>
}

// /__crash throws, to check error reporting: only in dev or with ?crashtest. The fake email and number
// in its message must not reach the log.
const crashTest = import.meta.env.DEV || new URLSearchParams(location.search).has('crashtest')
function Crash(): ReactNode {
  throw new Error('Test crash from /__crash for test@example.com, 9800000001')
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <SaveStatusBar />
        <ScreenBoundary>
        <Routes>
          <Route path="/sign-up" element={<SignUp />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/check-email" element={<CheckEmail />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route element={<RequireSession />}>
            <Route path="/" element={<MyTournaments />} />
            <Route element={<RequireVerified />}>
              <Route path="/new" element={<NewTournament />} />
            </Route>
          </Route>
          {crashTest && <Route path="/__crash" element={<Crash />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ScreenBoundary>
      </SessionProvider>
    </BrowserRouter>
  )
}
