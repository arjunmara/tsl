// delete-scans (Story 2.7, AD-15): called hourly by pg_cron through pg_net (migration 0016). Deletes Eligibility scans
// through the Storage API, which removes the file and its storage.objects row: every scan of a verified record or a
// finished Season, and every file no record points to (after a day). Which files is decided in SQL by
// app.scans_to_delete(); app.scans_deleted() then clears the scan path on their records. A file that fails to delete
// stays selected, so the next run retries it; failures are logged (Supabase > Edge Functions > delete-scans > Logs).
// Deployed with --no-verify-jwt: the caller must send x-cleanup-secret equal to the SCAN_CLEANUP_SECRET secret.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const BUCKET = 'eligibility-scans'

/** Compares without stopping at the first different character. */
function same(a: string, b: string) {
  if (!a || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('SCAN_CLEANUP_SECRET') ?? ''
  if (!secret || !same(req.headers.get('x-cleanup-secret') ?? '', secret)) return new Response('Not allowed.', { status: 401 })

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const db = sb.schema('app')
  const { data: paths, error } = await db.rpc('scans_to_delete')
  if (error) {
    console.error('delete-scans: could not list scans', error.message)
    return Response.json({ ok: false, step: 'list' }, { status: 500 })
  }
  const list = (paths ?? []) as string[]
  let deleted: string[] = []
  if (list.length) {
    // One call per 100 files; the paths are never logged (they name a Player).
    for (let i = 0; i < list.length; i += 100) {
      const batch = list.slice(i, i + 100)
      const { data, error: e } = await sb.storage.from(BUCKET).remove(batch)
      if (e) console.error(`delete-scans: ${batch.length} scans not deleted, retried next run:`, e.message)
      deleted = deleted.concat((data ?? []).map((o) => o.name))
    }
    const missed = list.length - deleted.length
    if (missed > 0) console.error(`delete-scans: ${missed} of ${list.length} scans not deleted, retried next run`)
  }
  // Also clears records of verified or finished-Season scans whose file is already gone.
  const { data: cleared, error: e2 } = await db.rpc('scans_deleted', { p_paths: deleted })
  if (e2) console.error('delete-scans: scan paths not cleared, retried next run:', e2.message)
  console.log(`delete-scans: ${deleted.length} of ${list.length} scans deleted, ${cleared ?? 0} records cleared`)
  return Response.json({ ok: !e2 && deleted.length === list.length, selected: list.length, deleted: deleted.length, cleared })
})
