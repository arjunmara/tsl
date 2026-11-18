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
  const expire = useRef(onExpire)
  useEffect(() => {
    expire.current = onExpire
  })
  useEffect(() => {
    if (held) return
    const t = setTimeout(() => expire.current(), 8000)
    return () => clearTimeout(t)
  }, [held])
  return (
    <div className="undo-toast" role="group" aria-label={label} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
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
