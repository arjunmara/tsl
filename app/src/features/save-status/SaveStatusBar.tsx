import { useEffect, useState } from 'react'
import { useOutbox } from '../../domain/commands'
import { messageFor } from '../../domain/messages'
import { SaveStatus, type SaveState } from '../../ui/SaveStatus'
import { useOnline } from '../app/online'
import { labelFor } from './labels'

/** The page header's Save status for the signed-in user: shown only while changes wait or fail, then "Saved" briefly. */
export function SaveStatusBar() {
  const { entries, sending, retry } = useOutbox()
  const online = useOnline()
  const pending = entries.filter((e) => e.state === 'pending').length
  const busy = sending || entries.length > 0
  const [wasBusy, setWasBusy] = useState(busy)
  const [saved, setSaved] = useState(false)
  if (busy !== wasBusy) {
    setWasBusy(busy)
    setSaved(!busy)
  }
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 3000)
    return () => clearTimeout(t)
  }, [saved])

  const state: SaveState | null = entries.some((e) => e.state === 'failed') ? 'failed'
    : pending && !online ? 'offline' : pending || sending ? 'saving' : saved ? 'saved' : null
  const items = entries.map((e) => labelFor(e.name, e.args) + (e.state === 'failed' ? ` · ${messageFor(e.code ?? null)}` : ''))
  return (
    <header className={state ? 'save-bar' : 'save-bar save-bar-empty'}>
      <SaveStatus state={state} count={pending} items={items} onRetry={() => void retry()} />
    </header>
  )
}
