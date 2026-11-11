import { noteVersion } from '../outbox'
import { serverNow } from './clock'
import { runCommand, type CommandResult, type OutboxEntry } from './commands'
import { inZone } from './format'
import { supabase } from './supabase'
import type { TeamStatus } from './teams'
import type { SeasonStatus } from './tournaments'

// The Registration link form (Story 2.2): the Team a redeemed link's grant is for, and the Season facts its banner needs.
export type RegistrationTeam = {
  id: string; tournamentId: string; name: string; code: string; kitColour: string | null; status: TeamStatus; version: number
  /** The Organiser's note while the Team is returned (Story 2.8); absent in a copy kept before it. */
  returnNote?: string | null
  /** The link is open through this day for this reason, even after the deadline (Story 2.9). */
  reopenedUntil?: string | null; reopenReason?: string | null
}
/** Eligibility documents a Player can prove eligibility with, and their words. */
export const DOCUMENT_TYPES = [
  ['emis', 'EMIS number'], ['birth_certificate', 'Birth certificate'], ['citizenship', 'Citizenship'], ['passport', 'Passport'],
] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number][0]
export const documentLabel = (t: string | null) => DOCUMENT_TYPES.find(([k]) => k === t)?.[1] ?? ''
/** The private bucket for document scans: the Team manager may add a scan but never read one (Story 2.4). */
export const scanBucket = 'eligibility-scans'
/**
 * A Player's Eligibility proof for the Season as the Team manager sees it: the scan only by its file name, never the
 * scan itself. version: the record's (edit_eligibility, verify_eligibility). scanPath / uploadedAt: only in an Organiser's
 * read (Story 2.7), for the scan viewer.
 */
