import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import './components.css'

export type SheetControls = { close: () => void; focusHeading: () => void }

export type SheetProps = {
  open: boolean
  title: string
  /** id of the element describing the sheet, if any. */
  describedBy?: string
  onClose: () => void
  /** The sheet's body; close() closes it, returns focus to the opener and calls onClose once. */
  children: (sheet: SheetControls) => ReactNode
}

// Bottom sheet on the native <dialog>: showModal() gives the backdrop, the inert page and Escape.
// On open, focus goes to the element marked data-autofocus, else the heading.
export function Sheet({ open, title, describedBy, onClose, children }: SheetProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  // True from showModal() until finish(): onClose fires exactly once per open.
  const shown = useRef(false)
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
      ;(d.querySelector<HTMLElement>('[data-autofocus]') ?? heading.current)?.focus()
    } else if (!open && d.open) {
      // Parent closed it: no onClose back, and the late close event must not move focus.
      shown.current = false
      opener.current = null
      d.close()
    }
  }, [open])

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
  // Stable, and they read the refs only when called (from event handlers).
  const [controls] = useState<SheetControls>(() => ({
    close: () => finishRef.current(),
    focusHeading: () => heading.current?.focus(),
  }))
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

  return (
    <dialog ref={dialog} className="ui-sheet" aria-labelledby={titleId}
      aria-describedby={describedBy}
      onKeyDown={trap}
      onCancel={(e) => {
        e.preventDefault()
        finish()
      }}
    >
      <h2 ref={heading} id={titleId} className="title ui-sheet-title" tabIndex={-1}>
        {title}
      </h2>
      {children(controls)}
    </dialog>
  )
}
