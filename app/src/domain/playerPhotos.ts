import { photoBucket } from './registration'
import { supabase } from './supabase'

/**
 * The one gate for Player photos on Graphics (Story 5.3): the signed cut-out URL of each Player whose Photo consent is recorded with a giver and whose
 * photo is a cut-out. The database view decides (it gives a path only then); nothing else on a Graphic may read a photo. A Player left out of the
 * map, or an unreachable server, means a Graphic without a cut-out.
 */
export async function cutOutUrls(seasonId: string, playerIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (playerIds.length === 0) return out
  try {
    const { data, error } = await supabase.schema('app').from('player_photo_public').select('player_id, photo_path').eq('season_id', seasonId).in('player_id', playerIds)
    const rows = ((error ? [] : data) as { player_id: string; photo_path: string | null }[]).filter((r) => r.photo_path)
    if (rows.length === 0) return out
    // Short-lived: the PNG is made as soon as the Graphic is on screen.
    const signed = await supabase.storage.from(photoBucket).createSignedUrls(rows.map((r) => r.photo_path!), 600)
    for (const r of rows) {
      const url = signed.data?.find((d) => d.path === r.photo_path)?.signedUrl
      if (url) out.set(r.player_id, url)
    }
  } catch {
    // Unreachable: no cut-outs this time.
  }
  return out
}
