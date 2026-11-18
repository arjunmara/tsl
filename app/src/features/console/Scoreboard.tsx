import { useEffect, useState } from 'react'
import { elapsedAt, formatClock, foulsIn, parseClock, periodName, powerPlays, type Console, type ConsoleTeam } from '../../domain/console'
import { serverNow } from '../../domain/clock'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { KitDot } from '../../ui/KitDot'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Clock } from './Clock'

/** The words under the clock: the period now, "Half-time" between periods. */
export function periodLabel(c: Console): string {
  if (c.match.status === 'finished') return 'Full time'
  if (c.clock.period === 0) return 'Not started'
  if (c.clock.interval) return c.clock.period === 1 && c.rules.periods === 2 ? 'Half-time' : 'Interval'
  return periodName(c.clock.period, c.rules).replace(/^./, (x) => x.toUpperCase())
}

/** "Power play FSW 1:42" for each red card's opponent, counting down with the Match clock. Not a live region: nothing announces it. */
function PowerPlay({ c }: { c: Console }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!c.clock.running) return
    const t = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [c.clock.running])
  return powerPlays(c, elapsedAt(c.clock, serverNow())).map((p, i) => {
    const s = Math.ceil(p.leftMs / 1000)
    return <p key={i} className="body-strong scoreboard-power" data-testid="power-play">Power play {c.teams.find((t) => t.teamId === p.teamId)?.code} {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</p>
  })
}

/**
 * The scoreboard (Story 4.3): read-only, so tapping it does nothing. Home on the left, away on the right, the score in display-xl, the clock
 * and the period under it. Its menu holds "Correct the clock" (the holder only), which asks to confirm before it is logged.
 */
export function Scoreboard({ c, home, away, kits, canCorrect, onCorrect }: {
  c: Console; home: ConsoleTeam; away: ConsoleTeam; kits: Record<string, string>; canCorrect: boolean; onCorrect: (ms: number) => void
}) {
  const [menu, setMenu] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [text, setText] = useState('')
  const [ask, setAsk] = useState<{ from: string; to: string; ms: number } | null>(null)
  const parsed = parseClock(text)
  const side = (t: ConsoleTeam) => (
    <div className="scoreboard-team">
      <span className="kit-chip"><KitDot colour={kits[t.teamId] ?? null} /><span className="body-strong">{t.code}</span></span>
      <span className="meta">{t.name}</span>
      {!!c.rules.foulWarning && <span className={foulsIn(c, t.teamId) >= c.rules.foulWarning ? 'body-strong scoreboard-limit' : 'meta'}>
        Fouls {foulsIn(c, t.teamId)}{foulsIn(c, t.teamId) >= c.rules.foulWarning ? ' · Limit' : ''}</span>}
    </div>
  )
  return (
    <section className="card scoreboard" aria-label="Scoreboard">
      <div className="scoreboard-grid">
        {side(home)}
        <p className="display-xl scoreboard-score">{c.score.home} – {c.score.away}</p>
        {side(away)}
      </div>
      <p className="scoreboard-time"><Clock clock={c.clock} /> <span className="body-strong scoreboard-period">{periodLabel(c)}</span></p>
      <PowerPlay c={c} />
      {canCorrect && c.clock.period > 0 && (
        <div className="scoreboard-menu">
          <SecondaryButton label="Open scoreboard menu" onClick={() => setMenu((m) => !m)} />
          {menu && !fixing && <SecondaryButton label="Correct the clock" onClick={() => (setFixing(true), setText(formatClock(elapsedAt(c.clock, serverNow()))))} />}
          {fixing && (
            <div className="scoreboard-fix">
              <label className="body" htmlFor="fix-clock">New clock time (minutes:seconds)</label>
              <input id="fix-clock" className="ui-input" inputMode="numeric" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
              {parsed === null && <p className="meta ui-reason">Use minutes and seconds, like 14:05, up to 360:00.</p>}
              {parsed === null
                ? <PrimaryButton label="Review the clock change" disabled disabledReason="Enter the time like 14:05." />
                : <PrimaryButton label="Review the clock change" onClick={() => setAsk({ from: formatClock(elapsedAt(c.clock, serverNow())), to: formatClock(parsed), ms: parsed })} />}
            </div>
          )}
        </div>
      )}
      <ConfirmSheet open={!!ask} title={ask ? `Set the clock from ${ask.from} to ${ask.to}?` : ''} before={ask?.from ?? ''} after={ask?.to ?? ''}
        actionLabel="Set the clock" note="This is logged." onClose={() => setAsk(null)}
        onConfirm={() => { if (ask) { onCorrect(ask.ms); setFixing(false); setMenu(false) } }} />
    </section>
  )
}
