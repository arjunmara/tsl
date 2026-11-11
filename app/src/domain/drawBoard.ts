import type { OutboxEntry } from './commands'
import type { Structure } from './tournaments'
import type { Slot } from './draw'

/** The Draw as this device should show it: the read with this user's pending placements and send-backs laid over. */
export function overlayDraw(base: Slot[], queued: OutboxEntry[], seasonId: string): Slot[] {
  let slots = base.map((s) => ({ ...s }))
  for (const { name, args: a } of queued) {
    if (a.season_id !== seasonId) continue
    if (name === 'place_team_in_draw' && !slots.some((s) => s.grp === a.grp && s.pos === a.pos) && !slots.some((s) => s.teamId === a.team_id)) {
      slots.push({ id: String(a.slot_id), grp: Number(a.grp), pos: Number(a.pos), teamId: String(a.team_id) })
    } else if (name === 'unplace_team_from_draw') slots = slots.filter((s) => s.teamId !== a.team_id)
  }
  return slots
}

/** The slots a Structure offers, as columns: groups (Group A, B, ...) or one numbered bracket. None for a League. */
export function drawColumns(structure: Structure, approved: number): { grp: number; title: string; size: number }[] {
  if (structure.structure === 'groups_knockout' && structure.group_count && structure.teams_per_group) {
    return Array.from({ length: structure.group_count }, (_, i) => ({ grp: i + 1, title: `Group ${String.fromCharCode(65 + i)}`, size: structure.teams_per_group! }))
  }
  return structure.structure === 'knockout' && approved > 0 ? [{ grp: 0, title: 'Bracket', size: approved }] : []
}
