import { noteVersion } from '../outbox'
import { supabase } from './supabase'

export type SeasonStatus = 'setup' | 'registration' | 'started' | 'finished'
export type SeasonSummary = { id: string; number: number; status: SeasonStatus; setupStep: number }
export type TournamentSummary = { id: string; name: string; logoUrl: string | null; season: SeasonSummary | null }
/** One Tournament as the setup wizard needs it; brand colours are null when the server sent none. */
export type TournamentSetup = {
  id: string; name: string; brandPrimary: string | null; brandSecondary: string | null; logoPath: string | null; version: number
  season: SeasonSummary | null
}

type SeasonRow = { id: string; number: number; status: SeasonStatus; setup_step?: number }
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
      .select('id, name, brand_primary, brand_secondary, logo_path, version, season(id, number, status, setup_step)').eq('id', id)
    if (error) return failed(status)
    const t = (data as Row[]).find((r) => r.id === id)
    if (t && Number.isInteger(t.version)) await noteVersion(t.id, t.version!)
    return {
      tournament: t ? {
        id: t.id, name: t.name, brandPrimary: t.brand_primary ?? null, brandSecondary: t.brand_secondary ?? null,
        logoPath: t.logo_path ?? null, version: t.version ?? 1, season: latest(t.season),
      } : null,
    }
  } catch {
    return { code: 'offline' }
  }
}
