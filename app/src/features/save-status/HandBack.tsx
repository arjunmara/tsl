import { useEffect, useId, useRef, useState } from 'react'
import { discard, resend, sendMine, type OutboxEntry } from '../../domain/commands'
import { formatDate, inZone } from '../../domain/format'
import { messageFor, messages } from '../../domain/messages'
import { Sheet } from '../../ui/Sheet'
import { fieldLabels, labelFor } from './labels'

/** "10:00, Tuesday · Kartik 24, 2083 BS (10 Nov 2026)" in Kathmandu time. */
const when = (ts: string) => {
  const z = inZone(ts)
  return `${z.time}, ${formatDate(z.date)}`
}
const DATES = new Set(['starts_on', 'ends_on', 'registration_deadline'])
/** A field's value in words: dates in BS and AD, like every date the app shows; nothing set as "Not set". */
const show = (k: string, v: unknown) =>
  v == null || v === '' ? 'Not set' : typeof v !== 'string' ? JSON.stringify(v) : DATES.has(k) ? formatDate(v) || v : v

/**
 * The hand-back sheet: the user's choice for each refused change, oldest first, one at a time.
 * A conflict offers "Keep their version" / "Send my version"; any other refusal "Try sending again" /
 * "Discard this change" (confirmed in the same sheet, never a second one). Closing without choosing keeps every change.
 */
export function HandBack({ open, entries, onClose }: { open: boolean; entries: OutboxEntry[]; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState<number | undefined>()
  const cancel = useRef<HTMLButtonElement>(null)
  const bodyId = useId()
  const e = entries[0]
  // A different change on show starts from its first step.
  if (e?.seq !== shown) {
    setShown(e?.seq)
    setConfirming(false)
    setError(null)
  }
  useEffect(() => {
    if (confirming) cancel.current?.focus()
  }, [confirming])
  const label = e ? labelFor(e.name, e.args) : ''
  const kind = e?.state === 'conflict' ? 'Someone else changed this first' : "This change wasn't saved"
  const many = entries.length > 1
  const title = !e ? '' : confirming ? `Discard "${label}"?` : many ? 'Review refused changes' : kind

  return (
    <Sheet open={open && !!e} title={title} describedBy={bodyId} onClose={() => (setConfirming(false), setError(null), onClose())}>
      {({ close, focusHeading }) => {
        if (!e) return null
        // After a choice: the next refused change (focus on the heading), or close when this was the last.
        // A failed choice keeps the sheet open and says so.
        const choose = async (act: () => Promise<void>) => {
          setError(null)
          try {
            await act()
          } catch {
            setError(messages.unknown)
            return
          }
          setConfirming(false)
          if (entries.length <= 1) close()
          else focusHeading()
        }
        const problem = error && <p role="alert" className="body-strong">{error}</p>
        if (confirming) return (
          <>
            <p id={bodyId} className="body ui-sheet-change">It won't be saved. This is logged.</p>
            {problem}
            <div className="ui-sheet-actions">
              <button type="button" className="ui-button ui-secondary ui-destructive"
                onClick={() => void choose(() => discard(e.seq, e.code ?? 'unknown'))}>
                Discard this change
              </button>
              <button ref={cancel} type="button" className="ui-button ui-secondary" onClick={() => {
                setConfirming(false)
                focusHeading()
              }}>
                Cancel
              </button>
            </div>
          </>
        )
        const intro = (
          <>
            {many && <p className="body-strong">{kind}</p>}
            <p className="body-strong">{label}</p>
          </>
        )
        if (e.state === 'conflict' && e.conflict) {
          const c = e.conflict
          const fields = Object.keys(e.args).filter((k) =>
            k !== 'expected_version' && Object.hasOwn(c.current, k) && show(k, e.args[k]) !== show(k, c.current[k]))
          const column = (name: string, values: Record<string, unknown>) => (
            <section className="handback-col">
              <h3 className="body-strong">{name}</h3>
              <dl>
                {fields.map((k) => (
                  <div key={k}>
                    <dt className="meta">{fieldLabels[k] ?? k}</dt>
                    <dd className="body handback-value">{show(k, values[k])}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )
          return (
            <>
              <div id={bodyId} className="ui-sheet-change">
                {intro}
                {fields.length ? (
                  <div className="handback-cols">
                    {column('Your change', e.args)}
                    {column('Their version', c.current)}
                  </div>
                ) : (
                  <p className="body">Nothing you changed differs from their version.</p>
                )}
                <p className="meta">Changed by {c.changed_by?.trim() || 'someone'} at {when(c.changed_at)}</p>
              </div>
              {problem}
              <div className="ui-sheet-actions">
                <button type="button" className="ui-button ui-primary" onClick={() => void choose(() => discard(e.seq, 'kept_theirs'))}>
                  Keep their version
                </button>
                <button type="button" className="ui-button ui-secondary" onClick={() => void choose(() => sendMine(e.seq))}>
                  Send my version
                </button>
                <button type="button" className="ui-button ui-secondary" onClick={close}>
                  Close without choosing
                </button>
              </div>
            </>
          )
        }
        return (
          <>
            <div id={bodyId} className="ui-sheet-change">
              {intro}
              <p className="body">{messageFor(e.code ?? null)}</p>
            </div>
            {problem}
            <div className="ui-sheet-actions">
              <button type="button" className="ui-button ui-primary" onClick={() => void choose(() => resend(e.seq))}>
                Try sending again
              </button>
              <button type="button" className="ui-button ui-secondary ui-destructive" onClick={() => setConfirming(true)}>
                Discard this change
              </button>
              <button type="button" className="ui-button ui-secondary" onClick={close}>
                Close without choosing
              </button>
            </div>
          </>
        )
      }}
    </Sheet>
  )
}
