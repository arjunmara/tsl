import { forwardRef } from 'react'
import { platformName } from '../../domain/env'
import type { ResultData, Side } from '../../domain/graphics'
import { token } from '../setup/brand'
import { GoalList, leader, useGoalFit } from './shared'
import './graphics.css'

/**
 * The Minimal Template (Story 5.7) for a finished Match: a white canvas, navy ink, grey secondary text and hairlines, a flush-left header, one Team row
 * per side with the score at the right. The leader is marked by weight (800 against 600) and a ▲, never by colour alone. Same fixed rules as Classic.
 */
export const Minimal = forwardRef<HTMLDivElement, { data: ResultData }>(function Minimal({ data }, ref) {
  const { area, limit } = useGoalFit(Math.max(data.home.goals.length, data.away.goals.length), [data.sponsors.length, data.date, data.venue])
  const lead = leader(data)
  const row = (s: Side, who: 'home' | 'away') => (
    <div className="graphic-mrow">
      <span className="graphic-dot graphic-mdot" style={{ background: s.kit ?? token('--bg-dark') }} />
      <b className="graphic-mcode">{s.code}</b>
      <span className="graphic-mname">{s.name}</span>
      <span className="graphic-mscore" style={{ fontWeight: lead === who ? 800 : 600 }}>{s.score}</span>
      <span className="graphic-mlead">{lead === who ? '▲' : ''}</span>
    </div>
  )
  const when = [data.date, data.venue].filter(Boolean)
  return (
    <div ref={ref} className="graphic-classic graphic-minimal" data-template="minimal">
      <div className="graphic-eyebrow">
        {data.logo && <img className="graphic-logo" src={data.logo} alt="" crossOrigin="anonymous" />}
        <span>{data.tournament}</span>
      </div>
      <p className="graphic-round">{data.round}</p>
      <div className="graphic-hair" />
      {row(data.home, 'home')}
      {row(data.away, 'away')}
      {data.pens && <p className="graphic-pens">{data.pens.home}–{data.pens.away} on penalties</p>}
      <div className="graphic-hair" />
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
