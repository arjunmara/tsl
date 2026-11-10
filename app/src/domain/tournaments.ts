import { noteVersion } from '../outbox'
import { supabase } from './supabase'

export type SeasonStatus = 'setup' | 'registration' | 'started' | 'finished'
export type SeasonSummary = { id: string; number: number; status: SeasonStatus; setupStep: number }
export type TournamentSummary = { id: string; name: string; logoUrl: string | null; season: SeasonSummary | null }
/** The Season's answers to wizard steps 2 and 3, keyed as the commands name them; dates are YYYY-MM-DD or ''. */
export type SeasonAnswers = {
  description: string; rules: string; photo_consent: string; starts_on: string; ends_on: string; registration_deadline: string
}
/** A Season's Match settings, keyed as set_match_settings names them; every value is null until a preset is picked. */
export type MatchSettings = {
  format_preset: string | null; periods: number | null; period_minutes: number | null; clock: 'stopped' | 'running' | null
  half_time_minutes: number | null; extra_time: boolean | null; extra_time_periods: number | null; extra_time_minutes: number | null
  shootout: boolean | null; substitutions: 'rolling' | 'limited' | null; max_substitutions: number | null
  foul_warning: number | null; timeouts_per_period: number | null; power_play_minutes: number | null
}
export const SETTINGS = ['format_preset', 'periods', 'period_minutes', 'clock', 'half_time_minutes', 'extra_time', 'extra_time_periods',
  'extra_time_minutes', 'shootout', 'substitutions', 'max_substitutions', 'foul_warning', 'timeouts_per_period', 'power_play_minutes'] as const
/** One row of app.format_preset: its defaults as Match settings (format_preset = its key) and its line-up defaults. */
export type FormatPreset = {
  key: string; label: string; futsalRules: boolean; settings: MatchSettings; lineup?: { starters: number | null; max_bench: number | null }
}

/** A Season's Line-up rules, keyed as set_lineup_rules names them; starters and max_bench are null until set. */
export type LineupRules = { starters: number | null; max_bench: number | null; staff_roles: string[] }
/** A Season's Structure, points and tie-break order, keyed as set_structure names them. */
export type Structure = {
  structure: 'groups_knockout' | 'knockout' | 'league' | null; group_count: number | null; teams_per_group: number | null
  qualifiers_per_group: number | null; points_win: number; points_draw: number; points_loss: number; tiebreaks: string[]
}
// The words for the keys app.season's checks allow, in the order the wizard lists them.
export const STAFF_ROLES: [string, string][] = [['manager', 'Manager'], ['coach', 'Coach'], ['assistant_coach', 'Assistant coach'],
  ['physio', 'Physio'], ['doctor', 'Doctor'], ['kit_manager', 'Kit manager']]
export const STRUCTURES: [string, string][] = [['groups_knockout', 'Groups then knockout'], ['knockout', 'Knockout only'], ['league', 'League']]
export const TIEBREAKS: [string, string][] = [['h2h_points', 'Head-to-head points'], ['h2h_goal_difference', 'Head-to-head goal difference'],
  ['h2h_shootout', 'Shootout between the tied Teams'], ['goal_difference', 'Overall goal difference'], ['goals_scored', 'Goals scored']]
/** A new Season's values, as 0007's column defaults (for a Season not on the server yet). */
export const NEW_LINEUP: LineupRules = { starters: null, max_bench: null, staff_roles: ['manager', 'coach'] }
export const NEW_STRUCTURE: Structure = {
  structure: null, group_count: null, teams_per_group: null, qualifiers_per_group: null, points_win: 3, points_draw: 1, points_loss: 0,
  tiebreaks: TIEBREAKS.map(([k]) => k),
}

/** One Tournament as the setup wizard needs it; brand colours are null when the server sent none. */
export type TournamentSetup = {
  id: string; name: string; brandPrimary: string | null; brandSecondary: string | null; logoPath: string | null; version: number
  season: (SeasonSummary & { answers: SeasonAnswers; settings: MatchSettings; lineup: LineupRules; structure: Structure }) | null
}

type SeasonRow = { id: string; number: number; status: SeasonStatus; setup_step?: number; version?: number }
  & Partial<Record<keyof SeasonAnswers, string | null>> & Partial<MatchSettings> & Partial<LineupRules> & Partial<Structure>
const ANSWERS = ['description', 'rules', 'photo_consent', 'starts_on', 'ends_on', 'registration_deadline'] as const
type Row = {
  id: string; name: string; brand_primary?: string; brand_secondary?: string; logo_path?: string | null; version?: number
  season: SeasonRow[]
}

const BUCKET = 'tournament-assets'
/** The public URL of a file in the tournament-assets bucket. */
export const logoUrl = (path: string) => supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
export const assetBucket = BUCKET

