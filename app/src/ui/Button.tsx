import { useId, useState, type ReactNode } from 'react'
import { ConfirmSheet } from './ConfirmSheet'
import './components.css'

type Click = { label: string; onClick?: () => void }

// A disabled Primary always says why, in words, beneath it.
export type PrimaryButtonProps = Click & ({ disabled?: false } | { disabled: true; disabledReason: string })

export function PrimaryButton(props: PrimaryButtonProps) {
  const reasonId = useId()
  const reason = props.disabled ? props.disabledReason : null
  return (
    <div className="ui-primary-wrap">
      <button
        type="button"
        className="ui-button ui-primary"
        disabled={props.disabled}
        aria-describedby={reason ? reasonId : undefined}
        onClick={props.onClick}
      >
        {props.label}
      </button>
      {reason && (
        <p id={reasonId} className="meta ui-reason">
          {reason}
        </p>
      )}
    </div>
  )
}

export function SecondaryButton({ label, onClick }: Click) {
  return (
    <button type="button" className="ui-button ui-secondary" onClick={onClick}>
      {label}
    </button>
  )
}

export type DestructiveButtonProps = {
  label: string
  sheetTitle: string
  before: string
  after: string
  actionLabel: string
  onConfirm: () => void
}

// No plain onClick: a destructive action always goes through a Confirm sheet.
export function DestructiveButton({ label, sheetTitle, before, after, actionLabel, onConfirm }: DestructiveButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="ui-button ui-secondary ui-destructive" onClick={() => setOpen(true)}>
        {label}
      </button>
      <ConfirmSheet
        open={open}
        title={sheetTitle}
        before={before}
        after={after}
        actionLabel={actionLabel}
        destructive
        onConfirm={onConfirm}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/** An icon-only button: its action is in the accessible name. children: the SVG's paths (24×24, drawn in currentColor). */
export function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="ui-button ui-secondary icon-button" aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeLinejoin="round" aria-hidden="true">{children}</svg>
    </button>
  )
}
export const backIcon = <path d="M15 5l-7 7 7 7" />
