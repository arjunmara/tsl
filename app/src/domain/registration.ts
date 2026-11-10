import { noteVersion } from '../outbox'
import { serverNow } from './clock'
import { runCommand, type CommandResult, type OutboxEntry } from './commands'
import { inZone } from './format'
import { supabase } from './supabase'
import type { TeamStatus } from './teams'
import type { SeasonStatus } from './tournaments'

// The Registration link form (Story 2.2): the Team a redeemed link's grant is for, and the Season facts its banner needs.
export type RegistrationTeam = { id: string; name: string; code: string; kitColour: string | null; status: TeamStatus; version: number }
export type RegistrationForm = {
  team: RegistrationTeam; tournamentName: string; seasonNumber: number; seasonStatus: SeasonStatus; deadline: string | null
}

/** Redeems the link's token for this page's anonymous session (the server hashes it). link_dead: revoked, replaced or unknown. */
export const redeem = (token: string): Promise<CommandResult> => runCommand('redeem_registration_link', { token })

// The last form read, kept on the device with the hash of the link it was read through: offline, that link shows it.
const formKey = 'tsl-register-form'
type Kept = { hash: string; form: RegistrationForm }

/**
 * The form for this session's grant. No row (the grant's link was revoked or replaced) is link_dead. Offline, the last
 * read through this same link; else { code }. The Team's version becomes its edits' base.
 */
export async function registrationForm(hash: string): Promise<{ form: RegistrationForm } | { code: 'link_dead' | 'offline' | 'unknown' }> {
  const kept = () => {
    try {
      const k = JSON.parse(localStorage.getItem(formKey) ?? 'null') as Kept | null
      if (k?.hash === hash && k.form?.team) return { form: k.form }
    } catch {
      // Blocked or bad storage: nothing kept.
    }
    return { code: 'offline' as const }
  }
  try {
    const app = supabase.schema('app')
    const [t, f] = await Promise.all([
      app.from('team').select('id, name, code, kit_colour, status, version').limit(2),
      app.rpc('registration_form'),
    ])
    const failed = t.error ?? f.error
    if (failed) return t.status === 0 || f.status === 0 || !navigator.onLine ? kept() : { code: 'unknown' }
    const row = (t.data ?? [])[0] as { id: string; name: string; code: string; kit_colour: string | null; status: TeamStatus; version: number } | undefined
    const s = ((f.data ?? []) as { tournament_name: string; season_number: number; season_status: SeasonStatus; registration_deadline: string | null }[])[0]
    if (!row || !s || (t.data ?? []).length > 1) {
      forgetForm()
      return { code: 'link_dead' }
    }
    const form: RegistrationForm = {
      team: { id: row.id, name: row.name, code: row.code, kitColour: row.kit_colour, status: row.status, version: row.version },
      tournamentName: s.tournament_name, seasonNumber: s.season_number, seasonStatus: s.season_status, deadline: s.registration_deadline,
    }
    await noteVersion(row.id, row.version)
    try {
      localStorage.setItem(formKey, JSON.stringify({ hash, form } satisfies Kept))
    } catch {
      // Storage full or blocked: only the offline fallback is lost.
    }
    return { form }
  } catch {
    return kept()
  }
}

/** Forgets the kept form (the link no longer works). */
export function forgetForm() {
  try {
    localStorage.removeItem(formKey)
  } catch {
    // Blocked storage: nothing kept anyway.
  }
}

/** The Team with this session's pending edit_team changes laid over, in order. */
export function overlayTeam(team: RegistrationTeam, queued: OutboxEntry[]): RegistrationTeam {
  const t = { ...team }
  for (const { name, args: a } of queued) {
    if (name !== 'edit_team' || a.team_id !== t.id) continue
    if (typeof a.name === 'string') t.name = a.name
    if (typeof a.code === 'string') t.code = a.code
    if (typeof a.kit_colour === 'string') t.kitColour = a.kit_colour
  }
  return t
}

/**
 * Read-only once the Season has started, or after the Registration deadline (the last open day, Asia/Kathmandu) by the
 * server-corrected clock. Reopening one link for a reason is Story 2.9.
 */
export const registrationClosed = (f: RegistrationForm) =>
  !(f.seasonStatus === 'setup' || f.seasonStatus === 'registration') || (!!f.deadline && inZone(serverNow()).date > f.deadline)
