-- 0019_erase_personal_data.sql: an Organiser deletes a Player's photo and personal details on request (Story 2.10, FR-P1).
-- The command erase_player_personal_data clears the Player's date of birth and photo, the guardian's name (and so the
-- Photo consent) and the Eligibility document number and scan in every Season, and keeps the name, Team, shirt number,
-- document type and match record. The files are queued in app.file_to_delete; the hourly delete-scans job (0016) deletes
-- them through the Storage API, together with Player and Staff photos nothing points to any more (replaced, removed).
-- Nightly backup copies expire after 30 days (the R2 lifecycle rule), so erased data leaves the backups within 30 days.
-- The founder applies this in the Supabase SQL Editor as `postgres` (test first, then live) and redeploys the delete-scans
-- Edge Function; see README.md. Safe to run twice.

-- Files to delete through the Storage API, queued by an erase. No tenant column and no client access: only the job reads
-- it (through the functions below). A queued file is deleted on the next run, without the day an orphan waits.
create table if not exists app.file_to_delete (
  bucket_id text not null check (bucket_id in ('player-photos', 'eligibility-scans')),
  name text not null,
  queued_at timestamptz not null default now(),
  primary key (bucket_id, name)
);
alter table app.file_to_delete enable row level security;
revoke all on app.file_to_delete from public, anon, authenticated;

-- RLS helper: the file is queued for deletion. Write-free.
create or replace function app.file_queued(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.file_to_delete q where q.bucket_id = p_bucket and q.name = p_name)
$$;

-- A queued photo can't be read (signed) by anyone, even before the job deletes it.
drop policy if exists player_photos_select on storage.objects;
create policy player_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'player-photos' and app.can_use_photo(name, false) and not app.file_queued(bucket_id, name));

-- The deletion job (service role only) --------------------------------------------------------------

-- scans_to_delete: as in 0016; a queued scan goes on the next run, not after a day.
create or replace function app.scans_to_delete(p_limit int default 500) returns setof text
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'eligibility-scans'
    and not exists (select 1 from app.eligibility_record r join app.season s on s.id = r.season_id
                    where r.scan_path = o.name and r.verified_at is null and s.status <> 'finished')
    and (o.created_at < now() - interval '1 day' or exists (select 1 from app.eligibility_record r where r.scan_path = o.name)
      or app.file_queued(o.bucket_id, o.name))
  order by o.created_at, o.name
  limit p_limit
$$;

-- Photos to delete, oldest first: every player-photos object no Player or Staff member points to, once it is a day old
-- (an upload whose set_photo is still on its way is not taken) or at once if queued by an erase.
create or replace function app.photos_to_delete(p_limit int default 500) returns setof text
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'player-photos'
    and not exists (select 1 from app.player p where p.photo_path = o.name)
    and not exists (select 1 from app.staff s where s.photo_path = o.name)
    and (o.created_at < now() - interval '1 day' or app.file_queued(o.bucket_id, o.name))
  order by o.created_at, o.name
  limit p_limit
$$;

