import { forwardRef, type CSSProperties } from 'react'
import { platformName } from '../../domain/env'
import type { ResultData, Side } from '../../domain/graphics'
import { brandDefaults, contrast, darken, inkFor, textColours, type TextColours } from '../setup/brand'
import { GoalList, useGoalFit } from './shared'
import './graphics.css'

/**
 * The Gradient palette (Story 5.8): a diagonal from brand-primary to a darker shade of it. Ink is chosen over both stops, so the lightest one counts; where neither navy
 * nor white reads on it, the gradient starts darker (inkFor's own adjustment). `worst` is the stop the chosen text reads worst on (`from` for white, `to` for navy): the root's data-worst-fill and plain background.
 */
export function gradientOf(primary: string, t: TextColours) {
  const r = inkFor([primary, darken(primary, 0.35)], 36, t)
  const from = r.fill ?? primary
  const to = darken(from, 0.35)
  const worst = contrast(r.text, from) <= contrast(r.text, to) ? from : to
  return { from, to, worst, text: r.text, css: { background: `linear-gradient(155deg, ${from} 0%, ${to} 100%)`, backgroundColor: worst, color: r.text } satisfies CSSProperties }
}

/** The Gradient Template for a finished Match: white (or navy) type on the gradient, outlined crests, a large score, brand-secondary only as one rule under the header. */
export const Gradient = forwardRef<HTMLDivElement, { data: ResultData }>(function Gradient({ data }, ref) {
  const { area, limit } = useGoalFit(Math.max(data.home.goals.length, data.away.goals.length), [data.sponsors.length, data.date, data.venue])
  const ink = textColours()
  const g = gradientOf(data.primary ?? brandDefaults().primary, ink)
  const crest = (s: Side) => (
    <div className="graphic-crest">
      <div className="graphic-ring" style={{ boxShadow: `inset 0 0 0 8px ${s.kit && contrast(s.kit, g.from) >= 3 && contrast(s.kit, g.to) >= 3 ? s.kit : g.text}` }}>{s.code}</div>
      <p className="graphic-team">{s.name}</p>
    </div>
  )
  const when = [data.date, data.venue].filter(Boolean)
  return (
    <div ref={ref} className="graphic-classic graphic-gradient" data-template="gradient" data-worst-fill={g.worst} style={g.css}>
      <div className="graphic-eyebrow">
        {data.logo && <img className="graphic-logo" src={data.logo} alt="" crossOrigin="anonymous" />}
        <span>{data.tournament}</span>
      </div>
      <p className="graphic-round">{data.round}</p>
      <div className="graphic-tick" data-accent style={{ background: data.secondary ?? brandDefaults().secondary }} />
      <div className="graphic-row">
        {crest(data.home)}
        <p className="graphic-score graphic-gscore">{data.home.score}–{data.away.score}</p>
        {crest(data.away)}
      </div>
      {data.pens && <p className="graphic-pens">{data.pens.home}–{data.pens.away} on penalties</p>}
      <div className="graphic-rule" style={{ background: g.text, opacity: 0.4 }} />
      <div ref={area} className="graphic-goals"><GoalList side={data.home} limit={limit} /><GoalList side={data.away} limit={limit} /></div>
      {when.length > 0 && <p className="graphic-when">{when.join('\n')}</p>}
      {data.sponsors.length > 0 && (
        <div className="graphic-sponsors">
          {data.sponsors.map((x, i) => (
            <div key={i} className="graphic-plate"><img src={x.logo} alt="" crossOrigin="anonymous" /><span>{x.name}</span></div>
          ))}
        </div>
      )}
      <p className="graphic-made">Made with {platformName}</p>
    </div>
  )
})
