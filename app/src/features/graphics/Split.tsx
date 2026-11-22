import { forwardRef, type CSSProperties } from 'react'
import { platformName } from '../../domain/env'
import type { ResultData, Side } from '../../domain/graphics'
import { brandDefaults, inkFor, textColours } from '../setup/brand'
import { GoalList, useGoalFit } from './shared'
import './graphics.css'

/**
 * The Split Template (Story 5.7) for a finished Match: the canvas splits into the home and away kit colours, a navy score band runs across the middle between
 * navy top and bottom bars. Ink is chosen per half by inkFor (a kit the ink can't read on is darkened behind the text); brand-secondary only
 * ever appears in the eyebrow and "Full time", through inkFor on navy. Same 1080x1350 canvas and fixed rules as Classic.
 */
export const Split = forwardRef<HTMLDivElement, { data: ResultData }>(function Split({ data }, ref) {
  const { area, limit } = useGoalFit(Math.max(data.home.goals.length, data.away.goals.length), [data.sponsors.length, data.date, data.venue])
  const ink = textColours()
  const accent = data.secondary ?? brandDefaults().secondary
  const half = (s: Side): { fill: string; text: string } => {
    const r = inkFor([s.kit ?? ink.navy], 36, ink)
    return { fill: r.fill ?? s.kit ?? ink.navy, text: r.text }
  }
  const [h, a] = [half(data.home), half(data.away)]
  const small = inkFor([ink.navy], 28, ink, accent).text
  const full = inkFor([ink.navy], 40, ink, accent).text
  const bar: CSSProperties = { background: ink.navy, color: ink.white }
  const cell = (s: Side, x: { fill: string; text: string }) => (
    <div className="graphic-half" style={{ background: x.fill, color: x.text }}>
      <p className="graphic-code">{s.code}</p>
      <p className="graphic-team">{s.name}</p>
    </div>
  )
  const when = [data.date, data.venue].filter(Boolean)
  return (
    <div ref={ref} className="graphic-classic graphic-split" data-template="split" style={bar}>
      <div className="graphic-bar graphic-bartop" style={bar}>
        <div className="graphic-eyebrow" style={{ color: small }}>
          {data.logo && <img className="graphic-logo" src={data.logo} alt="" crossOrigin="anonymous" />}
          <span>{data.tournament}</span>
        </div>
        <p className="graphic-round">{data.round}</p>
      </div>
      <div className="graphic-halves">{cell(data.home, h)}{cell(data.away, a)}</div>
      <div className="graphic-band" style={bar}>
        <p className="graphic-fulltime" style={{ color: full }}>Full time</p>
        <p className="graphic-score">{data.home.score}–{data.away.score}</p>
        {data.pens && <p className="graphic-pens">{data.pens.home}–{data.pens.away} on penalties</p>}
      </div>
      <div ref={area} className="graphic-goals graphic-halves">
        <GoalList side={data.home} limit={limit} style={{ background: h.fill, color: h.text }} />
        <GoalList side={data.away} limit={limit} style={{ background: a.fill, color: a.text }} />
      </div>
      <div className="graphic-bar graphic-barbottom" style={bar}>
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
    </div>
  )
})