-- After the Storage API deleted these files of one bucket: drops them, and any queued file already gone, from the queue.
-- Returns the number of queue rows dropped.
create or replace function app.files_deleted(p_bucket text, p_paths text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from app.file_to_delete q where q.bucket_id = p_bucket
    and (q.name = any (p_paths) or not exists (select 1 from storage.objects o where o.bucket_id = q.bucket_id and o.name = q.name));
  get diagnostics n = row_count;
  return n;
end $$;

-- Command ----------------------------------------------------------------------------------------

-- Deletes a Player's photo and personal details on request: date of birth and photo on the Player; in every Season the
-- guardian's (or giver's) name, so Photo consent becomes "not given"; the Eligibility document number and scan (type and
-- verification kept). Queues every file in either bucket under the Player's folder (current and replaced photos and
-- scans) for the job. Copies of the values in stored command answers (conflict envelopes) are dropped too. Name, Team,
-- shirt number and match record stay. The Activity log names the cleared fields only (log_change declarations).
-- Organisers only, in any Season status and for any Team status (a family's request can come at any time); a grant is
-- not_authorized. Versioned on the Player with the conflict envelope (its current has no personal value); nothing left
-- to delete is ok and changes nothing.
create or replace function app.erase_player_personal_data(command_id uuid, team_id uuid, player_id uuid, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  -- Authorised on the Tournament, not the Team: a withdrawn Team or a started Season doesn't stop an erase.
  denied text := app.authorize(actor, 'erase_personal_data',
    jsonb_build_object('tournament_id', (select t.tournament_id from app.team t where t.id = team_id)));
  r jsonb;
  e app.squad_entry;
  cur app.player;
  numbers text[];
  givers text[];
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true),
          set_config('app.reason', 'Personal details deleted on request', true);

  select * into e from app.squad_entry s where s.team_id = team_id and s.player_id = player_id;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'player_missing', 'message', 'That Player is not in this Squad.');
  else
    select * into cur from app.player p where p.id = player_id for update;
    select array_agg(er.document_number) filter (where er.document_number is not null) into numbers
      from app.eligibility_record er where er.player_id = cur.id;
    select array_agg(pc.given_by) filter (where pc.given_by is not null) into givers
      from app.photo_consent pc where pc.player_id = cur.id;
    if cur.date_of_birth is null and cur.photo_path is null and numbers is null and givers is null
        and not exists (select 1 from app.eligibility_record er where er.player_id = cur.id and er.scan_path is not null)
        and not exists (select 1 from storage.objects o where o.bucket_id in ('player-photos', 'eligibility-scans')
          and split_part(o.name, '/', 1) = cur.tournament_id::text and split_part(o.name, '/', 3) = cur.id::text
          and not app.file_queued(o.bucket_id, o.name)) then
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Nothing left to delete.', 'version', cur.version);
    elsif cur.version is distinct from expected_version then
      r := app.conflict(cur.tournament_id, 'player', cur.id, cur.version,
        jsonb_build_object('name', cur.name, 'shirt_number', e.shirt_number));
    else
      insert into app.file_to_delete (bucket_id, name)
        select o.bucket_id, o.name from storage.objects o
        where o.bucket_id in ('player-photos', 'eligibility-scans')
          and split_part(o.name, '/', 1) = cur.tournament_id::text and split_part(o.name, '/', 3) = cur.id::text
        on conflict do nothing;
      update app.eligibility_record er set document_number = null, scan_path = null, scan_name = null, scan_uploaded_at = null,
          version = er.version + 1
        where er.player_id = cur.id and (er.document_number is not null or er.scan_path is not null);
      update app.photo_consent pc set consent_given = false, given_by = null where pc.player_id = cur.id and pc.given_by is not null;
      update app.player p set date_of_birth = null, photo_path = null, is_cutout = null, version = p.version + 1 where p.id = cur.id;
      -- Stored answers whose conflict envelope carried one of the erased values (edit_player, remove_player,
      -- edit_eligibility, verify_eligibility) keep everything but that copy. The envelope names no row, so this matches
      -- by value: another Player's copy of the same value goes too, which only drops an old snapshot.
      update app.command_result c set result = c.result #- '{conflict,current}'
        where c.result -> 'conflict' -> 'current' is not null
          and (c.result -> 'conflict' -> 'current' ->> 'date_of_birth' = cur.date_of_birth::text
            or c.result -> 'conflict' -> 'current' ->> 'given_by' = any (coalesce(givers, '{}'))
            or c.result -> 'conflict' -> 'current' ->> 'document_number' = any (coalesce(numbers, '{}')));
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Personal details deleted.', 'version', cur.version + 1);
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.file_queued(text, text), app.photos_to_delete(int), app.files_deleted(text, text[]),
  app.erase_player_personal_data(uuid, uuid, uuid, int) from public, anon, authenticated, service_role;
grant execute on function app.file_queued(text, text), app.erase_player_personal_data(uuid, uuid, uuid, int) to authenticated;
grant execute on function app.photos_to_delete(int), app.files_deleted(text, text[]) to service_role;