const latest = (seasons: SeasonRow[]): SeasonSummary | null =>
  seasons.reduce<SeasonSummary | null>((a, s) => (!a || s.number > a.number
    ? { id: s.id, number: s.number, status: s.status, setupStep: s.setup_step ?? 0 } : a), null)

/** A Season created with its Tournament starts at version 1: the base for edits queued before the create is answered. */
export const noteNewSeason = (seasonId: string) => noteVersion(seasonId, 1)

const failed = (status: number) => ({ code: status === 0 || !navigator.onLine ? 'offline' as const : 'unknown' as const })

/** The caller's Tournaments (RLS returns only theirs), newest first, each with its latest Season. */
export async function myTournaments(): Promise<{ tournaments: TournamentSummary[] } | { code: 'offline' | 'unknown' }> {
  try {
    const { data, error, status } = await supabase.schema('app').from('tournament')
      .select('id, name, logo_path, season(id, number, status, setup_step)').order('created_at', { ascending: false })
    if (error) return failed(status)
    return {
      tournaments: (data as Row[]).map((t) => ({
        id: t.id, name: t.name, logoUrl: t.logo_path ? logoUrl(t.logo_path) : null, season: latest(t.season),
      })),
    }
  } catch {
    return { code: 'offline' }
  }
}

/** One of the caller's Tournaments for the setup wizard; tournament null when it isn't on the server (yet). */
export async function tournamentSetup(id: string): Promise<{ tournament: TournamentSetup | null } | { code: 'offline' | 'unknown' }> {
  try {
    const { data, error, status } = await supabase.schema('app').from('tournament')
      .select('id, name, brand_primary, brand_secondary, logo_path, version, season(id, number, status, setup_step, version, description, rules, photo_consent, starts_on, ends_on, registration_deadline, ' +
        `${SETTINGS.join(', ')}, ${Object.keys(NEW_LINEUP).join(', ')}, ${Object.keys(NEW_STRUCTURE).join(', ')})`)
      .eq('id', id)
    if (error) return failed(status)
    const t = (data as unknown as Row[]).find((r) => r.id === id)
    if (t && Number.isInteger(t.version)) await noteVersion(t.id, t.version!)
    const s = t && latest(t.season)
    const row = s && t.season.find((x) => x.id === s.id)
    if (row && Number.isInteger(row.version)) await noteVersion(row.id, row.version!)
    return {
      tournament: t ? {
        id: t.id, name: t.name, brandPrimary: t.brand_primary ?? null, brandSecondary: t.brand_secondary ?? null,
        logoPath: t.logo_path ?? null, version: t.version ?? 1,
        season: s && row ? {
          ...s, answers: Object.fromEntries(ANSWERS.map((k) => [k, row[k] ?? ''])) as SeasonAnswers,
          settings: Object.fromEntries(SETTINGS.map((k) => [k, row[k] ?? null])) as MatchSettings,
          lineup: Object.fromEntries(Object.entries(NEW_LINEUP).map(([k, d]) => [k, row[k as keyof LineupRules] ?? d])) as LineupRules,
          structure: Object.fromEntries(Object.entries(NEW_STRUCTURE).map(([k, d]) => [k, row[k as keyof Structure] ?? d])) as Structure,
        } : null,
      } : null,
    }
  } catch {
    return { code: 'offline' }
  }
}

type PresetRow = Omit<MatchSettings, 'format_preset'> & { key: string; label: string; futsal_rules: boolean; starters?: number; max_bench?: number }
const PRESETS_KEY = 'tsl-format-presets'

/**
 * The Format presets from app.format_preset, in order. The last answer is kept on the device, so the wizard's Format
 * step opens offline after one online read; null when neither the server nor the device has them.
 */
export async function formatPresets(): Promise<FormatPreset[] | null> {
  try {
    const { data, error } = await supabase.schema('app').from('format_preset').select('*').order('sort')
    if (!error && data?.length) {
      const presets = (data as PresetRow[]).map((p) => ({
        key: p.key, label: p.label, futsalRules: p.futsal_rules, lineup: { starters: p.starters ?? null, max_bench: p.max_bench ?? null },
        settings: Object.fromEntries(SETTINGS.map((k) => [k, k === 'format_preset' ? p.key : p[k] ?? null])) as MatchSettings,
      }))
      try {
        localStorage.setItem(PRESETS_KEY, JSON.stringify(presets))
      } catch {
        // Storage full or blocked: only the offline fallback is lost.
      }
      return presets
    }
  } catch {
    // Offline: fall back to the device's copy.
  }
  try {
    const kept = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? 'null') as FormatPreset[] | null
    return Array.isArray(kept) && kept.length ? kept : null
  } catch {
    return null
  }
}
