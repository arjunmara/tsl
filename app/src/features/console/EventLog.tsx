import { useState } from 'react'
import { dividerText, scorerName, type Console, type ConsoleTeam, type MatchEvent, type SquadPlayer } from '../../domain/console'
import { Sheet } from '../../ui/Sheet'

/** The Event log, newest first (Story 4.3 dividers, Story 4.4 goals). waiting: goals and changes still queued on this phone. */
export function EventLog({ c, waiting, onEdit }: { c: Console; waiting: Set<string>; onEdit: ((e: MatchEvent) => void) | null }) {
  const team = (e: MatchEvent) => c.teams.find((t) => t.teamId === e.teamId)
  const rows = c.events.filter((e) => e.kind === 'goal' || dividerText(e, c.rules))
  return (
    <section aria-labelledby="event-log">
      <h2 id="event-log" className="body-strong">Event log</h2>
      <ul className="event-log">
        {rows.map((e) => {
          if (e.kind !== 'goal') return <li key={e.id} className="body">{dividerText(e, c.rules)}</li>
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
            {players.map((p) => <li key={p.playerId}>{choice(p.playerId, `${p.name} ${p.shirt}`)}</li>)}
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
