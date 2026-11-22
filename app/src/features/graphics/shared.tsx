import { useLayoutEffect, useRef, useState } from 'react'
import type { Side } from '../../domain/graphics'

/** The goals area of a result Graphic: as many goal rows as fit, then "+N more" (the caption keeps them all). Classic does the same inline. */
export function useGoalFit(most: number, deps: unknown[]) {
  const area = useRef<HTMLDivElement>(null)
  const [limit, setLimit] = useState(Infinity)
  useLayoutEffect(() => {
    const row = area.current?.querySelector('li')
    if (!area.current || !row) return
    const rows = Math.floor(area.current.clientHeight / row.offsetHeight)
    setLimit(most <= rows ? Infinity : Math.max(rows - 1, 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what changes the space
  }, [most, ...deps])
  return { area, limit }
}

export function GoalList({ side, limit, style }: { side: Side; limit: number; style?: React.CSSProperties }) {
  const shown = side.goals.slice(0, limit)
  return (
    <ul style={style}>
      {shown.map((g, i) => <li key={i}>{g.who} {g.minute}′</li>)}
      {shown.length < side.goals.length && <li>+{side.goals.length - shown.length} more</li>}
    </ul>
  )
}

/** The leading side of a result: more goals, else more penalties; null when level. */
export function leader(d: { home: Side; away: Side; pens: { home: number; away: number } | null }): 'home' | 'away' | null {
  const diff = d.home.score - d.away.score || (d.pens ? d.pens.home - d.pens.away : 0)
  return diff > 0 ? 'home' : diff < 0 ? 'away' : null
}
