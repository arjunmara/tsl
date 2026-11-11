import { supabase } from './supabase'

/** A placed Team: grp is the group number (1 = Group A), or 0 for a knockout bracket; pos is the slot inside it. */
export type Slot = { id: string; grp: number; pos: number; teamId: string }

// The last read per Season, kept on the device (ids and numbers only): offline, the board shows it.
const drawKey = (seasonId: string) => `tsl-draw:${seasonId}`

/** The Season's placed Teams. Offline, the last read kept on this device; else { code }. */
export async function seasonDraw(seasonId: string): Promise<{ slots: Slot[] } | { code: 'offline' | 'unknown' }> {
  const kept = () => {
    try {
      const last = JSON.parse(localStorage.getItem(drawKey(seasonId)) ?? 'null') as Slot[] | null
      if (Array.isArray(last)) return { slots: last }
    } catch {
      // Blocked or bad storage: nothing kept.
    }
    return { code: 'offline' as const }
  }
  try {
    const { data, error, status } = await supabase.schema('app').from('draw_slot').select('id, grp, pos, team_id').eq('season_id', seasonId).order('grp').order('pos')
    if (error) return status === 0 || !navigator.onLine ? kept() : { code: 'unknown' }
    const slots = (data as { id: string; grp: number; pos: number; team_id: string }[]).map((r) => ({ id: r.id, grp: r.grp, pos: r.pos, teamId: r.team_id }))
    try {
      localStorage.setItem(drawKey(seasonId), JSON.stringify(slots))
    } catch {
      // Storage full or blocked: only the offline fallback is lost.
    }
    return { slots }
  } catch {
    return kept()
  }
}
