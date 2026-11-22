import { forwardRef, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { platformName } from '../../domain/env'
import type { PlayerData } from '../../domain/graphics'
import { brandDefaults, darken, inkFor, lighten, mix, readable, textColours, type TextColours } from '../setup/brand'
import './graphics.css'

/** The panel's colour and ink: panel text sits on a fill at least 95% opaque over the cut-out, so it must read on the colour blended 5% with black and with white. */
function panelOf(base: string, own: string, t: TextColours) {
  let panel = base
  for (let i = 0; i < 8; i++) {
    const r = inkFor([darken(panel, 0.05), lighten(panel, 0.05)], 36, t, own)
    if (!r.fill) return { panel, text: r.text }
    panel = r.fill
  }
  return { panel, text: t.white }
}

/**
 * The Classic Player Template (Story 5.3), back to front: field, glow, the big word, the cut-out (only when given one), the info panel, the frame.
 * Same fixed 1080x1350 canvas and rules as the Result Graphic; the cut-out is the consent gate's output and nothing else.
 */
export const Player = forwardRef<HTMLDivElement, { data: PlayerData }>(function Player({ data }, ref) {
  const word = useRef<HTMLParagraphElement>(null)
  const [px, setPx] = useState(400)
  // The word is 400px unless it would not fit the canvas (its width scales with the size).
  useLayoutEffect(() => {
    const fit = () => {
      const el = word.current
      if (el) setPx(Math.min(400, Math.floor((parseFloat(getComputedStyle(el).fontSize) * 984) / Math.max(el.offsetWidth, 1))))
    }
    fit()
    void document.fonts.ready.then(fit)
  }, [data.word])
  const b = data.base
  const ink = textColours()
  const def = brandDefaults()
  const field = readable(b.primary ?? def.primary, ink)
  const accent = b.secondary ?? def.secondary
  const glow = mix(field.panel, accent, 0.38)
  const top = inkFor([field.panel, glow], 40, ink, field.text)
  const wordInk = inkFor([field.panel, glow], 400, ink, accent)
  const { panel, text } = panelOf(field.panel, field.text, ink)
  const chip = inkFor([accent], 36, ink)
  const when = [b.date, b.venue].filter(Boolean)
  const style: CSSProperties = { background: field.panel, color: top.text }
  return (
    <div ref={ref} className="graphic-player" style={style}>
      <div className="graphic-glow" style={{ background: `radial-gradient(circle 460px at 50% 40%, ${accent}61, ${accent}00)` }} />
      <div className="graphic-eyebrow">
        {b.logo && <img className="graphic-logo" src={b.logo} alt="" crossOrigin="anonymous" />}
        <span>{b.tournament}</span>
      </div>
      <p className="graphic-round">{b.round}</p>
      <p ref={word} className="graphic-word" style={{ color: wordInk.text, fontSize: px }}>{data.word}</p>
      {data.cutout && <img className="graphic-cutout" src={data.cutout} alt="" crossOrigin="anonymous" />}
      <div className="graphic-info" style={{ background: `${panel}f3`, color: text }}>
        <div className="graphic-tagrow">
          <span className="graphic-tag" style={{ background: chip.fill ?? accent, color: chip.text }}>{data.label}</span>
          {data.minute != null && <span className="graphic-minute">{data.minute}′</span>}
        </div>
        <p className="graphic-pname">{data.name}</p>
        {data.team && <p className="graphic-pteam">{data.team}</p>}
        {data.assist && <p className="graphic-assist">Assist: {data.assist}</p>}
        {data.kind !== 'award' && <p className="graphic-mini">{b.home.code} {b.home.score}–{b.away.score} {b.away.code}</p>}
        {when.length > 0 && <p className="graphic-when">{when.join('\n')}</p>}
        {b.sponsors.length > 0 && (
          <div className="graphic-sponsors">
            {b.sponsors.map((x, i) => (
              <div key={i} className="graphic-plate"><img src={x.logo} alt="" crossOrigin="anonymous" /><span>{x.name}</span></div>
            ))}
          </div>
        )}
        <p className="graphic-made">Made with {platformName}</p>
      </div>
      <div className="graphic-frame" style={{ borderColor: accent }} />
    </div>
  )
})
