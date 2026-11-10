import { useId, useState, type ChangeEvent, type HTMLAttributes } from 'react'
import './components.css'

export type FieldProps = {
  label: string
  value: string
  onSave: (value: string) => void
  /** Returns the problem in words, or null when the value is fine. */
  validate?: (value: string) => string | null
  required?: boolean
  /** The words shown when a required field is empty; default "<label> is required." */
  requiredMessage?: string
  /** Set by the parent on Next so untouched required fields show their message. */
  showErrors?: boolean
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode']
  type?: 'text' | 'email' | 'password' | 'date'
  autoComplete?: string
  name?: string
  /** A multi-line text box (rules, statements). */
  multiline?: boolean
  /** Bounds for a date field, YYYY-MM-DD. */
  min?: string
  max?: string
  /** Words shown under the field for its current value, e.g. a date in BS and AD; null shows nothing. */
  hint?: (value: string) => string | null
}

// Saves on blur, only when the value changed and is valid. No page Save button.
export function Field({
  label, value, onSave, validate, required, requiredMessage, showErrors, inputMode, type = 'text', autoComplete, name, multiline, min, max, hint,
}: FieldProps) {
  const id = useId()
  const errorId = useId()
  const hintId = useId()
  const [text, setText] = useState(value)
  const [edited, setEdited] = useState(false)
  const [touched, setTouched] = useState(false)
  const [saved, setSaved] = useState(value)
  const [focused, setFocused] = useState(false)
  // A new value from the parent replaces the text, but never while the person is typing.
  const [prop, setProp] = useState(value)
  if (value !== prop && !focused) {
    setProp(value)
    setText(value)
    setSaved(value)
  }

  // Passwords are taken as typed; other fields ignore surrounding spaces.
  const t = type === 'password' ? text : text.trim()
  // An empty optional field is always valid, so it can be cleared.
  const problem = t === '' ? (required ? requiredMessage ?? `${label} is required.` : null) : validate?.(t) ?? null
  const error = touched || showErrors ? problem : null
  const note = t && hint ? hint(t) : null

  function blur() {
    setFocused(false)
    setTouched(edited)
    if (t !== (type === 'password' ? saved : saved.trim()) && !problem) {
      // The person's edit wins over a parent value that arrived while they typed.
      setProp(value)
      setSaved(t)
      onSave(t)
    }
  }

  const Input = multiline ? 'textarea' : 'input'
  return (
    <div className="ui-field">
      <label htmlFor={id} className="body-strong">
        {label}
      </label>
      <Input
        id={id}
        name={name}
        className={multiline ? 'ui-input ui-textarea' : 'ui-input'}
        value={text}
        {...(multiline ? { rows: 4 } : { type, min, max })}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={[note && hintId, error && errorId].filter(Boolean).join(' ') || undefined}
        onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
          setText(e.target.value)
          setEdited(true)
        }}
        onFocus={() => setFocused(true)}
        onBlur={blur}
      />
      {note && (
        <p id={hintId} className="meta">
          {note}
        </p>
      )}
      {error && (
        <p id={errorId} className="meta ui-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** Focuses the first invalid field in container. Call after the render that set showErrors. */
export function focusFirstInvalid(container: ParentNode): boolean {
  const el = container.querySelector<HTMLElement>('[aria-invalid="true"]')
  el?.focus()
  return !!el
}
