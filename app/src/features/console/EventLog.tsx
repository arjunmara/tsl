import { useEffect, useState } from 'react'
import { dividerText, eventText, scorerName, type Console, type ConsoleTeam, type EventKind, type MatchEvent, type SquadPlayer } from '../../domain/console'
import { Sheet } from '../../ui/Sheet'

const icons: Record<EventKind, string> = { card: '🟨', foul: '✋', sub: '🔄', timeout: '⏸', missed_penalty: '🥅' }

// The same query as the two-column layout in app.css, where the log scrolls on its own and so must take focus.
const GRID = '(min-width: 600px) and (min-height: 500px) and (orientation: landscape)'
function useScrolls() {
  const [on, setOn] = useState(() => matchMedia(GRID).matches)
  useEffect(() => {
    const q = matchMedia(GRID)
    const f = () => setOn(q.matches)
    q.addEventListener('change', f)
    return () => q.removeEventListener('change', f)
  }, [])
  return on
}

/** The Event log, newest first (Story 4.3 dividers, Story 4.4 goals). waiting: goals and changes still queued on this phone. */
export function EventLog({ c, waiting, onEdit }: { c: Console; waiting: Set<string>; onEdit: ((e: MatchEvent) => void) | null }) {
  const scrolls = useScrolls()
  const team = (e: MatchEvent) => c.teams.find((t) => t.teamId === e.teamId)
  const rows = c.events.filter((e) => e.kind === 'goal' || e.teamId || dividerText(e, c.rules))
  return (
    <section className="event-log-panel" aria-labelledby="event-log" tabIndex={scrolls ? 0 : undefined}>
      <h2 id="event-log" className="body-strong">Event log</h2>
      <ul className="event-log">
        {rows.map((e) => {
          if (e.kind !== 'goal' && !e.teamId) return <li key={e.id} className="body">{dividerText(e, c.rules)}</li>
          if (e.kind !== 'goal') {
            const text = eventText(e, team(e))
            return (
              <li key={e.id} className="body event-goal" data-event={e.id}>
                <span aria-hidden="true">{icons[e.kind as EventKind]}</span>
                <span className="body-strong">{e.minute}′</span>
                <span className="event-goal-text">{text}</span>
                {waiting.has(e.id) && <span className="meta event-waiting"><span aria-hidden="true">⏱ </span>Waiting</span>}
                {onEdit && !waiting.has(e.id) && <button type="button" className="ui-button ui-secondary" aria-label={`Edit event at ${e.minute}′: ${text}`} onClick={() => onEdit(e)}>Edit event</button>}
              </li>
            )
          }
          const who = scorerName(e, team(e))
          const assist = e.assistId ? team(e)?.squad.find((p) => p.playerId === e.assistId)?.name : null
          return (
            <li key={e.id} className="body event-goal" data-goal={e.id}>
              <span aria-hidden="true">⚽</span>
              <span className="body-strong">{e.minute}′</span>
              <span className="event-goal-text">{who}{assist ? ` · assist ${assist}` : ''} · {team(e)?.code}</span>
              {waiting.has(e.id) && <span className="meta event-waiting"><span aria-hidden="true">⏱ </span>Waiting</span>}
              {onEdit && !waiting.has(e.id) && <button type="button" className="ui-button ui-secondary" aria-label={`Edit goal at ${e.minute}′ by ${who}`} onClick={() => onEdit(e)}>Edit goal</button>}
            </li>
          )
        })}
      </ul>
      {!rows.length && <p className="meta">Nothing has happened yet.</p>}
    </section>
  )
}

