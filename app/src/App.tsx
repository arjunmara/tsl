import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
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

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <SaveStatusBar />
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  )
}
