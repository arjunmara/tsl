import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { serverNow } from '../../domain/clock'
import { dropQueuedClock, forgetRefused, send } from '../../domain/commands'
import { clockCommand, dividerText, periodButtons, readConsole, stepClock, takeScoring, type ClockOp, type Console as ConsoleData } from '../../domain/console'
import { formatDate, inZone } from '../../domain/format'
import { messageFor, messages } from '../../domain/messages'
import { DestructiveButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { Unavailable, UUID } from '../setup/Setup'
import { useWakeLock } from './Clock'
import { PreMatch, startDraft, type Drafts } from './PreMatch'
import { Scoreboard } from './Scoreboard'

const LEFT = 'The clock keeps running.'

/**
 * /t/:tournamentId/score/:matchId (an Organiser) and /score/:matchId (a Scorer phone): the scoring console, full screen with no App bar or
 * Tab bar (Story 4.2). Opening it takes scoring when nobody holds the Match; one held by another phone opens read-only.
 */
export function Console({ scorer }: { scorer?: boolean }) {
  const { tournamentId = '', matchId = '' } = useParams()
  if ((!scorer && !UUID.test(tournamentId)) || !UUID.test(matchId)) return <Unavailable />
  return <Load key={matchId} tournamentId={tournamentId} matchId={matchId} scorer={!!scorer} />
}

function Load({ tournamentId, matchId, scorer }: { tournamentId: string; matchId: string; scorer: boolean }) {
  const navigate = useNavigate()
  const hash = useLocation().hash
  const [c, setC] = useState<ConsoleData | 'none' | 'offline' | 'unknown' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [drafts, setDrafts] = useState<Drafts | null>(null)
  const [swapped, setSwapped] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [airQueued, setAirQueued] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [today] = useState(() => inZone(serverNow()).date)
  // The Match's version as this phone expects the server to have it: each clock command raises it by one, queued or not.
  const version = useRef(0)
  useWakeLock()

  useEffect(() => {
    let live = true
    void (async () => {
      const first = await readConsole(matchId)
      if (!live) return
      if (first === 'none') return setC('none')
      if ('code' in first) return setC(first.code)
      let r: ConsoleData = first
      if (!r.holder && r.match.status !== 'finished' && r.match.seasonStatus === 'started' && r.teams.length === 2) {
        const t = await takeScoring(r.match.seasonId, matchId)
        if (!live) return
        if (t.ok) {
          const again = await readConsole(matchId)
          if (!live) return
          if (typeof again === 'object' && 'match' in again) r = again
        } else if (t.code !== 'scoring_elsewhere') {
          setProblem(t.code === 'offline' ? messages.take_offline : messageFor(t.code))
        }
      }
      version.current = r.match.version
      setDrafts(Object.fromEntries(r.teams.map((t) => [t.teamId, startDraft(t)])))
      setConfirmed(r.teams.length === 2 && r.teams.every((t) => t.lineup))
      setC(r)
    })()
    return () => {
      live = false
    }
  }, [matchId, attempt])

  // A phone that does not hold scoring follows the Match: the clock, the score and the Event log come from the server every 5 s.
  const following = typeof c === 'object' && c !== null && !c.holder && c.match.status !== 'finished'
  useEffect(() => {
    if (!following) return
    const t = setInterval(() => void readConsole(matchId).then((r) => {
      if (typeof r === 'object' && 'match' in r) setC((x) => (x && typeof x === 'object' ? { ...x, match: r.match, clock: r.clock, score: r.score, events: r.events, onAir: r.onAir } : x))
    }).catch(() => {}), 5000)
    return () => clearInterval(t)
  }, [following, matchId])

  const leave = () => navigate(scorer ? { pathname: '/score', hash } : `/t/${tournamentId}`, { state: { tab: 'matches', note: LEFT } })

  if (c === null) return <main className="console" aria-busy="true"><p className="body">Opening the match…</p></main>
  if (c === 'none') return <Unavailable />
  if (typeof c === 'string') {
    return (
      <main className="console">
        <Problem text={c === 'offline' ? messages.take_offline : messages.console_unknown} />
        <SecondaryButton label="Try opening the match again" onClick={() => (setC(null), setAttempt((n) => n + 1))} />
        <SecondaryButton label="Leave console" onClick={leave} />
      </main>
    )
  }

  const ordered = swapped ? [...c.teams].reverse() : c.teams
  const [home, away] = ordered
  const ready = c.teams.length === 2 && drafts && home && away
  const readOnly = !c.holder || c.match.status !== 'scheduled'
  const kits = Object.fromEntries(ordered.map((t) => [t.teamId, drafts?.[t.teamId]?.kit ?? t.registeredKit ?? '']))
  const running = c.match.seasonStatus === 'started' && c.match.status !== 'finished'
  const buttons = periodButtons(c.clock, c.rules)
  const day = c.match.kickOff ? inZone(c.match.kickOff).date : today
  const onAir = c.onAir
  const scope = c.match.seasonId

  async function confirm() {
    if (!ready || !drafts || busy || !home || !away) return
    setBusy(true)
    setProblem(null)
    const side = (t: typeof home) => ({ team_id: t.teamId, kit_colour: drafts[t.teamId]!.kit,
      starters: t.squad.filter((p) => drafts[t.teamId]!.picks[p.playerId] === 'start').map((p) => p.playerId),
      bench: t.squad.filter((p) => drafts[t.teamId]!.picks[p.playerId] === 'bench').map((p) => p.playerId) })
    const r = await send('confirm_lineups', { season_id: scope, match_id: matchId, home: side(home), away: side(away) }, { scope })
    setBusy(false)
    if (r.ok || r.code === 'queued') {
      setConfirmed(true)
      setNotice(r.ok ? '' : messages.lineups_queued)
    } else {
      setProblem(r.code === 'lineup_invalid' && r.message ? r.message : messageFor(r.code))
    }
  }

  // A clock command: the clock changes on this phone at once (offline too), then the command goes through the outbox with the time of the tap.
  async function clockStep(op: ClockOp, ms?: number) {
    if (!c || typeof c === 'string') return
    const at = serverNow()
    const step = stepClock(c.clock, op, at, c.rules, ms)
    if (!step) return
    const expected = version.current++
    setProblem(null)
    setNotice('')
    setC((x) => x && typeof x === 'object' ? { ...x, clock: step.clock, match: { ...x.match, status: step.status ?? x.match.status },
      events: step.event ? [{ id: crypto.randomUUID(), kind: step.event, period: step.clock.period, minute: Math.floor(step.clock.elapsedMs / 60000), enteredAt: at.toISOString(),
        home: x.score.home, away: x.score.away }, ...x.events] : x.events } : x)
    const r = await send(clockCommand[op], { season_id: scope, match_id: matchId, expected_version: expected, at: at.toISOString(), ...(op === 'set' ? { elapsed_ms: ms } : {}) }, { scope })
    if (r.ok) return
    if (r.code === 'queued') return setNotice(messages.clock_queued)
    if (r.commandId) void forgetRefused(r.commandId)
    await dropQueuedClock(matchId)
    setProblem(messageFor(r.code))
    const again = await readConsole(matchId)
    if (typeof again === 'object' && 'match' in again) {
      version.current = again.match.version
      setC(again)
    }
  }

  async function show() {
    if (busy) return
    setBusy(true)
    setProblem(null)
    const r = await send('show_on_stream', { season_id: scope, match_id: matchId }, { scope })
    setBusy(false)
    if (r.ok) setC((x) => (x && typeof x === 'object' ? { ...x, onAir: true } : x))
    else if (r.code === 'queued') setAirQueued(true)
    else setProblem(messageFor(r.code))
  }

  return (
    <main className="console">
      <header className="console-strip">
        <SecondaryButton label="Leave console" onClick={leave} />
        <h1 className="title console-title">{ready ? `${home.code} v ${away.code}` : 'Match'}</h1>
        <p className="meta console-date">{formatDate(day)}</p>
        {onAir && <p className="console-air body-strong">● On the stream</p>}
      </header>
      {!c.holder && c.held && <p className="body-strong" role="status">Another phone is scoring this match.</p>}
      <Problem text={problem} />
      <p className="meta" role="status" aria-live="polite">{notice}</p>
      {airQueued && !onAir && <p className="meta" role="status">Goes on the stream when the signal returns.</p>}
      {c.match.status === 'finished' && <p className="body">This Match is finished.</p>}
      {c.match.seasonStatus !== 'started' && <p className="body">{messages.console_not_started}</p>}
      {c.teams.length < 2 && <p className="body">This Match has no Teams yet.</p>}
      {ready && home && away && (
        <>
          <Scoreboard c={c} home={home} away={away} kits={kits} canCorrect={c.holder && running} onCorrect={(ms) => void clockStep('set', ms)} />
          {c.holder && running && (
            <div className="clock-controls">
              {c.clock.interval ? null : c.clock.running
                ? <button type="button" className="ui-button ui-primary clock-pause" onClick={() => void clockStep('pause')}><span className="clock-pause-icon" aria-hidden="true" />Pause clock</button>
                : c.clock.period === 0 && !confirmed
                  ? null
                  : <PrimaryButton label={c.clock.period === 0 ? 'Start clock' : 'Resume clock'} onClick={() => void clockStep('start')} />}
              {buttons.map((b) => b.op === 'end'
                ? <DestructiveButton key={b.label} label={b.label} sheetTitle={`End the match at ${c.score.home}–${c.score.away}?`} before="Live" after="Finished"
                    actionLabel="End the match" note="This is logged." onConfirm={() => void clockStep('end')} />
                : <SecondaryButton key={b.label} label={b.label} onClick={() => void clockStep('next')} />)}
            </div>
          )}
          <section aria-labelledby="event-log">
            <h2 id="event-log" className="body-strong">Event log</h2>
            <ul className="event-log">
              {c.events.map((e) => ({ e, text: dividerText(e, c.rules) })).filter((x) => x.text).map(({ e, text }) => <li key={e.id} className="body">{text}</li>)}
            </ul>
            {!c.events.some((e) => dividerText(e, c.rules)) && <p className="meta">Nothing has happened yet.</p>}
          </section>
        </>
      )}
      {ready && drafts && c.match.status === 'scheduled' && (
        <PreMatch c={c} teams={ordered} drafts={drafts} setDrafts={(d) => (setConfirmed(false), setDrafts(d))} readOnly={readOnly} confirmed={confirmed} busy={busy}
          onSwap={() => (setConfirmed(false), setSwapped((s) => !s))} onConfirm={() => void confirm()} />
      )}
      {(scorer ? c.holder : true) && c.match.status !== 'finished' && c.match.seasonStatus === 'started' && c.teams.length === 2 && !onAir && !airQueued && (
        <PrimaryButton label="Show on stream" onClick={busy ? undefined : () => void show()} />
      )}
    </main>
  )
}
