import { forwardRef, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { platformName } from '../../domain/env'
import type { ResultData, Side } from '../../domain/graphics'
import { brandDefaults, inkFor, readable, textColours } from '../setup/brand'
import './graphics.css'

/**
 * The Classic Template (Story 5.1) for a finished Match: one component for the thumbnail, the preview and the PNG, at a fixed 1080x1350.
 * Only the brand colours and logo come from the Tournament; type, grid, dates, codes and the "Made with" line are fixed. Every text layer's ink
 * comes from inkFor (Story 5.2): the field's smallest text needs 4.5:1, so a main colour neither navy nor white reaches that on is darkened.
 */
export const Classic = forwardRef<HTMLDivElement, { data: ResultData }>(function Classic({ data }, ref) {
  const area = useRef<HTMLDivElement>(null)
  const [limit, setLimit] = useState(Infinity)
  const most = Math.max(data.home.goals.length, data.away.goals.length)
  useLayoutEffect(() => {
    const fit = () => {
      const row = area.current?.querySelector('li')
      if (!area.current || !row) return
      const rows = Math.floor(area.current.clientHeight / row.offsetHeight)
      setLimit(most <= rows ? Infinity : Math.max(rows - 1, 0))
    }
    fit()
  }, [most, data.sponsors.length, data.date, data.venue])
  const ink = textColours()
  const def = brandDefaults()
  const field = readable(data.primary ?? def.primary, ink)
  const accent = data.secondary ?? def.secondary
  const crest = (s: Side) => {
    const kit = inkFor([s.kit ?? ink.navy], 72, ink)
    return (
      <div className="graphic-crest">
        <div className="graphic-disc" style={{ background: kit.fill ?? s.kit ?? ink.navy, color: kit.text }}>{s.code}</div>
        <p className="graphic-team">{s.name}</p>
      </div>
    )
  }
  // Goals that don't fit the area end in "+N more" (the caption keeps them all).
  const goals = (s: Side) => {
    const shown = s.goals.slice(0, limit)
    return <ul>{shown.map((g, i) => <li key={i}>{g.who} {g.minute}′</li>)}{shown.length < s.goals.length && <li>+{s.goals.length - shown.length} more</li>}</ul>
  }
  const when = [data.date, data.venue].filter(Boolean)
  const style: CSSProperties = { background: field.panel, color: field.text }
  return (
    <div ref={ref} className="graphic-classic" data-template="classic" style={style}>
      <div className="graphic-frame" style={{ borderColor: accent }} />
      <div className="graphic-eyebrow">
        {data.logo && <img className="graphic-logo" src={data.logo} alt="" crossOrigin="anonymous" />}
        <span>{data.tournament}</span>
      </div>
      <p className="graphic-round">{data.round}</p>
      <div className="graphic-tick" style={{ background: accent }} />
      <div className="graphic-row">
        {crest(data.home)}
        <p className="graphic-score">{data.home.score}–{data.away.score}</p>
        {crest(data.away)}
      </div>
      {data.pens && <p className="graphic-pens">{data.pens.home}–{data.pens.away} on penalties</p>}
      <div className="graphic-rule" style={{ background: field.text, opacity: 0.4 }} />
      <div ref={area} className="graphic-goals">{goals(data.home)}{goals(data.away)}</div>
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
