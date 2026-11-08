import './components.css'

// The label always carries the meaning; colour only reinforces it. Never focusable or clickable.
export function StatusPill({ state, label }: { state: 'done' | 'pending'; label: string }) {
  return <span className={`label ui-pill ui-pill-${state}`}>{label}</span>
}
