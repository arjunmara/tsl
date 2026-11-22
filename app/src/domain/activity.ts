import { supabase } from './supabase'

/** One Activity log row as app.activity_view gives it (who, Team, Match and Season already worked out). */
export type ActivityRow = {
  id: number; at: string; who: string; table: string; op: 'insert' | 'update' | 'delete'
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; reason: string | null
  teamId: string | null; teamIds: string[]; matchId: string | null
}
export type ActivityFilter = { teamId?: string; matchId?: string; who?: string }
export const PAGE = 50

type Row = { id: number; at: string; who: string | null; table_name: string; op: ActivityRow['op']; before: ActivityRow['before']; after: ActivityRow['after']
  reason: string | null; team_id: string | null; team_ids: string[] | null; match_id: string | null }

// The newest page per Season, kept on the device: offline, the log shows it.
const key = (uid: string, seasonId: string) => `tsl-activity:${uid}:${seasonId}`
const none = (f: ActivityFilter) => !f.teamId && !f.matchId && !f.who
const fits = (r: ActivityRow, f: ActivityFilter) => (!f.teamId || r.teamIds.includes(f.teamId)) && (!f.matchId || r.matchId === f.matchId) && (!f.who || r.who === f.who)

/**
 * The Season's log rows newest first (and the Tournament-wide rows with no Season), PAGE after `beforeId`. `more` says another page may
 * follow. Offline: the last newest page kept on this device, with the filters applied to it, and `offline` true; else { code }.
 */
export async function activityPage(seasonId: string, filter: ActivityFilter, beforeId?: number):
  Promise<{ rows: ActivityRow[]; more: boolean; offline: boolean } | { code: 'unknown' }> {
  // The kept page is per signed-in user: another account on this phone must not read it.
  const uid = (await supabase.auth.getSession()).data.session?.user.id ?? ''
  const kept = () => {
    if (beforeId !== undefined) return { rows: [], more: false, offline: true }
    try {
      const last = JSON.parse(localStorage.getItem(key(uid, seasonId)) ?? 'null') as ActivityRow[] | null
      if (Array.isArray(last)) return { rows: last.filter((r) => fits(r, filter)), more: false, offline: true }
    } catch {
      // Blocked or bad storage: nothing kept.
    }
    return { rows: [], more: false, offline: true }
  }
  if (!navigator.onLine) return kept()
  try {
    let q = supabase.schema('app').from('activity_view')
      .select('id, at, who, table_name, op, before, after, reason, team_id, team_ids, match_id')
      .or(`season_id.eq.${seasonId},season_id.is.null`).order('id', { ascending: false }).limit(PAGE + 1)
    if (beforeId !== undefined) q = q.lt('id', beforeId)
    if (filter.teamId) q = q.contains('team_ids', [filter.teamId])
    if (filter.matchId) q = q.eq('match_id', filter.matchId)
    if (filter.who) q = q.eq('who', filter.who)
    const { data, error, status } = await q
    if (error) return status === 0 || !navigator.onLine ? kept() : { code: 'unknown' }
    const all = (data as Row[]).map((r): ActivityRow => ({ id: Number(r.id), at: r.at, who: r.who ?? '', table: r.table_name, op: r.op, before: r.before, after: r.after,
      reason: r.reason, teamId: r.team_id, teamIds: r.team_ids ?? [], matchId: r.match_id }))
    const rows = all.slice(0, PAGE)
    if (beforeId === undefined && none(filter)) {
      try {
        localStorage.setItem(key(uid, seasonId), JSON.stringify(rows))
      } catch {
        // Storage full or blocked: only the offline fallback is lost.
      }
    }
    return { rows, more: all.length > PAGE, offline: false }
  } catch {
    return kept()
  }
}

/** A row's change in parts: `text` ("Added", "Removed", "Date of birth changed"), or a field with its old value (struck through) and new one. */
export type ActivityLine = { key: string; label: string; text?: string; old?: string; now?: string }

/**
 * What a row changed. Technical columns (ids, version, timestamps) are skipped. A personal field is logged as its own name,
 * so it can only say "changed", never show a value. `label` and `show` are the field label and value words used in the hand-back sheet.
 */
export function activityLines(r: ActivityRow, label: (k: string) => string, show: (k: string, v: unknown) => string): ActivityLine[] {
  if (r.op === 'insert') return [{ key: '', label: '', text: 'Added' }]
  if (r.op === 'delete') return [{ key: '', label: '', text: 'Removed' }]
  const b = r.before ?? {}
  const a = r.after ?? {}
  const lines: ActivityLine[] = []
  // A Season award changes its Player (an id, so never shown): say so in words.
  if (r.table === 'season_awards') return [{ key: 'player', label: 'Player', text: 'Player changed' }]
  for (const k of Object.keys(a)) {
    if (k === 'id' || k === 'version' || k.endsWith('_id') || k.endsWith('_at')) continue
    // A personal field is logged as its own name, or "<name>:changed" when an update changed it.
    if (a[k] === k || b[k] === k || a[k] === `${k}:changed`) {
      if (a[k] !== b[k]) lines.push({ key: k, label: label(k), text: `${label(k)} changed` })
    } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) lines.push({ key: k, label: label(k), old: show(k, b[k]), now: show(k, a[k]) })
  }
  return lines
}
