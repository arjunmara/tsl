import { useState } from 'react'
import { useNavigate } from 'react-router'
import { signOut } from '../../domain/auth'
import { SecondaryButton } from '../../ui/Button'
import { dropInvite } from '../auth/Invite'
import { applyTheme, currentTheme, type Theme } from './theme'

const themes: [Theme, string][] = [['device', 'Same as this phone'], ['light', 'Light'], ['dark', 'Dark']]

export function AccountMenu({ email }: { email: string }) {
  const navigate = useNavigate()
  const [theme, setTheme] = useState(currentTheme)

  return (
    <details className="account">
      <summary className="body-strong">Account</summary>
      <div className="account-panel">
        <p className="body">{email}</p>
        <fieldset className="choices">
          <legend className="body-strong">Theme</legend>
          {themes.map(([value, label]) => (
            <label key={value} className="choice body">
              <input type="radio" name="theme" value={value} checked={theme === value}
                onChange={() => (applyTheme(value), setTheme(value))} />
              {label}
            </label>
          ))}
        </fieldset>
        <SecondaryButton label="Sign out" onClick={async () => {
          await signOut()
          dropInvite()
          navigate('/sign-in', { replace: true })
        }} />
      </div>
    </details>
  )
}