/** The edit sheet of one goal: the scorer, the minute, "Add assist" and "Delete goal"; no time limit. Saving and deleting ask to confirm after it closes. */
export function EditGoal({ event, team, players, onSave, onAssist, onDelete, onClose }: {
  event: MatchEvent; team: ConsoleTeam | undefined; players: SquadPlayer[]
  onSave: (who: string, minute: number) => void; onAssist: () => void; onDelete: () => void; onClose: () => void
}) {
  const [who, setWho] = useState(event.ownGoal ? 'own' : event.playerId ?? 'unknown')
  const [text, setText] = useState(String(event.minute))
  const minute = /^\d{1,3}$/.test(text.trim()) && Number(text) <= 400 ? Number(text) : null
  const choice = (value: string, label: string) => (
    <button key={value} type="button" className="ui-button ui-secondary picker-tile" aria-pressed={who === value} onClick={() => setWho(value)}>{label}</button>
  )
  return (
    <Sheet open title={`Edit goal for ${team?.name ?? 'the Team'}`} dismissOutside onClose={onClose}>
      {({ close }) => (
        <>
          <ul className="picker-tiles">
            {players.map((p) => <li key={p.playerId}>{choice(p.playerId, p.shirt === null ? p.name : `${p.name} ${p.shirt}`)}</li>)}
          </ul>
          <div className="ui-sheet-actions">{choice('own', 'Own goal')}{choice('unknown', 'Unknown scorer')}</div>
          <label className="body" htmlFor="goal-minute">Minute of the goal</label>
          <input id="goal-minute" className="ui-input" inputMode="numeric" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
          {minute === null && <p className="meta ui-reason">Use whole minutes from 0 to 400, like 26.</p>}
          <div className="ui-sheet-actions">
            <button type="button" className="ui-button ui-primary" disabled={minute === null} onClick={() => { close(); onSave(who, minute!) }}>Save goal</button>
            {!event.ownGoal && <button type="button" className="ui-button ui-secondary" onClick={() => { close(); onAssist() }}>Add assist</button>}
            <button type="button" className="ui-button ui-secondary ui-destructive" onClick={() => { close(); onDelete() }}>Delete goal</button>
            <button type="button" className="ui-button ui-secondary" onClick={close}>Cancel</button>
          </div>
        </>
      )}
    </Sheet>
  )
}

/** The edit sheet of a card, sub, foul, timeout or missed penalty: the Player (not a foul or timeout) and the minute, and "Delete event". Saving and deleting ask to confirm after it closes. */
export function EditEvent({ event, team, players, onSave, onDelete, onClose }: {
  event: MatchEvent; team: ConsoleTeam | undefined; players: SquadPlayer[]
  onSave: (who: string | null, minute: number) => void; onDelete: () => void; onClose: () => void
}) {
  const [who, setWho] = useState(event.playerId ?? null)
  const [text, setText] = useState(String(event.minute))
  const minute = /^\d{1,3}$/.test(text.trim()) && Number(text) <= 400 ? Number(text) : null
  const hasPlayer = event.kind !== 'foul' && event.kind !== 'timeout'
  return (
    <Sheet open title={`Edit event for ${team?.name ?? 'the Team'}`} dismissOutside onClose={onClose}>
      {({ close }) => (
        <>
          {hasPlayer && (
            <ul className="picker-tiles">
              {players.filter((p) => p.playerId !== event.playerOnId).map((p) => (
                <li key={p.playerId}>
                  <button type="button" className="ui-button ui-secondary picker-tile" aria-pressed={who === p.playerId} onClick={() => setWho(p.playerId)}>{p.shirt === null ? p.name : `${p.name} ${p.shirt}`}</button>
                </li>
              ))}
            </ul>
          )}
          <label className="body" htmlFor="event-minute">Minute of the event</label>
          <input id="event-minute" className="ui-input" inputMode="numeric" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
          {minute === null && <p className="meta ui-reason">Use whole minutes from 0 to 400, like 26.</p>}
          <div className="ui-sheet-actions">
            <button type="button" className="ui-button ui-primary" disabled={minute === null} onClick={() => { close(); onSave(who, minute!) }}>Save event</button>
            <button type="button" className="ui-button ui-secondary ui-destructive" onClick={() => { close(); onDelete() }}>Delete event</button>
            <button type="button" className="ui-button ui-secondary" onClick={close}>Cancel</button>
          </div>
        </>
      )}
    </Sheet>
  )
}
