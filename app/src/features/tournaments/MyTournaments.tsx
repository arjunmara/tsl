import { useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { messages } from '../../domain/messages'
import { PrimaryButton } from '../../ui/Button'
import { useSession } from '../auth/session'
import { AccountMenu } from './AccountMenu'

function subscribe(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}
const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine)

// ponytail: no tournament list yet (Story 1.6 adds tournaments); skeletons show while the session resolves.
export function MyTournaments() {
  const navigate = useNavigate()
  const session = useSession()
  const online = useOnline()
  return (
    <main className="screen">
      <div className="app-bar">
        <h1 className="title">My tournaments</h1>
        <AccountMenu email={session?.email ?? ''} />
      </div>
      {!online && <p role="status" className="banner body-strong">{messages.offline_banner}</p>}
      <div className="empty">
        <p className="body-strong">No tournaments yet.</p>
        <PrimaryButton label="New tournament" onClick={() => navigate('/new')} />
      </div>
    </main>
  )
}
