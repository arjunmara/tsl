import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import './components.css'

export type ConfirmSheetProps = {
  open: boolean
  title: string
  before: string
  after: string
  actionLabel: string
  destructive?: boolean
  onConfirm: () => void
  onClose: () => void
}

// Bottom sheet on the native <dialog>: showModal() gives the backdrop, the inert page and Escape.
export function ConfirmSheet({ open, title, before, after, actionLabel, destructive, onConfirm, onClose }: ConfirmSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  // True from showModal() until finish(): onClose fires exactly once per open.
  const shown = useRef(false)
  const changeId = useId()
  const titleId = useId()
  // Latest onClose for the native close event without re-binding it.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  // Layout effect: the sheet opens and takes focus in the same commit, before the next key press.
  useLayoutEffect(() => {
    const d = dialog.current
    if (!d) return
    if (open && !d.open) {
      // Never stack: a sheet requested while another is open does not open.
      if (document.querySelector('dialog[open]')) {
        closeRef.current()
        return
      }
      opener.current = document.activeElement as HTMLElement | null
      shown.current = true
      d.showModal()
      ;(destructive ? cancel.current : heading.current)?.focus()
    } else if (!open && d.open) {
      // Parent closed it: no onClose back, and the late close event must not move focus.
      shown.current = false
      opener.current = null
      d.close()
    }
  }, [open, destructive])

  // Close, return focus to the opener and tell the parent, once. The native close event fires late
  // (a task later), so Cancel, Confirm and Escape call this directly; the event is only the fallback.
  function finish() {
    const d = dialog.current
    if (d?.open) d.close()
    if (!shown.current) return
    shown.current = false
    const o = opener.current
    opener.current = null
    // The opener may be gone (e.g. its row was deleted): fall back to main, else leave focus to the browser.
    if (o?.isConnected) o.focus()
    else document.querySelector<HTMLElement>('main')?.focus()
    closeRef.current()
  }
  const finishRef = useRef(finish)
  useEffect(() => {
    finishRef.current = finish
  })
  useEffect(() => {
    const d = dialog.current
    // A late close event from an earlier close must not shut a sheet that has since reopened.
    const closed = () => {
      if (!d?.open) finishRef.current()
    }
    d?.addEventListener('close', closed)
    return () => d?.removeEventListener('close', closed)
  }, [])

  // Keep Tab inside the sheet: the inert page stops it reaching the page, this stops it leaving to the browser.
  // Escape is handled here too: Chrome's close watcher may skip the cancel event and close late.
  function trap(e: React.KeyboardEvent<HTMLDialogElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      finish()
      return
    }
    if (e.key !== 'Tab') return
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')]
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === heading.current || active === e.currentTarget)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  function confirm() {
    try {
      onConfirm()
    } finally {
      finish()
    }
  }

  return (
    <dialog ref={dialog} className="ui-sheet" aria-labelledby={titleId}
      aria-describedby={changeId}
      onKeyDown={trap}
      onCancel={(e) => {
        e.preventDefault()
        finish()
      }}
    >
      <h2 ref={heading} id={titleId} className="title ui-sheet-title" tabIndex={-1}>
        {title}
      </h2>
      <p id={changeId} className="body-strong ui-sheet-change">
        {before} <span aria-hidden="true">→</span>
        <span className="ui-visually-hidden"> to</span> {after}
      </p>
      <div className="ui-sheet-actions">
        <button type="button" className="ui-button ui-primary" onClick={confirm}>
          {actionLabel}
        </button>
        <button ref={cancel} type="button" className="ui-button ui-secondary" onClick={finish}>
          Cancel
        </button>
      </div>
    </dialog>
  )
}
