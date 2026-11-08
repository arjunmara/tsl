import { useId, useState } from 'react'
import { SecondaryButton } from './Button'
import './components.css'

export type SaveState = 'saving' | 'saved' | 'offline' | 'failed'

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'} waiting to send`
const words = (state: SaveState, count: number) =>
  ({
    saving: count ? `Saving… · ${changes(count)}` : 'Saving…',
    saved: 'Saved',
    offline: `Offline · ${changes(count)}. They'll send when the signal is back.`,
    failed: "Couldn't save",
  })[state]

/**
 * Dot plus words, never icon-only; null state shows nothing. The polite live region and the alert region
 * stay mounted so screen readers hear each change. Tapping lists the waiting changes (items, in plain words).
 */
export function SaveStatus({ state, count, items, onRetry }: { state: SaveState | null; count: number; items: string[]; onRetry: () => void }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const body = state && (
    items.length ? (
      <button type="button" className="ui-save-toggle body-strong" aria-expanded={open}
        aria-controls={open ? listId : undefined} onClick={() => setOpen((o) => !o)}>
        <span className="ui-save-dot" aria-hidden="true" />
        {words(state, count)}
      </button>
    ) : (
      <p className="ui-save-toggle body-strong">
        <span className="ui-save-dot" aria-hidden="true" />
        {words(state, count)}
      </p>
    )
  )
  return (
    <div className={state ? `ui-save ui-save-${state}` : 'ui-save'}>
      <div aria-live="polite">{state !== 'failed' && body}</div>
      <div role="alert">{state === 'failed' && body}</div>
      {state === 'failed' && <SecondaryButton label="Try saving again" onClick={onRetry} />}
      {state && open && items.length > 0 && (
        <ul id={listId} className="ui-save-list body" aria-label="Changes waiting to send">
          {items.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
      )}
    </div>
  )
}
