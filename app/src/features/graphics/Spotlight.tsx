import { forwardRef, type CSSProperties } from 'react'
import { platformName } from '../../domain/env'
import type { ResultData, Side } from '../../domain/graphics'
import { brandDefaults, inkFor, readable, textColours } from '../setup/brand'
import { GoalList, useGoalFit } from './shared'
import './graphics.css'

/**
 * The Spotlight Template (Story 5.8) for a finished Match: a solid brand-primary panel, one thick brand-secondary rule under the header, white crest discs and the score.
 * A Result has no photo, so there is no photo field here; the Player Graphic (Player.tsx) is where Spotlight puts the cut-out above its panel.
 */
export const Spotlight = forwardRef<HTMLDivElement, { data: ResultData }>(function Spotlight({ data }, ref) {
  const { area, limit } = useGoalFit(Math.max(data.home.goals.length, data.away.goals.length), [data.sponsors.length, data.date, data.venue])
  const ink = textColours()
  const def = brandDefaults()
  const field = readable(data.primary ?? def.primary, ink)
  const crest = (s: Side) => {
    const kit = inkFor([s.kit ?? ink.navy], 72, ink)
    return (
      <div className="graphic-crest">
        <div className="graphic-disc" style={{ background: kit.fill ?? s.kit ?? ink.navy, color: kit.text }}>{s.code}</div>
        <p className="graphic-team">{s.name}</p>
      </div>
    )
  }
  const when = [data.date, data.venue].filter(Boolean)
  const style: CSSProperties = { background: field.panel, color: field.text }
  return (
    <div ref={ref} className="graphic-classic graphic-spotlight" data-template="spotlight" style={style}>
      <div className="graphic-eyebrow">
        {data.logo && <img className="graphic-logo" src={data.logo} alt="" crossOrigin="anonymous" />}
        <span>{data.tournament}</span>
      </div>
      <p className="graphic-round">{data.round}</p>
      <div className="graphic-thick" style={{ background: data.secondary ?? def.secondary }} />
      <div className="graphic-row">
        {crest(data.home)}
        <p className="graphic-score">{data.home.score}–{data.away.score}</p>
        {crest(data.away)}
      </div>
      {data.pens && <p className="graphic-pens">{data.pens.home}–{data.pens.away} on penalties</p>}
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
