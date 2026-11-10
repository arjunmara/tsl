import { supabase } from './supabase'

export type SeasonStatus = 'setup' | 'registration' | 'started' | 'finished'
export type TournamentSummary = { id: string; name: string; season: { number: number; status: SeasonStatus } | null }

type Row = { id: string; name: string; season: { number: number; status: SeasonStatus }[] }

/** The caller's Tournaments (RLS returns only theirs), newest first, each with its latest Season. */
export async function myTournaments(): Promise<{ tournaments: TournamentSummary[] } | { code: 'offline' | 'unknown' }> {
  try {
    const { data, error, status } = await supabase.schema('app').from('tournament')
      .select('id, name, season(number, status)').order('created_at', { ascending: false })
    if (error) return { code: status === 0 || !navigator.onLine ? 'offline' : 'unknown' }
    return {
      tournaments: (data as Row[]).map((t) => ({
        id: t.id,
        name: t.name,
        season: t.season.reduce<TournamentSummary['season']>((a, s) => (!a || s.number > a.number ? s : a), null),
      })),
    }
  } catch {
    return { code: 'offline' }
  }
}
