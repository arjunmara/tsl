// delete-scans (Stories 2.7 and 2.10, AD-15): called hourly by pg_cron through pg_net (migration 0016). Deletes files
// through the Storage API, which removes the file and its storage.objects row:
// - eligibility-scans: every scan of a verified record or a finished Season, every file no record points to (after a
//   day), and every scan queued by an erase (0019);
// - player-photos (0019): every photo no Player or Staff member points to (after a day), and every photo queued by an
//   erase.
// Which files is decided in SQL (app.scans_to_delete(), app.photos_to_delete()); app.scans_deleted() then clears the scan
// path on their records and app.files_deleted() drops them from the erase queue. A file that fails to delete stays
// selected, so the next run retries it; failures are logged (Supabase > Edge Functions > delete-scans > Logs).
// Deployed with --no-verify-jwt: the caller must send x-cleanup-secret equal to the SCAN_CLEANUP_SECRET secret.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const JOBS = [
  { bucket: 'eligibility-scans', list: 'scans_to_delete', done: 'scans_deleted' },
  { bucket: 'player-photos', list: 'photos_to_delete', done: null },
] as const

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
  const report: Record<string, unknown> = {}
  let ok = true
  for (const { bucket, list: listFn, done } of JOBS) {
    const { data: paths, error } = await db.rpc(listFn)
    if (error) {
      console.error(`delete-scans: could not list ${bucket}`, error.message)
      ok = false
      continue
    }
    const list = (paths ?? []) as string[]
    let deleted: string[] = []
    // One call per 100 files; the paths are never logged (they name a Player).
    for (let i = 0; i < list.length; i += 100) {
      const batch = list.slice(i, i + 100)
      const { data, error: e } = await sb.storage.from(bucket).remove(batch)
      if (e) console.error(`delete-scans: ${batch.length} files in ${bucket} not deleted, retried next run:`, e.message)
      deleted = deleted.concat((data ?? []).map((o) => o.name))
    }
    const missed = list.length - deleted.length
    if (missed > 0) console.error(`delete-scans: ${missed} of ${list.length} files in ${bucket} not deleted, retried next run`)
    // scans_deleted also clears records of verified or finished-Season scans whose file is already gone.
    const { data: cleared, error: e2 } = done ? await db.rpc(done, { p_paths: deleted }) : { data: null, error: null }
    if (e2) console.error(`delete-scans: ${bucket} paths not cleared, retried next run:`, e2.message)
    const { error: e3 } = await db.rpc('files_deleted', { p_bucket: bucket, p_paths: deleted })
    if (e3) console.error(`delete-scans: ${bucket} erase queue not updated, retried next run:`, e3.message)
    console.log(`delete-scans: ${bucket}: ${deleted.length} of ${list.length} files deleted, ${cleared ?? 0} records cleared`)
    report[bucket] = { selected: list.length, deleted: deleted.length, cleared }
    ok &&= !e2 && !e3 && missed === 0
  }
  return Response.json({ ok, ...report })
})
