import { useId } from 'react'
import { Sheet } from './Sheet'
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

/** States the change as before → after; a destructive one opens with focus on Cancel. */
export function ConfirmSheet({ open, title, before, after, actionLabel, destructive, onConfirm, onClose }: ConfirmSheetProps) {
  const changeId = useId()
  return (
    <Sheet open={open} title={title} describedBy={changeId} onClose={onClose}>
      {({ close }) => (
        <>
          <p id={changeId} className="body-strong ui-sheet-change">
            {before} <span aria-hidden="true">→</span>
            <span className="ui-visually-hidden"> to</span> {after}
          </p>
          <div className="ui-sheet-actions">
            <button type="button" className="ui-button ui-primary" onClick={() => {
              try {
                onConfirm()
              } finally {
                close()
              }
            }}>
              {actionLabel}
            </button>
            <button type="button" className="ui-button ui-secondary" data-autofocus={destructive || undefined} onClick={close}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Sheet>
  )
}
