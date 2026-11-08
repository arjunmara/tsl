import { useId, useState, type HTMLAttributes } from 'react'
import './components.css'

export type FieldProps = {
  label: string
  value: string
  onSave: (value: string) => void
  /** Returns the problem in words, or null when the value is fine. */
  validate?: (value: string) => string | null
  required?: boolean
  /** Set by the parent on Next so untouched required fields show their message. */
  showErrors?: boolean
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode']
  type?: 'text' | 'email' | 'password'
  autoComplete?: string
}

// Saves on blur, only when the value changed and is valid. No page Save button.
export function Field({ label, value, onSave, validate, required, showErrors, inputMode, type = 'text', autoComplete }: FieldProps) {
  const id = useId()
  const errorId = useId()
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
  const problem = t === '' ? (required ? `${label} is required.` : null) : validate?.(t) ?? null
  const error = touched || showErrors ? problem : null

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

  return (
    <div className="ui-field">
      <label htmlFor={id} className="body-strong">
        {label}
      </label>
      <input
        id={id}
        className="ui-input"
        value={text}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setText(e.target.value)
          setEdited(true)
        }}
        onFocus={() => setFocused(true)}
        onBlur={blur}
      />
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
