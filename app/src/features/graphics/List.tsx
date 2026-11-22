import { forwardRef, type CSSProperties } from 'react'
import { platformName } from '../../domain/env'
import type { ListData } from '../../domain/listGraphics'
import { brandDefaults, inkFor, readable, textColours, token } from '../setup/brand'
import { gradientOf } from './Gradient'
import './graphics.css'

/**
 * The Classic list Template (Story 5.5): the Classic canvas, frame, eyebrow, footer, Sponsors and "Made with" around a list: the Draw's groups, a day's Matches or a table.
 * ponytail: rows share the height left, so a list over ~10 rows (a league of 12+) clips; split it or shrink the type if one is ever needed.
 */
export const List = forwardRef<HTMLDivElement, { data: ListData }>(function List({ data }, ref) {
  const ink = textColours()
  const def = brandDefaults()
  // Split and Minimal (Story 5.7) change the palette and header only; the list layout is the same.
  const split = data.template === 'split'
  const min = data.template === 'minimal'
  // Gradient (Story 5.8): the brand diagonal, one accent rule. Spotlight: the solid brand panel and one thick accent rule.
  const grad = data.template === 'gradient'
  const spot = data.template === 'spotlight'
  const g = gradientOf(data.primary ?? def.primary, ink)
  const field = split ? { panel: ink.navy, text: ink.white } : min ? { panel: ink.white, text: ink.navy } : grad ? { panel: g.from, text: g.text } : readable(data.primary ?? def.primary, ink)
  const accent = data.secondary ?? def.secondary
  const eyebrow = split ? inkFor([ink.navy], 28, ink, accent).text : min ? token('--ink-muted') : undefined
  const left = readable(data.primary ?? def.primary, ink).panel
  const dot = (kit: string | null) => <span className="graphic-dot" style={{ background: kit ?? ink.navy }} />
  const b = data.body
  const style: CSSProperties = { ...(grad ? g.css : { background: field.panel }), color: field.text }
  return (
    <div ref={ref} className={`graphic-classic graphic-list${split ? ' graphic-lsplit' : min ? ' graphic-lmin' : ''}`} data-template={data.template} data-worst-fill={grad ? g.worst : undefined} style={style}>
      {!split && !min && !grad && !spot && <div className="graphic-frame" style={{ borderColor: accent }} />}
      <div className="graphic-eyebrow" style={eyebrow ? { color: eyebrow } : undefined}>
        {data.logo && <img className="graphic-logo" src={data.logo} alt="" crossOrigin="anonymous" />}
        <span>{data.tournament}</span>
      </div>
      <p className="graphic-round">{data.title}</p>
      {split ? <div className="graphic-strip"><span style={{ background: left }} /><span style={{ background: ink.white }} /></div>
        : spot ? <div className="graphic-thick" style={{ background: accent }} />
        : !min && <div className="graphic-tick" data-accent={grad ? '' : undefined} style={{ background: accent }} />}
      <p className="graphic-when graphic-sub">{data.sub}</p>
      <div className="graphic-rule" style={min ? { background: token('--line') } : { background: field.text, opacity: 0.4 }} />
      <div className="graphic-listbody">
        {b.kind === 'draw' && (
          <div className="graphic-groups">
            {b.groups.map((g) => (
              <section key={g.title}>
                <h3 className="graphic-gtitle">{g.title}</h3>
                {g.teams.map((t) => <p key={t.code} className="graphic-line">{dot(t.kit)}<b>{t.code}</b><span>{t.name}</span></p>)}
              </section>
            ))}
          </div>
        )}
        {b.kind === 'matches' && b.rows.map((r, i) => (
          <p key={i} className="graphic-line graphic-match">
            <span className="graphic-time">{r.time}</span><b className="graphic-home">{r.home}</b>
            <span className="graphic-mid">{r.score ? `${r.score}${r.pens ? ` (${r.pens})` : ''}` : 'v'}</span><b className="graphic-away">{r.away}</b>
            <span className="graphic-rnd">{r.round}</span>
          </p>
        ))}
        {b.kind === 'scorers' && b.rows.map((r, i) => (
          <p key={i} className="graphic-line graphic-srow"><span className="graphic-rank">{r.rank}</span>{dot(r.kit)}<b>{r.code}</b><span className="graphic-sname">{r.name}</span><span className="graphic-sgoals">{r.goals}</span></p>
        ))}
        {b.kind === 'bracket' && (
          <div className="graphic-bracket" style={{ gridTemplateColumns: b.rounds.map((r) => (r.ties.length > 4 ? 'minmax(0, 1.7fr)' : 'minmax(0, 1fr)')).join(' ') }}>
            {b.rounds.map((r) => (
              <section key={r.title}>
                <h3 className="graphic-gtitle">{r.title}</h3>
                <div className="graphic-ties">
                  {r.ties.map((t, i) => (
                    <div key={i} className="graphic-tie">
                      {r.ties.length > 4
                        ? <p className="graphic-line"><b>{t.home}</b><span>{t.hs}</span><b>{t.away}</b><span>{t.as}</span></p>
                        : <><p className="graphic-line"><b>{t.home}</b><span>{t.hs}</span></p><p className="graphic-line"><b>{t.away}</b><span>{t.as}</span></p></>}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        {b.kind === 'champions' && (() => {
          const kit = b.kit ?? ink.navy
          const d = inkFor([kit], 120, ink)
          return (
            <div className="graphic-champs">
              <div className="graphic-champdisc" style={{ background: d.fill ?? kit, color: d.text }}>{b.code}</div>
              <p className="graphic-cname">{b.name}</p>
              {b.score && <p className="graphic-line graphic-cscore">{b.score}</p>}
            </div>
          )
        })()}
        {b.kind === 'table' && (
          <>
            <p className="graphic-line graphic-trow graphic-thead"><span>#</span><span>Team</span>{['P', 'W', 'D', 'L', 'GD', 'Pts'].map((h) => <span key={h}>{h}</span>)}</p>
            {b.rows.map((r) => (
              <p key={r.pos} className="graphic-line graphic-trow">
                <span>{r.pos}</span><span className="graphic-tteam">{dot(r.kit)}<b>{r.code}</b></span>
                {[r.p, r.w, r.d, r.l, r.gd, r.pts].map((v, i) => <span key={i}>{v}</span>)}
              </p>
            ))}
            <p className="graphic-foot">{b.footnote}</p>
          </>
        )}
      </div>
      {data.foot.length > 0 && <p className="graphic-when">{data.foot.join('\n')}</p>}
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
