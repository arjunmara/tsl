import { appUrl } from './appUrl'
import type { OutboxEntry } from './commands'
import { supabase } from './supabase'

export type TeamStatus = 'invited' | 'submitted' | 'approved' | 'returned'
/** A Team as its row and the Teams tab show it; linkId is its active Registration link, null when it has none. */
export type Team = { id: string; name: string; code: string; kitColour: string | null; status: TeamStatus; linkId: string | null }

type Row = { id: string; name: string; code: string; kit_colour: string | null; status: TeamStatus; registration_link: { id: string; revoked_at: string | null }[] }

// The last read per Season, kept on the device (names and codes only, no tokens): offline, the tab shows it.
const teamsKey = (seasonId: string) => `tsl-teams:${seasonId}`

/** The Season's Teams in the order they were added. Offline, the last read kept on this device; else { code }. */
export async function seasonTeams(seasonId: string): Promise<{ teams: Team[] } | { code: 'offline' | 'unknown' }> {
  const kept = () => {
    try {
      const last = JSON.parse(localStorage.getItem(teamsKey(seasonId)) ?? 'null') as Team[] | null
      if (Array.isArray(last)) return { teams: last }
    } catch {
      // Blocked or bad storage: nothing kept.
    }
    return { code: 'offline' as const }
  }
  try {
    const { data, error, status } = await supabase.schema('app').from('team')
      .select('id, name, code, kit_colour, status, registration_link(id, revoked_at)').eq('season_id', seasonId).is('registration_link.revoked_at', null).order('created_at').order('id')
    if (error) return status === 0 || !navigator.onLine ? kept() : { code: 'unknown' }
    const teams = ((data ?? []) as Row[]).map((r) => ({
      id: r.id, name: r.name, code: r.code, kitColour: r.kit_colour, status: r.status,
      linkId: r.registration_link.find((l) => !l.revoked_at)?.id ?? null,
    }))
    try {
      localStorage.setItem(teamsKey(seasonId), JSON.stringify(teams))
    } catch {
      // Storage full or blocked: only the offline fallback is lost.
    }
    return { teams }
  } catch {
    return kept()
  }
}

/** The Teams as this device should show them: the read with this user's pending Team commands laid over, in order. */
export function overlayTeams(base: Team[], queued: OutboxEntry[], seasonId: string): Team[] {
  const teams = base.map((t) => ({ ...t }))
  for (const { name, args: a } of queued) {
    if (a.season_id !== seasonId) continue
    const t = teams.find((x) => x.id === a.team_id || (name === 'revoke_registration_link' && x.linkId === a.link_id))
    if (name === 'add_team' && !t) {
      teams.push({ id: String(a.team_id), name: String(a.name), code: String(a.code), kitColour: null, status: 'invited', linkId: String(a.link_id) })
    } else if (name === 'reissue_registration_link' && t) t.linkId = String(a.link_id)
    else if (name === 'revoke_registration_link' && t) t.linkId = null
  }
  return teams
}

// The plain token never leaves the device that made it: kept here per link id, so this phone can share the link again
// and a queued reissue that is later refused never loses the old link. Any other phone makes a new link instead.
const linkKey = (linkId: string) => `tsl-link:${linkId}`

/** Keeps (or with null, forgets) a link's token on this device. */
export function rememberLink(linkId: string, token: string | null) {
  try {
    if (token) localStorage.setItem(linkKey(linkId), token)
    else localStorage.removeItem(linkKey(linkId))
  } catch {
    // Blocked storage: the link can't be shared again from this phone; a new link can still be made.
  }
}

/** The token of a link when this device made it, else null. */
export function linkToken(linkId: string | null): string | null {
  try {
    return linkId ? localStorage.getItem(linkKey(linkId)) : null
  } catch {
    return null
  }
}

/** The link a Team manager opens: the token in the fragment, so it never reaches server logs or Referer headers. */
export const registrationUrl = (token: string) => `${appUrl()}/register#${token}`
