import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { backIcon, IconButton, SecondaryButton } from '../../ui/Button'
import { SaveStatusBar } from '../save-status/SaveStatusBar'
import { STEPS } from '../setup/Frame'
import { SECTIONS, Unavailable, UUID } from '../setup/Setup'
import { readHead } from './Home'

/** /t/:tournamentId/settings: every setup answer, each opening its wizard step as a Settings section. */
export function Settings() {
  const { tournamentId = '' } = useParams()
  if (!UUID.test(tournamentId)) return <><SaveStatusBar /><Unavailable /></>
  return <SettingsList key={tournamentId} tournamentId={tournamentId} />
}

function SettingsList({ tournamentId }: { tournamentId: string }) {
  const navigate = useNavigate()
  // Only a Tournament not on the server (or not the caller's) is refused; offline the list still opens.
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let live = true
    void readHead(tournamentId).then((h) => live && setMissing(h === 'missing'))
    return () => {
      live = false
    }
  }, [tournamentId])
  if (missing) return <><SaveStatusBar /><Unavailable /></>
  return (
    <main className="home">
      <header className="home-bar">
        <IconButton label="Back to tournament home" onClick={() => navigate(`/t/${tournamentId}`)}>{backIcon}</IconButton>
        <h1 className="title home-title">Settings</h1>
        <SaveStatusBar />
      </header>
      <ul className="cards home-list">
        {SECTIONS.map(([k, step, label]) => (
          <li key={k} className="card">
            <h2 className="body-strong">{STEPS[step - 1]}</h2>
            <SecondaryButton label={label} onClick={() => navigate(`/t/${tournamentId}/settings/${k}`, { state: { fromList: true } })} />
          </li>
        ))}
        <li className="card">
          <h2 className="body-strong">Sponsors</h2>
          <p className="meta">Adding Sponsors comes in the next update.</p>
        </li>
      </ul>
    </main>
  )
}