export type Eligibility = {
  id: string; documentType: DocumentType | null; documentNumber: string; scanName: string | null; verified: boolean; version: number
  scanPath?: string | null; uploadedAt?: string | null
}
/** The private bucket for Player and Staff photos, fenced by Tournament (Story 2.5). */
export const photoBucket = 'player-photos'
/** A stored photo: cutout false = kept with its background. url: signed for an hour (null offline or still queued). */
export type Photo = { path: string; cutout: boolean; url: string | null }
/** A Player in this Team's Squad with their Photo consent and Eligibility proof for its Season. version: the Player card's (edit_player). */
export type SquadPlayer = {
  id: string; name: string; shirtNumber: number; dateOfBirth: string; consent: boolean; givenBy: string | null; version: number
  eligibility: Eligibility | null; photo: Photo | null
}
export type StaffMember = { id: string; name: string; role: string; version: number; photo: Photo | null }
/** The Season's photo-consent statement and Line-up rules (null: not set). */
export type SquadRules = { consentStatement: string; starters: number | null; maxBench: number | null; staffRoles: string[] }
export type RegistrationForm = {
  team: RegistrationTeam; tournamentName: string; seasonNumber: number; seasonStatus: SeasonStatus; deadline: string | null
  rules: SquadRules; players: SquadPlayer[]; staff: StaffMember[]
  /** Read by an Organiser of the Tournament (teamForm): the scan viewer and "Mark verified" show. */
  organiser?: boolean
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
      // A copy kept before Story 2.3 has no Squad, and before 2.4 no Eligibility: shown with none.
      if (k?.hash === hash && k.form?.team) return { form: { ...k.form, rules: k.form.rules ?? NO_RULES,
        players: (k.form.players ?? []).map((p) => ({ ...p, eligibility: p.eligibility ?? null, photo: p.photo ?? null })),
        staff: (k.form.staff ?? []).map((x) => ({ ...x, photo: x.photo ?? null })) } }
    } catch {
      // Blocked or bad storage: nothing kept.
    }
    return { code: 'offline' as const }
  }
  try {
    const app = supabase.schema('app')
    const [t, f, ru, sq, st, el] = await Promise.all([
      app.from('team').select('id, tournament_id, name, code, kit_colour, status, return_note, reopened_until, reopen_reason, version').limit(2),
      app.rpc('registration_form'),
      app.rpc('registration_rules'),
      app.from('squad_entry').select('team_id, shirt_number, player(id, name, date_of_birth, version, photo_path, is_cutout, photo_consent(consent_given, given_by))')
        .order('shirt_number'),
      app.from('staff').select('team_id, id, name, role, version, photo_path, is_cutout').order('created_at').order('id'),
      app.rpc('registration_eligibility'),
    ])
    const all = [t, f, ru, sq, st, el]
    if (all.some((x) => x.error)) return all.some((x) => x.error && x.status === 0) || !navigator.onLine ? kept() : { code: 'unknown' }
    const row = (t.data ?? [])[0] as {
      id: string; tournament_id: string; name: string; code: string; kit_colour: string | null; status: TeamStatus; return_note: string | null
      reopened_until: string | null; reopen_reason: string | null; version: number
    } | undefined
    const s = ((f.data ?? []) as { tournament_name: string; season_number: number; season_status: SeasonStatus; registration_deadline: string | null }[])[0]
    if (!row || !s || (t.data ?? []).length > 1) {
      forgetForm()
      return { code: 'link_dead' }
    }
    const form: RegistrationForm = {
      team: { id: row.id, tournamentId: row.tournament_id, name: row.name, code: row.code, kitColour: row.kit_colour, status: row.status, returnNote: row.return_note,
        reopenedUntil: row.reopened_until, reopenReason: row.reopen_reason, version: row.version },
      tournamentName: s.tournament_name, seasonNumber: s.season_number, seasonStatus: s.season_status, deadline: s.registration_deadline,
      // RLS already limits the grant to its Team; the filter keeps any other Team's rows out of this form regardless.
      rules: rulesFrom(ru.data), players: withEligibility(((sq.data ?? []) as unknown as EntryRow[]).filter((e) => e.team_id === row.id)
        .flatMap(playerFrom), el.data),
      staff: ((st.data ?? []) as StaffRow[]).filter((x) => x.team_id === row.id)
        .map(({ id, name, role, version, photo_path, is_cutout }) => ({ id, name, role, version, photo: photoFrom(photo_path, is_cutout) })),
    }
    await signPhotos([...form.players, ...form.staff])
    const records = form.players.flatMap((p) => (p.eligibility ? [p.eligibility] : []))
    await Promise.all([row, ...form.players, ...form.staff, ...records].map((x) => noteVersion(x.id, x.version)))
    try {
      // Once closed the form never shows a date of birth, document number or scan file name, so this phone stops keeping them.
      // Signed photo URLs expire within the hour, so none is kept.
      const unsigned = { ...form, players: form.players.map((p) => ({ ...p, photo: p.photo && { ...p.photo, url: null } })),
        staff: form.staff.map((x) => ({ ...x, photo: x.photo && { ...x.photo, url: null } })) }
      const keep = registrationClosed(form) ? { ...unsigned, players: unsigned.players.map((p) => ({ ...p, dateOfBirth: '',
        eligibility: p.eligibility && { ...p.eligibility, documentNumber: '', scanName: null } })) } : unsigned
      localStorage.setItem(formKey, JSON.stringify({ hash, form: keep } satisfies Kept))
    } catch {
      // Storage full or blocked: only the offline fallback is lost.
    }
    return { form }
  } catch {
    return kept()
  }
}

/**
 * The same form read by an Organiser of the Team's Tournament (Story 2.6), straight from the tables their membership
 * reads. Not kept on the device: offline it's { code: 'offline' }. missing: no such Team in this Season for this user.
 */
