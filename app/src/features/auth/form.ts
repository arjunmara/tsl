import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { focusFirstInvalid } from '../../ui/Field'
import { messages } from '../../domain/messages'

export const noop = () => {}
export const checkEmail = (v: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : messages.email_format)
export const checkPassword = (v: string) => (v.length >= 8 ? null : messages.password_short)
export const checkCode = (v: string) => (/^\d{6,10}$/.test(v) ? null : messages.code_format)

// Field saves on blur, but a password manager can fill a field that never blurs,
// so forms read the inputs themselves at submit, keyed by name, else by autocomplete.
export function useForm() {
  const ref = useRef<HTMLFormElement>(null)
  const [showErrors, setShowErrors] = useState(false)
  /** Shows field problems and focuses the first; returns null then, else the values. */
  function values(): Record<string, string> | null {
    flushSync(() => setShowErrors(true))
    const form = ref.current
    if (!form || focusFirstInvalid(form)) return null
    return Object.fromEntries(
      [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].map((i) => [i.name || i.autocomplete, i.type === 'password' ? i.value : i.value.trim()]),
    )
  }
  return { ref, showErrors, values }
}

/** PrimaryButton props: disabled with a reason while busy or blocked. */
export function blocked(reason: string | false) {
  return reason ? ({ disabled: true, disabledReason: reason } as const) : {}
}
