import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, Outlet } from 'react-router'
import { onSession, type Session } from '../../domain/auth'

// undefined while the stored session is still being read.
const SessionContext = createContext<Session | null | undefined>(undefined)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  useEffect(() => onSession(setSession), [])
  return <SessionContext value={session}>{children}</SessionContext>
}

export const useSession = () => useContext(SessionContext)

/** Signed-in only: skeleton while resolving, else /sign-in. */
export function RequireSession() {
  const session = useSession()
  if (session === undefined) {
    return (
      <main className="screen" aria-busy="true">
        <p className="ui-visually-hidden">Loading</p>
        <ul className="cards">
          {[0, 1, 2].map((i) => <li key={i} className="skeleton-card" />)}
        </ul>
      </main>
    )
  }
  return session ? <Outlet /> : <Navigate to="/sign-in" replace />
}

/** Verified only (inside RequireSession): an unverified account goes to "Check your email". */
export function RequireVerified() {
  const session = useSession()
  return session?.verified ? <Outlet /> : <Navigate to="/check-email" replace state={{ email: session?.email }} />
}
