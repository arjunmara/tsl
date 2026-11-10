import { useEffect, useState } from 'react'
import { useOutbox } from '../../domain/commands'
import { messageFor } from '../../domain/messages'
import { SaveStatus, type SaveState } from '../../ui/SaveStatus'
import { useOnline } from '../app/online'
import { HandBack } from './HandBack'
import { labelFor } from './labels'

/**
 * The page header's Save status for the signed-in user: shown only while changes wait or are refused, then
 * "Saved" briefly. Tapping it lists the changes, refused ones first; the review button opens the hand-back sheet.
 */
export function SaveStatusBar() {
  const { entries, sending } = useOutbox()
  const online = useOnline()
  const [review, setReview] = useState(false)
  const pending = entries.filter((e) => e.state === 'pending').length
  const stopped = entries.filter((e) => e.state !== 'pending')
  if (review && !stopped.length) setReview(false)
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

  const state: SaveState | null = stopped.length ? 'failed'
    : pending && !online ? 'offline' : pending || sending ? 'saving' : saved ? 'saved' : null
  const items = [
    ...stopped.map((e) => `${labelFor(e.name, e.args)} · ${messageFor(e.code ?? null)}`),
    ...entries.filter((e) => e.state === 'pending').map((e) => labelFor(e.name, e.args)),
  ]
  return (
    <header className={state ? 'save-bar' : 'save-bar save-bar-empty'}>
      <SaveStatus state={state} count={pending} items={items}
        reviewLabel={stopped.length > 1 ? 'Review refused changes' : 'Review this change'} onReview={() => setReview(true)} />
      <HandBack open={review} entries={stopped} onClose={() => setReview(false)} />
    </header>
  )
}
