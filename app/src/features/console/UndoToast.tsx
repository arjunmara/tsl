import { useEffect, useRef, useState } from 'react'

/**
 * The toast after a goal or another event (Story 4.4, 4.5): no backdrop, takes no focus, goes after 8 seconds unless the mouse is over it, a finger is on it or the
 * keyboard focus is in it. A newer goal replaces it (the parent keys it by the goal). No "Add assist" for an own goal or an event that is not a goal (onAddAssist null).
 */
export function UndoToast({ label, text, onUndo, onAddAssist, onExpire }: { label: string; text: string; onUndo: () => void; onAddAssist: (() => void) | null; onExpire: () => void }) {
  const [hover, setHover] = useState(false)
  const [touch, setTouch] = useState(false)
  const [focus, setFocus] = useState(false)
  const held = hover || touch || focus
  const box = useRef<HTMLDivElement>(null)
  const expire = useRef(onExpire)
  useEffect(() => {
    expire.current = onExpire
  })
  // A tall toast (large text, a long name) grows the room the page keeps for it, so it never covers the last control.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const root = document.documentElement
    const room = () => root.style.setProperty('--console-toast-room', `calc(max(11rem, ${el.offsetHeight}px + 3rem))`)
    room()
    const watch = new ResizeObserver(room)
    watch.observe(el)
    return () => {
      watch.disconnect()
      root.style.removeProperty('--console-toast-room')
    }
  }, [])
  useEffect(() => {
    if (held) return
    const t = setTimeout(() => expire.current(), 8000)
    return () => clearTimeout(t)
  }, [held])
  return (
    <div ref={box} className="undo-toast on-ink" role="group" aria-label={label} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)} onPointerLeave={() => setHover(false)}
      onPointerDown={(e) => e.pointerType !== 'mouse' && setTouch(true)} onPointerUp={() => setTouch(false)} onPointerCancel={() => setTouch(false)}>
      <p className="body-strong">{text}</p>
      <div className="undo-toast-actions">
        {onAddAssist && <button type="button" className="ui-button ui-secondary" onClick={onAddAssist}>Add assist</button>}
        <button type="button" className="ui-button ui-primary" onClick={onUndo}>Undo</button>
      </div>
    </div>
  )
}