export async function teamForm(seasonId: string, teamId: string): Promise<{ form: RegistrationForm } | { code: 'missing' | 'offline' | 'unknown' }> {
  try {
    const app = supabase.schema('app')
    const [t, sq, st, el] = await Promise.all([
      app.from('team').select('id, tournament_id, name, code, kit_colour, status, return_note, reopened_until, reopen_reason, version, tournament(name), '
        + 'season(number, status, registration_deadline, photo_consent, starters, max_bench, staff_roles)').eq('season_id', seasonId).eq('id', teamId),
      app.from('squad_entry').select('team_id, shirt_number, player(id, name, date_of_birth, version, photo_path, is_cutout, photo_consent(season_id, consent_given, given_by))')
        .eq('team_id', teamId).order('shirt_number'),
      app.from('staff').select('team_id, id, name, role, version, photo_path, is_cutout').eq('team_id', teamId).order('created_at').order('id'),
      app.from('eligibility_record').select('id, player_id, document_type, document_number, scan_name, scan_path, scan_uploaded_at, verified_at, version').eq('season_id', seasonId),
    ])
    const all = [t, sq, st, el]
    if (all.some((x) => x.error)) return { code: all.some((x) => x.error && x.status === 0) || !navigator.onLine ? 'offline' : 'unknown' }
    type TeamRow = {
      id: string; tournament_id: string; name: string; code: string; kit_colour: string | null; status: TeamStatus; return_note: string | null
      reopened_until: string | null; reopen_reason: string | null; version: number
      tournament: { name: string } | null
      season: { number: number; status: SeasonStatus; registration_deadline: string | null; photo_consent: string | null; starters: number | null
        max_bench: number | null; staff_roles: string[] | null } | null
    }
    const row = (Array.isArray(t.data) ? t.data as unknown as TeamRow[] : []).find((x) => x.id === teamId)
    if (!row?.season) return { code: 'missing' }
    const s = row.season
    // Consent is per Season: only this Season's row counts.
    const entries = (Array.isArray(sq.data) ? sq.data as unknown as EntryRow[] : []).filter((e) => e.team_id === teamId)
      .map((e) => (e.player ? { ...e, player: { ...e.player, photo_consent: (e.player.photo_consent ?? [])
        .filter((c) => (c as { season_id?: string }).season_id === seasonId) } } : e))
    const records = (Array.isArray(el.data) ? el.data as { verified_at: string | null }[] : []).map((r) => ({ ...r, verified: !!r.verified_at }))
    const form: RegistrationForm = {
      team: { id: row.id, tournamentId: row.tournament_id, name: row.name, code: row.code, kitColour: row.kit_colour, status: row.status, returnNote: row.return_note,
        reopenedUntil: row.reopened_until, reopenReason: row.reopen_reason, version: row.version },
      tournamentName: row.tournament?.name ?? '', seasonNumber: s.number, seasonStatus: s.status, deadline: s.registration_deadline,
      rules: rulesFrom([{ consent_statement: s.photo_consent, starters: s.starters, max_bench: s.max_bench, staff_roles: s.staff_roles }]),
      players: withEligibility(entries.flatMap(playerFrom), records),
      staff: (Array.isArray(st.data) ? st.data as StaffRow[] : []).filter((x) => x.team_id === teamId)
        .map(({ id, name, role, version, photo_path, is_cutout }) => ({ id, name, role, version, photo: photoFrom(photo_path, is_cutout) })),
      organiser: true,
    }
    await signPhotos([...form.players, ...form.staff])
    const eligibility = form.players.flatMap((p) => (p.eligibility ? [p.eligibility] : []))
    await Promise.all([form.team, ...form.players, ...form.staff, ...eligibility].map((x) => noteVersion(x.id, x.version)))
    return { form }
  } catch {
    return { code: navigator.onLine ? 'unknown' : 'offline' }
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

/** The link's last open day: the deadline, or the Team's reopen date if later (Story 2.9). null: no deadline. */
export const lastOpenDay = (f: RegistrationForm): string | null => {
  const r = f.team.reopenedUntil
  return f.deadline && r && r > f.deadline ? r : f.deadline
}
/** When the link closes: the end of its last open day in Asia/Kathmandu (+05:45, no daylight saving), in ms. */
export const closesAt = (f: RegistrationForm): number | null => {
  const day = lastOpenDay(f)
  return day ? Date.parse(`${day}T00:00:00+05:45`) + 86_400_000 : null
}
/** True while the Team's link is reopened past the deadline. */
export const reopened = (f: RegistrationForm) => !!f.team.reopenReason && lastOpenDay(f) !== f.deadline
/**
 * Read-only once the Season has started, or once the link closes by the server-corrected clock. The server decides
 * the same in app.season_allows, counting a queued change by when it was made, within its grace window.
 */
export const registrationClosed = (f: RegistrationForm, now = serverNow().getTime()) => {
  const end = closesAt(f)
  return !(f.seasonStatus === 'setup' || f.seasonStatus === 'registration') || (end !== null && now >= end)
}

type StaffRow = { team_id: string; id: string; name: string; role: string; version: number; photo_path: string | null; is_cutout: boolean | null }
const photoFrom = (path: string | null, cutout: boolean | null): Photo | null => (path ? { path, cutout: !!cutout, url: null } : null)
/** Signs each stored photo's URL in one call (an hour); on failure the photos show without a picture. */
async function signPhotos(people: { photo: Photo | null }[]) {
  const photos = people.flatMap((p) => (p.photo ? [p.photo] : []))
  if (!photos.length) return
  try {
    const { data } = await supabase.storage.from(photoBucket).createSignedUrls(photos.map((p) => p.path), 3600)
    for (const p of photos) p.url = data?.find((d) => d.path === p.path)?.signedUrl ?? null
  } catch {
    // Unreachable: no pictures this time.
  }
}
type EntryRow = { team_id: string; shirt_number: number; player: { id: string; name: string; date_of_birth: string | null; version: number
  photo_path: string | null; is_cutout: boolean | null
  photo_consent: { consent_given: boolean; given_by: string | null }[] } | null }
const playerFrom = (e: EntryRow): SquadPlayer[] => e.player ? [{
  id: e.player.id, name: e.player.name, shirtNumber: e.shirt_number, dateOfBirth: e.player.date_of_birth ?? '', version: e.player.version,
  consent: e.player.photo_consent[0]?.consent_given ?? false, givenBy: e.player.photo_consent[0]?.given_by ?? null, eligibility: null,
  photo: photoFrom(e.player.photo_path, e.player.is_cutout),
}] : []
type EligibilityRow = { id: string; player_id: string; document_type: DocumentType | null; document_number: string | null
  scan_name: string | null; verified: boolean; version: number; scan_path?: string | null; scan_uploaded_at?: string | null }
function withEligibility(players: SquadPlayer[], data: unknown): SquadPlayer[] {
  const rows = Array.isArray(data) ? (data as EligibilityRow[]) : []
  return players.map((p) => {
    const r = rows.find((x) => x.player_id === p.id)
    return r ? { ...p, eligibility: { id: r.id, documentType: r.document_type, documentNumber: r.document_number ?? '', scanName: r.scan_name,
      verified: r.verified, version: r.version,
      ...('scan_path' in r ? { scanPath: r.scan_path ?? null, uploadedAt: r.scan_uploaded_at ?? null } : {}) } } : p
  })
}
const NO_RULES: SquadRules = { consentStatement: '', starters: null, maxBench: null, staffRoles: [] }
function rulesFrom(data: unknown): SquadRules {
  const r = ((data ?? []) as { consent_statement: string | null; starters: number | null; max_bench: number | null; staff_roles: string[] | null }[])[0]
  return { consentStatement: r?.consent_statement ?? '', starters: r?.starters ?? null, maxBench: r?.max_bench ?? null, staffRoles: r?.staff_roles ?? [] }
}

/**
 * A short-lived URL for one scan (Story 2.7): five minutes, Organisers only (Storage refuses anyone else, and any scan
 * no unverified record points to). null when it can't be signed (offline, verified meanwhile).
 */
export async function signScan(path: string): Promise<string | null> {
  try {
    const { data } = await supabase.storage.from(scanBucket).createSignedUrl(path, 300)
    return data?.signedUrl ?? null
  } catch {
    return null
  }
}

/** Under 18 on this day (YYYY-MM-DD; the server's Asia/Kathmandu day): consent then needs a parent or guardian's name. */
export function isMinor(dateOfBirth: string, today = inZone(serverNow()).date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return false
  // Compared as text, so a 29 Feb birthday turns 18 on 1 Mar of a common year, as the server's date_of_birth > today - 18 years.
  return `${Number(dateOfBirth.slice(0, 4)) + 18}${dateOfBirth.slice(4)}` > today
}

/** A Player or Staff member added on this device starts at version 1, so its edits replay before any read. */
export const noteNew = (id: string) => noteVersion(id, 1)

/** The form with this session's pending Squad, Staff, Eligibility, photo and submit commands laid over, in order. */
export function overlaySquad(form: RegistrationForm, queued: OutboxEntry[]): RegistrationForm {
  let players = form.players.map((p) => ({ ...p }))
  let staff = form.staff.map((x) => ({ ...x }))
  let team = form.team
  for (const { name, args: a } of queued) {
    if (a.team_id !== team.id) continue
    if (name === 'add_player' && !players.some((p) => p.id === a.player_id)) {
      players.push({ id: String(a.player_id), name: String(a.name), shirtNumber: Number(a.shirt_number), dateOfBirth: String(a.date_of_birth),
        consent: a.consent === true, givenBy: a.consent === true ? String(a.given_by ?? '') : null, version: 1, eligibility: null, photo: null })
    } else if (name === 'edit_player') {
      const p = players.find((x) => x.id === a.player_id)
      if (!p) continue
      if (typeof a.name === 'string') p.name = a.name
      if (typeof a.shirt_number === 'number') p.shirtNumber = a.shirt_number
      if (typeof a.date_of_birth === 'string') p.dateOfBirth = a.date_of_birth
      if (typeof a.consent === 'boolean') p.consent = a.consent
      if (typeof a.given_by === 'string') p.givenBy = a.given_by
      if (!p.consent) p.givenBy = null
    } else if (name === 'add_eligibility' || name === 'edit_eligibility') {
      const p = players.find((x) => x.id === a.player_id)
      if (!p || (name === 'add_eligibility' ? p.eligibility : !p.eligibility)) continue
      const e: Eligibility = p.eligibility ? { ...p.eligibility }
        : { id: String(a.record_id), documentType: null, documentNumber: '', scanName: null, verified: false, version: 1 }
      if (typeof a.document_type === 'string') e.documentType = a.document_type as DocumentType
      if (typeof a.document_number === 'string') e.documentNumber = a.document_number
      if (typeof a.scan_name === 'string') e.scanName = a.scan_name
      p.eligibility = e
    } else if (name === 'verify_eligibility') {
      const p = players.find((x) => x.id === a.player_id)
      if (p?.eligibility) p.eligibility = { ...p.eligibility, verified: true }
    } else if (name === 'set_photo') {
      const x = players.find((y) => y.id === a.person_id) ?? staff.find((y) => y.id === a.person_id)
      if (x) x.photo = { path: String(a.photo_path), cutout: a.is_cutout === true, url: null }
    } else if (name === 'remove_player') players = players.filter((p) => p.id !== a.player_id)
    else if (name === 'add_staff' && !staff.some((x) => x.id === a.staff_id)) {
      staff.push({ id: String(a.staff_id), name: String(a.name), role: String(a.role), version: 1, photo: null })
    } else if (name === 'edit_staff') {
      const x = staff.find((y) => y.id === a.staff_id)
      if (x && typeof a.name === 'string') x.name = a.name
      if (x && typeof a.role === 'string') x.role = a.role
    } else if (name === 'remove_staff') staff = staff.filter((x) => x.id !== a.staff_id)
    else if (name === 'submit_team' && team.status !== 'approved') team = { ...team, status: 'submitted' }
  }
  return { ...form, team, players, staff }
}

/** The form with every pending change of this session laid over: Team details, then Squad and Staff. */
export const overlayForm = (form: RegistrationForm, queued: OutboxEntry[]): RegistrationForm =>
  overlaySquad({ ...form, team: overlayTeam(form.team, queued) }, queued)
