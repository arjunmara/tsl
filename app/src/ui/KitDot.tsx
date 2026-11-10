import type { CSSProperties } from 'react'
import './components.css'

// A Team's kit colour as a round dot with a muted ring, so white or yellow kits still show (UX-DR16). Decorative: the
// Team's name and code always say which Team it is. No colour yet: an empty ringed dot.
export function KitDot({ colour }: { colour: string | null }) {
  return <span className="ui-kit-dot" aria-hidden="true" style={colour ? ({ '--kit': colour } as CSSProperties) : undefined} />
}
