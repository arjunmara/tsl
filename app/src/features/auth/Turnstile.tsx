import { useEffect, useRef, useState } from 'react'
import { turnstileSiteKey } from '../../domain/env'
import { messages } from '../../domain/messages'

type Api = { render: (el: HTMLElement, options: Record<string, unknown>) => string; remove: (id: string) => void }
declare global {
  interface Window {
    turnstile?: Api
  }
}

let script: Promise<void> | null = null
function load(): Promise<void> {
  script ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      script = null
      s.remove()
      reject(new Error('turnstile'))
    }
    document.head.append(s)
  })
  return script
}

/**
 * Cloudflare Turnstile. onToken gets a token, or null when none is valid (yet). A token works once:
 * remount (change `key`) after using it. Without a site key (local builds) it reports '' at once.
 * quiet: the widget shows only if Cloudflare needs the person to interact. If the hidden widget
 * errors, times out or is unsupported it turns visible; if the visible one fails too, it says so.
 */
export function Turnstile({ onToken, quiet }: { onToken: (token: string | null) => void; quiet?: boolean }) {
  const el = useRef<HTMLDivElement>(null)
  const cb = useRef(onToken)
  useEffect(() => {
    cb.current = onToken
  })
  const [visible, setVisible] = useState(!quiet)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!turnstileSiteKey) {
      cb.current('')
      return
    }
    let live = true
    let id: string | undefined
    const trouble = () => {
      cb.current(null)
      if (!live) return
      if (visible) setFailed(true)
      else setVisible(true)
    }
    load().then(
      () => {
        if (!live || !el.current) return
        if (!window.turnstile) return setFailed(true)
        id = window.turnstile.render(el.current, {
          sitekey: turnstileSiteKey,
          appearance: visible ? 'always' : 'interaction-only',
          callback: (t: string) => cb.current(t),
          'expired-callback': () => cb.current(null),
          'error-callback': trouble,
          'timeout-callback': trouble,
          'unsupported-callback': trouble,
        })
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
      if (id) window.turnstile?.remove(id)
    }
  }, [visible])

  if (!turnstileSiteKey) return null
  if (failed) return <p role="alert" className="body-strong ui-error">{messages.captcha_load}</p>
  return <div ref={el} className={visible ? 'turnstile' : undefined} />
}
