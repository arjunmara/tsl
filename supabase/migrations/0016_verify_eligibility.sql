-- 0016_verify_eligibility.sql: an Organiser views a scan and marks Eligibility verified (Story 2.7). Adds the command
-- verify_eligibility; narrows who reads a scan to Organisers of its Tournament while an unverified record of a Season that
-- has not finished points to it (so a verified, finished or orphan scan can't be opened even before the job deletes it);
-- and the scheduled deletion: pg_cron calls, through pg_net, the delete-scans Edge Function, which asks
-- app.scans_to_delete() for the files to remove, deletes them through the Storage API and reports them to
-- app.scans_deleted(), which clears the scan path. The founder enables pg_cron and pg_net first, then applies this in the
-- Supabase SQL Editor as `postgres` (test first, then live); see README.md. Safe to run twice.

do $$ begin
  if to_regnamespace('cron') is null or to_regnamespace('net') is null then
    raise exception 'Enable the pg_cron and pg_net extensions first (Database > Extensions), then run this again.';
  end if;
end $$;

-- Organisers mark a record verified while the Squad can still change.
insert into app.season_action values ('verify_eligibility', 'setup'), ('verify_eligibility', 'registration') on conflict do nothing;

-- Storage ----------------------------------------------------------------------------------------

-- RLS helper: the caller organises the folder's Tournament and an unverified record of a Season that has not finished
-- points to this scan. Write-free.
create or replace function app.can_read_scan(object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_asset_member(object_name) and exists (select 1 from app.eligibility_record r join app.season s on s.id = r.season_id
    where r.scan_path = object_name and r.verified_at is null and s.status <> 'finished')
$$;

drop policy if exists eligibility_scans_select on storage.objects;
create policy eligibility_scans_select on storage.objects for select to authenticated
  using (bucket_id = 'eligibility-scans' and app.can_read_scan(name));

-- The deletion job (service role only) --------------------------------------------------------------

-- Scans to delete, oldest first: every eligibility-scans object that no unverified record of an unfinished Season points
-- to. A file no record points to at all (a replaced scan, a removed Player's, an upload whose command was refused) waits
-- a day first, so an upload whose command is still on its way is not taken.
create or replace function app.scans_to_delete(p_limit int default 500) returns setof text
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'eligibility-scans'
    and not exists (select 1 from app.eligibility_record r join app.season s on s.id = r.season_id
                    where r.scan_path = o.name and r.verified_at is null and s.status <> 'finished')
    and (o.created_at < now() - interval '1 day' or exists (select 1 from app.eligibility_record r where r.scan_path = o.name))
  order by o.created_at, o.name
  limit p_limit
$$;

-- After the Storage API deleted these files: clears the scan path and file name of every record pointing to one, and of
-- every verified or finished-Season record whose file is already gone. Type, number, verifier and time stay. Returns the
-- number of records changed.
create or replace function app.scans_deleted(p_paths text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform set_config('app.reason', 'Scan deleted', true);
  update app.eligibility_record r set scan_path = null, scan_name = null, version = r.version + 1
  from app.season s
  where s.id = r.season_id and r.scan_path is not null
    and (r.scan_path = any (p_paths)
      or ((r.verified_at is not null or s.status = 'finished')
        and not exists (select 1 from storage.objects o where o.bucket_id = 'eligibility-scans' and o.name = r.scan_path)));
  get diagnostics n = row_count;
  return n;
end $$;

-- Commands ---------------------------------------------------------------------------------------

-- Marks the Player's Eligibility record for the Team's Season verified: keeps document type and number, sets verifier and
-- time. Organisers only (a Registration link grant is not_authorized). Needs a document type and number. Versioned with
-- the conflict envelope; verifying a verified record again is ok and changes nothing. The scan itself is deleted by the job.
create or replace function app.verify_eligibility(command_id uuid, team_id uuid, player_id uuid, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'verify_eligibility', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  cur app.eligibility_record;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id;
  if not exists (select 1 from app.squad_entry s where s.team_id = team_id and s.player_id = player_id) then
    r := jsonb_build_object('ok', false, 'code', 'player_missing', 'message', 'That Player is not in this Squad.');
  else
    select * into cur from app.eligibility_record e where e.player_id = player_id and e.season_id = x.season_id for update;
    if not found then
      r := jsonb_build_object('ok', false, 'code', 'eligibility_missing', 'message', 'That document was removed.');
    elsif cur.verified_at is not null then
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Already verified.', 'version', cur.version);
    elsif cur.version is distinct from expected_version then
      r := app.conflict(cur.tournament_id, 'eligibility_record', cur.id, cur.version, jsonb_build_object(
        'document_type', cur.document_type, 'document_number', cur.document_number, 'scan_name', cur.scan_name));
    elsif cur.document_type is null or cur.document_number is null then
      r := jsonb_build_object('ok', false, 'code', 'document_incomplete', 'message', 'Add the document type and number first.');
    else
      update app.eligibility_record e set verified_by = actor, verified_at = now(), version = e.version + 1 where e.id = cur.id;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Verified.', 'version', cur.version + 1);
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.can_read_scan(text), app.scans_to_delete(int), app.scans_deleted(text[]),
  app.verify_eligibility(uuid, uuid, uuid, int) from public, anon, authenticated, service_role;
grant execute on function app.can_read_scan(text), app.verify_eligibility(uuid, uuid, uuid, int) to authenticated;
grant execute on function app.scans_to_delete(int), app.scans_deleted(text[]) to service_role;

-- Schedule ---------------------------------------------------------------------------------------

-- Hourly at :17. The Edge Function's URL and the shared secret it checks come from Supabase Vault (names
-- scan_cleanup_url and scan_cleanup_secret, set by the founder), so no secret is in this file or in cron.job.
-- cron.schedule with the same name replaces the job.
do $do$ begin perform cron.schedule('delete-eligibility-scans', '17 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'scan_cleanup_url'),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cleanup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'scan_cleanup_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$job$); end $do$;
