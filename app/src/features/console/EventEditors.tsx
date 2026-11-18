import type { Console, ConsoleTeam, MatchEvent } from '../../domain/console'
import { eventText, goalsOf, scorerName, subChangeReason } from '../../domain/console'
import { EditEvent, EditGoal } from './EventLog'

export type Ask = { title: string; before: string; after: string; action: string; destructive?: boolean; run: () => void }

/**
 * The edit sheet of the Event log row being edited (a goal or another event) with the Confirm texts of its Save and Delete, shared by the console and
 * the finished Match's page (Story 4.6). change sends one edit in the event's own chain, takeAway deletes (or drops a queued) event.
 */
export function EventEditors({ c, home, away, editing, onClose, onAssist, picksOf, setProblem, ask, change, takeAway }: {
  c: Console; home: ConsoleTeam; away: ConsoleTeam; editing: string | null; onClose: () => void; onAssist: (id: string) => void
  picksOf: (t: ConsoleTeam) => Record<string, 'start' | 'bench'>; setProblem: (text: string) => void; ask: (a: Ask) => void
  change: (id: string, name: string, args: Record<string, unknown>, apply: (events: MatchEvent[]) => MatchEvent[]) => void; takeAway: (id: string) => void
}) {
  const teamOf = (id: string | null | undefined) => c.teams.find((t) => t.teamId === id)
  const patch = (id: string, p: Partial<MatchEvent>) => (events: MatchEvent[]) => events.map((x) => (x.id === id ? { ...x, ...p } : x))
  const editEvent = c.events.find((x) => x.id === editing && x.kind === 'goal')
  const editOther = c.events.find((x) => x.id === editing && x.kind !== 'goal')
  return (
    <>
      {editOther && (
        <EditEvent key={editOther.id} event={editOther} team={teamOf(editOther.teamId)} players={teamOf(editOther.teamId)?.squad ?? []} onClose={onClose}
          onSave={(who, minute) => {
            const t = teamOf(editOther.teamId)
            const player = who ?? editOther.playerId ?? null
            if (player === (editOther.playerId ?? null) && minute === editOther.minute) return
            const blocked = t && editOther.kind === 'sub' && subChangeReason(t, picksOf(t), c.events, editOther.id, 'edit', player)
            if (blocked) return setProblem(blocked)
            const old = eventText(editOther, t)
            const now = eventText({ ...editOther, playerId: player }, t)
            ask({ title: `Change "${old}" at ${editOther.minute}′ to "${now}" at ${minute}′?`, before: `${old} ${editOther.minute}′`, after: `${now} ${minute}′`, action: 'Save event',
              run: () => change(editOther.id, 'edit_event', { player_id: player, own_goal: false, minute }, patch(editOther.id, { playerId: player, minute })) })
          }}
          onDelete={() => {
            const t = teamOf(editOther.teamId)
            const blocked = t && editOther.kind === 'sub' && subChangeReason(t, picksOf(t), c.events, editOther.id, 'delete', null)
            if (blocked) return setProblem(blocked)
            const text = eventText(editOther, t)
            ask({ title: `Delete "${text}" at ${editOther.minute}′?`, before: `${text} ${editOther.minute}′`, after: 'Deleted', action: 'Delete event', destructive: true, run: () => takeAway(editOther.id) })
          }} />
      )}
      {editEvent && (
        <EditGoal key={editEvent.id} event={editEvent} team={teamOf(editEvent.teamId)} players={teamOf(editEvent.teamId)?.squad ?? []}
          onClose={onClose} onAssist={() => onAssist(editEvent.id)}
          onSave={(who, minute) => {
            const t = teamOf(editEvent.teamId)
            const was = editEvent.ownGoal ? 'own' : editEvent.playerId ?? 'unknown'
            const name = who === 'own' ? 'Own goal' : who === 'unknown' ? 'Unknown scorer' : t?.squad.find((p) => p.playerId === who)?.name ?? 'Unknown scorer'
            const old = scorerName(editEvent, t)
            const body = { player_id: who === 'own' || who === 'unknown' ? null : who, own_goal: who === 'own', minute }
            const next = patch(editEvent.id, { playerId: body.player_id, ownGoal: body.own_goal, minute, assistId: body.own_goal || body.player_id === editEvent.assistId ? null : editEvent.assistId })
            if (who === was && minute === editEvent.minute) return
            const player = who !== was
            ask({ title: player ? `Change the ${editEvent.minute}′ goal from ${old} to ${name}${minute !== editEvent.minute ? ` at ${minute}′` : ''}?` : `Change the ${editEvent.minute}′ goal to ${minute}′?`,
              before: player ? `${old} ${editEvent.minute}′` : `${editEvent.minute}′`, after: player ? `${name} ${minute}′` : `${minute}′`, action: 'Save goal', run: () => change(editEvent.id, 'edit_event', body, next) })
          }}
          onDelete={() => {
            const t = teamOf(editEvent.teamId)
            const rest = c.events.filter((x) => x.id !== editEvent.id)
            const who = scorerName(editEvent, t)
            ask({ title: `Delete the ${editEvent.minute}′ goal${editEvent.ownGoal || !editEvent.playerId ? ` (${who.toLowerCase()})` : ` by ${who}`}? The score becomes ${goalsOf(rest, home.teamId)}–${goalsOf(rest, away.teamId)}.`,
              before: `${editEvent.minute}′ goal`, after: 'Deleted', action: 'Delete goal', destructive: true, run: () => takeAway(editEvent.id) })
          }} />
      )}
    </>
  )
}
