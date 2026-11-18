import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { serverNow } from '../../domain/clock'
import { dropQueuedClock, dropQueuedGoal, forgetRefused, myQueued, noteVersion, send, useOutbox } from '../../domain/commands'
import { clockCommand, goalMinute, playerNames, goalsOf, periodButtons, readConsole, scorerName, starters, stepClock, takeScoring, type ClockOp, type Console as ConsoleData, type ConsoleTeam, type MatchEvent } from '../../domain/console'
import { formatDate, inZone } from '../../domain/format'
import { messageFor, messages } from '../../domain/messages'
import { DestructiveButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { Problem } from '../auth/Screen'
import { Unavailable, UUID } from '../setup/Setup'
import { useWakeLock } from './Clock'
import { EditGoal, EventLog } from './EventLog'
import { GoalButtons } from './GoalButtons'
import { Picker } from './Picker'
import { PreMatch, startDraft, type Drafts } from './PreMatch'
import { Scoreboard } from './Scoreboard'
import { UndoToast } from './UndoToast'

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
  const [picker, setPicker] = useState<{ team: string } | { assist: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [ask, setAsk] = useState<{ title: string; before: string; after: string; action: string; destructive?: boolean; run: () => void } | null>(null)
  const [announce, setAnnounce] = useState('')
  const { entries } = useOutbox()
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
      r.events.forEach((e) => void noteVersion(e.id, e.version ?? 1))
      r.teams.forEach((t) => t.squad.forEach((p) => playerNames.set(p.playerId, p.name)))
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
  // The score is the undeleted goals per Team, in the Scoreboard's order.
  const view = { ...c, score: { home: home ? goalsOf(c.events, home.teamId) : 0, away: away ? goalsOf(c.events, away.teamId) : 0 } }
  const waiting = new Set(entries.filter((e) => e.state === 'pending').flatMap((e) => [e.commandId, String(e.args.event_id ?? '')]))
  const live = c.holder && c.match.status === 'live' && running
  const teamOf = (id: string | null | undefined) => c.teams.find((t) => t.teamId === id)
  const squadOf = (t: ConsoleTeam | undefined) => (t && drafts ? starters(t, drafts[t.teamId]?.picks ?? {}) : [])

  async function confirm() {
    if (!ready || !drafts || busy || !home || !away) return
    setBusy(true)
    setProblem(null)
    const side = (t: typeof home) => ({ team_id: t.teamId, kit_colour: drafts[t.teamId]!.kit,
      starters: t.squad.filter((p) => drafts[t.teamId]!.picks[p.playerId] === 'start').map((p) => p.playerId),
      bench: t.squad.filter((p) => drafts[t.teamId]!.picks[p.playerId] === 'bench').map((p) => p.playerId) })
    const r = await send('confirm_lineups', { season_id: scope, match_id: matchId, home: side(home), away: side(away) }, { scope: matchId })
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
        home: view.score.home, away: view.score.away }, ...x.events] : x.events } : x)
    const r = await send(clockCommand[op], { season_id: scope, match_id: matchId, expected_version: expected, at: at.toISOString(), ...(op === 'set' ? { elapsed_ms: ms } : {}) }, { scope: matchId })
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

  // A goal command's answer: queued stays on this phone; a conflict goes to the hand-back; any other refusal is said once. Then the goals are read
  // again, keeping the ones (and the changes) still waiting in the outbox.
  async function settle(r: { ok: boolean; code: string | null; commandId?: string }) {
    if (r.ok) return
    if (r.code === 'queued') return setNotice(messages.clock_queued)
    if (r.code !== 'version_conflict') {
      if (r.commandId) {
        void forgetRefused(r.commandId)
        void dropQueuedGoal(r.commandId)
      }
      setProblem(messageFor(r.code))
    }
    const again = await readConsole(matchId)
    if (typeof again !== 'object' || !('match' in again)) return
    const keep = new Set((await myQueued()).filter((e) => e.state === 'pending').flatMap((e) => [e.commandId, String(e.args.event_id ?? '')]))
    again.events.forEach((e) => void noteVersion(e.id, e.version ?? 1))
    setC((x) => {
      if (!x || typeof x !== 'object') return x
      const mine = (e: MatchEvent) => keep.has(e.id)
      const events = [...again.events.map((s) => (mine(s) ? x.events.find((l) => l.id === s.id) ?? s : s)), ...x.events.filter((l) => mine(l) && !again.events.some((s) => s.id === l.id))]
      return { ...x, events: events.sort((a, b) => b.enteredAt.localeCompare(a.enteredAt)) }
    })
  }

  // Records a goal for a Team at once (offline too): who is a Player id, 'own' or 'unknown'. The minute and time are those of the tap.
  function goal(t: ConsoleTeam, who: string) {
    if (!c || typeof c === 'string' || !home || !away) return
    const at = serverNow()
    const id = crypto.randomUUID()
    const own = who === 'own'
    const player = own || who === 'unknown' ? null : who
    const e: MatchEvent = { id, kind: 'goal', period: c.clock.period, minute: goalMinute(c.clock, c.rules, at), enteredAt: at.toISOString(), home: null, away: null,
      teamId: t.teamId, playerId: player, assistId: null, ownGoal: own, version: 1 }
    const events = [e, ...c.events]
    setProblem(null)
    setNotice('')
    setC({ ...c, events })
    setToast(id)
    setAnnounce(`Goal for ${t.code}, ${own ? 'own goal' : player ? scorerName(e, t) : 'unknown scorer'}, ${e.minute} minute${e.minute === 1 ? '' : 's'}. ${home.code} ${goalsOf(events, home.teamId)}, ${away.code} ${goalsOf(events, away.teamId)}.`)
    // The goal's version is 1 until its changes come back; each change replays from the outbox's base version for the goal.
    void noteVersion(id, 1)
    void send('record_goal', { season_id: scope, match_id: matchId, team_id: t.teamId, player_id: player, own_goal: own, period: e.period,
      minute: e.minute, at: e.enteredAt }, { scope: matchId, commandId: id }).then(settle)
  }

  // A change to a goal: applied here at once, then sent in the goal's own chain (a held conflict stops only that goal's later changes).
  function change(id: string, name: string, args: Record<string, unknown>, apply: (events: MatchEvent[]) => MatchEvent[]) {
    setProblem(null)
    setNotice('')
    setC((x) => (x && typeof x === 'object' ? { ...x, events: apply(x.events) } : x))
    void send(name, { season_id: scope, event_id: id, ...args }, { scope: id, versionOf: id }).then(settle)
  }
  // Takes a goal away (Undo, Delete goal): one still waiting to send is dropped from the outbox, otherwise the server deletes it.
  async function takeAway(id: string) {
    if (!c || typeof c === 'string' || !home || !away) return
    const rest = c.events.filter((x) => x.id !== id)
    setC((x) => (x && typeof x === 'object' ? { ...x, events: x.events.filter((y) => y.id !== id) } : x))
    setAnnounce(`Goal removed. ${home.code} ${goalsOf(rest, home.teamId)}, ${away.code} ${goalsOf(rest, away.teamId)}.`)
    setToast(null)
    if (await dropQueuedGoal(id)) return
    void send('delete_event', { season_id: scope, event_id: id }, { scope: id, versionOf: id }).then(settle)
  }
  const patch = (id: string, p: Partial<MatchEvent>) => (events: MatchEvent[]) => events.map((x) => (x.id === id ? { ...x, ...p } : x))
  const toastEvent = c.events.find((x) => x.id === toast)
  const editEvent = c.events.find((x) => x.id === editing)
  const pickTeam = picker && 'team' in picker ? teamOf(picker.team) : undefined
  const assistEvent = picker && 'assist' in picker ? c.events.find((x) => x.id === picker.assist) : undefined
  const assistTeam = teamOf(assistEvent?.teamId)

  async function show() {
    if (busy) return
    setBusy(true)
    setProblem(null)
    const r = await send('show_on_stream', { season_id: scope, match_id: matchId }, { scope: matchId })
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
          <Scoreboard c={view} home={home} away={away} kits={kits} canCorrect={c.holder && running} onCorrect={(ms) => void clockStep('set', ms)} />
          {live && <GoalButtons home={home} away={away} kits={kits} onGoal={(t) => setPicker({ team: t.teamId })} />}
          {c.holder && running && (
            <div className="clock-controls">
              {c.clock.interval ? null : c.clock.running
                ? <button type="button" className="ui-button ui-primary clock-pause" onClick={() => void clockStep('pause')}><span className="clock-pause-icon" aria-hidden="true" />Pause clock</button>
                : c.clock.period === 0 && !confirmed
                  ? null
                  : <PrimaryButton label={c.clock.period === 0 ? 'Start clock' : 'Resume clock'} onClick={() => void clockStep('start')} />}
              {buttons.map((b) => b.op === 'end'
                ? <DestructiveButton key={b.label} label={b.label} sheetTitle={`End the match at ${view.score.home}–${view.score.away}?`} before="Live" after="Finished"
                    actionLabel="End the match" note="This is logged." onConfirm={() => void clockStep('end')} />
                : <SecondaryButton key={b.label} label={b.label} onClick={() => void clockStep('next')} />)}
            </div>
          )}
          <EventLog c={c} waiting={waiting} onEdit={live ? (e) => setEditing(e.id) : null} />
        </>
      )}
      {ready && drafts && c.match.status === 'scheduled' && (
        <PreMatch c={c} teams={ordered} drafts={drafts} setDrafts={(d) => (setConfirmed(false), setDrafts(d))} readOnly={readOnly} confirmed={confirmed} busy={busy}
          onSwap={() => (setConfirmed(false), setSwapped((s) => !s))} onConfirm={() => void confirm()} />
      )}
      <p className="ui-visually-hidden" role="status" aria-live="polite">{announce}</p>
      {toastEvent && live && <UndoToast key={toastEvent.id} text={`Goal · ${scorerName(toastEvent, teamOf(toastEvent.teamId))} ${toastEvent.minute}′ · ${teamOf(toastEvent.teamId)?.code ?? ''}`}
        onUndo={() => void takeAway(toastEvent.id)}
        onAddAssist={toastEvent.ownGoal ? null : () => (setToast(null), setPicker({ assist: toastEvent.id }))} onExpire={() => setToast(null)} />}
      <Picker title={pickTeam ? `Who scored for ${pickTeam.name}?` : assistTeam ? `Who assisted for ${assistTeam.name}?` : null}
        players={pickTeam ? squadOf(pickTeam) : squadOf(assistTeam).filter((p) => p.playerId !== assistEvent?.playerId)}
        extras={pickTeam ? [{ label: 'Own goal', value: 'own' }, { label: 'Unknown scorer', value: 'unknown' }] : undefined}
        onPick={(who) => (pickTeam ? goal(pickTeam, who) : assistEvent && change(assistEvent.id, 'add_assist', { assist_id: who }, patch(assistEvent.id, { assistId: who })))}
        onClose={() => {
          // The toast is gone by now: focus goes back to the Goal button of the Team that scored.
          if (assistTeam) document.querySelector<HTMLElement>(`button[aria-label="GOAL ${assistTeam.code}"]`)?.focus()
          setPicker(null)
        }} />
      {editEvent && (
        <EditGoal key={editEvent.id} event={editEvent} team={teamOf(editEvent.teamId)} players={squadOf(teamOf(editEvent.teamId))}
          onClose={() => setEditing(null)} onAssist={() => setPicker({ assist: editEvent.id })}
          onSave={(who, minute) => {
            const t = teamOf(editEvent.teamId)
            const was = editEvent.ownGoal ? 'own' : editEvent.playerId ?? 'unknown'
            const name = who === 'own' ? 'Own goal' : who === 'unknown' ? 'Unknown scorer' : t?.squad.find((p) => p.playerId === who)?.name ?? 'Unknown scorer'
            const old = scorerName(editEvent, t)
            const body = { player_id: who === 'own' || who === 'unknown' ? null : who, own_goal: who === 'own', minute }
            const next = patch(editEvent.id, { playerId: body.player_id, ownGoal: body.own_goal, minute, assistId: body.own_goal || body.player_id === editEvent.assistId ? null : editEvent.assistId })
            if (who === was && minute === editEvent.minute) return
            const player = who !== was
            setAsk({ title: player ? `Change the ${editEvent.minute}′ goal from ${old} to ${name}${minute !== editEvent.minute ? ` at ${minute}′` : ''}?` : `Change the ${editEvent.minute}′ goal to ${minute}′?`,
              before: player ? `${old} ${editEvent.minute}′` : `${editEvent.minute}′`, after: player ? `${name} ${minute}′` : `${minute}′`, action: 'Save goal', run: () => change(editEvent.id, 'edit_event', body, next) })
          }}
          onDelete={() => {
            const t = teamOf(editEvent.teamId)
            const rest = c.events.filter((x) => x.id !== editEvent.id)
            const who = scorerName(editEvent, t)
            setAsk({ title: `Delete the ${editEvent.minute}′ goal${editEvent.ownGoal || !editEvent.playerId ? ` (${who.toLowerCase()})` : ` by ${who}`}? The score becomes ${goalsOf(rest, home!.teamId)}–${goalsOf(rest, away!.teamId)}.`,
              before: `${editEvent.minute}′ goal`, after: 'Deleted', action: 'Delete goal', destructive: true, run: () => void takeAway(editEvent.id) })
          }} />
      )}
      <ConfirmSheet open={!!ask} title={ask?.title ?? ''} before={ask?.before ?? ''} after={ask?.after ?? ''} actionLabel={ask?.action ?? ''} destructive={ask?.destructive}
        note="This is logged." onClose={() => setAsk(null)} onConfirm={() => ask?.run()} />
      {(scorer ? c.holder : true) && c.match.status !== 'finished' && c.match.seasonStatus === 'started' && c.teams.length === 2 && !onAir && !airQueued && (
        <PrimaryButton label="Show on stream" onClick={busy ? undefined : () => void show()} />
      )}
    </main>
  )
}
