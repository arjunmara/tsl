-- 0014_eligibility.sql: a Team manager adds Eligibility proof with a document scan (Story 2.4). Adds the Eligibility record
-- (one per Player per Season: document type and number, the scan's path and file name, verified by and at), readable only
-- by that Tournament's Organisers, and the private eligibility-scans Storage bucket: Organisers read its objects; a
-- Registration link grant may only add a scan under its own Team's folder and never read one back. Scans are deleted
-- through the Storage API by Story 2.7's scheduled job, never by deleting the storage.objects row. The founder applies this
-- in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- Tables -----------------------------------------------------------------------------------------

-- document_number, scan_path and scan_name are personal (logged by field name only). scan_path: the object in
-- eligibility-scans, <tournament_id>/<team_id>/<player_id>/<uuid>.webp; scan_name: the file name the Team manager picked.
-- verified_by / verified_at are set by Story 2.7.
create table if not exists app.eligibility_record (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  player_id uuid not null references app.player (id),
  season_id uuid not null references app.season (id),
  document_type text check (document_type in ('emis', 'birth_certificate', 'citizenship', 'passport')),
  document_number text check (char_length(document_number) between 1 and 40 and document_number !~ '[\u0001-\u001f\u007f-\u009f  ]'),
  scan_path text,
  scan_name text check (char_length(scan_name) between 1 and 120 and scan_name !~ '[\u0001-\u001f\u007f-\u009f  ]'),
  scan_uploaded_at timestamptz,
  verified_by uuid references auth.users (id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  version int not null default 1,
  constraint eligibility_record_player_season_key unique (player_id, season_id),
  check ((scan_path is null) = (scan_name is null))
);
create index if not exists eligibility_record_season_idx on app.eligibility_record (season_id);

create or replace trigger log_change after insert or update or delete on app.eligibility_record
  for each row execute function app.log_change('tournament_id', '{document_number,scan_path,scan_name}');

-- Stricter than the default membership check: only the Tournament's Organisers read the table (no Scorer device, no
-- Registration link grant). A grant reads its own Team's records through app.registration_eligibility(), without the scan
-- path. No client writes.
alter table app.eligibility_record enable row level security;
drop policy if exists organiser_read on app.eligibility_record;
create policy organiser_read on app.eligibility_record for select to authenticated using (app.is_member(tournament_id));
revoke all on app.eligibility_record from public, anon, authenticated;
grant select on app.eligibility_record to authenticated;

-- Storage ----------------------------------------------------------------------------------------

-- Private: no public URL ever works. Only resized images (WebP; PNG where the browser can't encode WebP), at most 1 MiB.
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values ('eligibility-scans', 'eligibility-scans', false, '{image/webp,image/png}', 1048576)
on conflict (id) do update set public = false, allowed_mime_types = excluded.allowed_mime_types, file_size_limit = excluded.file_size_limit;

-- RLS helper for adding a scan: the path is <tournament_id>/<team_id>/<player_id>/<file>, and the caller organises that
-- Tournament, or holds a live grant for exactly that Team, the Player is in its Squad, and the Squad can change. Write-free.
create or replace function app.can_upload_scan(object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when coalesce(array_length(f, 1), 0) <> 3 or exists (select 1 from unnest(f) p
        where p !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then false
      when app.is_member(f[1]::uuid) then true
      else exists (select 1 from app.registration_grant g
        join app.registration_link l on l.id = g.link_id and l.revoked_at is null
        join app.squad_entry e on e.team_id = g.team_id and e.player_id = f[3]::uuid
        where g.id = auth.uid() and g.tournament_id = f[1]::uuid and g.team_id = f[2]::uuid
          and app.season_allows(g.season_id, 'edit_squad') is null)
    end
    from (select storage.foldername(object_name) f) x), false)
$$;

-- Organisers read (2.7's viewer); anyone allowed above adds. No select for a grant, so a Team manager can't open a scan,
-- even their own; no update (uploads never upsert) and no delete (the 2.7 job deletes through the Storage API).
drop policy if exists eligibility_scans_select on storage.objects;
drop policy if exists eligibility_scans_insert on storage.objects;
create policy eligibility_scans_select on storage.objects for select to authenticated
  using (bucket_id = 'eligibility-scans' and app.is_asset_member(name));
create policy eligibility_scans_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'eligibility-scans' and app.can_upload_scan(name));

-- Helpers ----------------------------------------------------------------------------------------

-- The grant's own Team's Eligibility records for its Season: no scan path. None for anyone else.
create or replace function app.registration_eligibility()
returns table (id uuid, player_id uuid, document_type text, document_number text, scan_name text, verified boolean, version int)
language sql stable security definer set search_path = '' as $$
  select r.id, r.player_id, r.document_type, r.document_number, r.scan_name, r.verified_at is not null, r.version
  from app.team x
  join app.squad_entry e on e.team_id = x.id
  join app.eligibility_record r on r.player_id = e.player_id and r.season_id = x.season_id
  where x.id = app.granted_team()
$$;

-- The refusal for bad Eligibility fields (already trimmed; null = not given), else null. Commands only; no client grant.
create or replace function app.eligibility_invalid(
  p_team app.team, p_player_id uuid, p_type text, p_number text, p_path text, p_name text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if p_type is not null and p_type <> all (array['emis', 'birth_certificate', 'citizenship', 'passport']) then
    return jsonb_build_object('ok', false, 'code', 'type_invalid', 'message', 'Choose a document type.');
  elsif p_number is not null and (char_length(p_number) not between 1 and 40 or p_number ~ '[\u0001-\u001f\u007f-\u009f  ]') then
    return jsonb_build_object('ok', false, 'code', 'number_invalid', 'message', 'A document number is 1 to 40 characters.');
  elsif (p_path is null) <> (p_name is null)
      or p_path !~ ('^' || p_team.tournament_id || '/' || p_team.id || '/' || p_player_id
                    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$')
      or char_length(p_name) not between 1 and 120 or p_name ~ '[\u0001-\u001f\u007f-\u009f  ]' then
    return jsonb_build_object('ok', false, 'code', 'scan_invalid', 'message', 'Document didn''t upload. Try again.');
  end if;
  return null;
end $$;

-- Commands ---------------------------------------------------------------------------------------
-- Both take the Team (authorize fences it; a grant holder only its own, while the Squad can change) and check the Player
-- is in that Team's Squad. The record is for the Team's Season.

-- Adds a Player's Eligibility record with any of its fields (the rest later through edit_eligibility). Insert-only (a
-- reused record_id is already_exists; a second record for the same Player and Season is eligibility_exists). The scan
-- (uploaded first) is given as its path and file name together. The answer carries no version (a new record is version 1).
create or replace function app.add_eligibility(
  command_id uuid, team_id uuid, player_id uuid, record_id uuid, document_type text default null,
  document_number text default null, scan_path text default null, scan_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  num text := regexp_replace(document_number, '^\s+|\s+$', '', 'g');
  nm text := regexp_replace(scan_name, '^\s+|\s+$', '', 'g');
  k text;
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
    r := app.eligibility_invalid(x, player_id, document_type, num, scan_path, nm);
    if r is null then
      begin
        insert into app.eligibility_record (id, tournament_id, player_id, season_id, document_type, document_number, scan_path,
          scan_name, scan_uploaded_at)
        values (record_id, x.tournament_id, player_id, x.season_id, document_type, num, scan_path, nm,
          case when scan_path is not null then now() end);
        r := jsonb_build_object('ok', true, 'code', null, 'message', 'Document added.');
      exception when unique_violation then
        get stacked diagnostics k = constraint_name;
        r := case when k = 'eligibility_record_player_season_key'
          then jsonb_build_object('ok', false, 'code', 'eligibility_exists', 'message', 'This Player already has a document.')
          else jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.') end;
      end;
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Changes the document type, number or scan (path and file name together) of the Player's record for the Team's Season.
-- null = unchanged. Versioned with the conflict envelope (its current never carries the scan path). A verified record
-- can't change (eligibility_verified).
create or replace function app.edit_eligibility(
  command_id uuid, team_id uuid, player_id uuid, expected_version int, document_type text default null,
  document_number text default null, scan_path text default null, scan_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  cur app.eligibility_record;
  num text := regexp_replace(document_number, '^\s+|\s+$', '', 'g');
  nm text := regexp_replace(scan_name, '^\s+|\s+$', '', 'g');
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
    elsif cur.version is distinct from expected_version then
      r := app.conflict(cur.tournament_id, 'eligibility_record', cur.id, cur.version, jsonb_build_object(
        'document_type', cur.document_type, 'document_number', cur.document_number, 'scan_name', cur.scan_name));
    elsif document_type is null and num is null and scan_path is null and nm is null then
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Nothing to change.', 'version', cur.version);
    elsif cur.verified_at is not null then
      r := jsonb_build_object('ok', false, 'code', 'eligibility_verified', 'message', 'This document is already verified.');
    else
      r := app.eligibility_invalid(x, player_id, document_type, num, scan_path, nm);
      if r is null then
        update app.eligibility_record e set document_type = coalesce(document_type, e.document_type),
          document_number = coalesce(num, e.document_number), scan_path = coalesce(scan_path, e.scan_path),
          scan_name = coalesce(nm, e.scan_name),
          scan_uploaded_at = case when scan_path is not null then now() else e.scan_uploaded_at end, version = e.version + 1
        where e.id = cur.id;
        r := jsonb_build_object('ok', true, 'code', null, 'message', 'Document updated.', 'version', cur.version + 1);
      end if;
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- remove_player: as in 0013, and the Player's Eligibility record for that Season goes with their Squad entry (all their
-- records when the Player is deleted). The scan object itself is left for Story 2.7's job to delete.
create or replace function app.remove_player(command_id uuid, team_id uuid, player_id uuid, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  e app.squad_entry;
  cur app.player;
  c app.photo_consent;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id;
  select * into e from app.squad_entry s where s.team_id = team_id and s.player_id = player_id;
  if not found then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Player already removed.');
  else
    select * into cur from app.player p where p.id = player_id for update;
    if cur.version is distinct from expected_version then
      select * into c from app.photo_consent pc where pc.player_id = player_id and pc.season_id = x.season_id;
      r := app.conflict(cur.tournament_id, 'player', cur.id, cur.version, jsonb_build_object('name', cur.name,
        'shirt_number', e.shirt_number, 'date_of_birth', cur.date_of_birth, 'consent', coalesce(c.consent_given, false),
        'given_by', c.given_by));
    else
      delete from app.squad_entry s where s.id = e.id;
      if not exists (select 1 from app.squad_entry s join app.team t on t.id = s.team_id
                     where s.player_id = cur.id and t.season_id = x.season_id) then
        delete from app.photo_consent pc where pc.player_id = cur.id and pc.season_id = x.season_id;
        delete from app.eligibility_record er where er.player_id = cur.id and er.season_id = x.season_id;
      end if;
      if not exists (select 1 from app.squad_entry s where s.player_id = cur.id) then
        delete from app.photo_consent pc where pc.player_id = cur.id;
        delete from app.eligibility_record er where er.player_id = cur.id;
        delete from app.player p where p.id = cur.id;
      end if;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Player removed.');
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.can_upload_scan(text), app.registration_eligibility(),
  app.eligibility_invalid(app.team, uuid, text, text, text, text),
  app.add_eligibility(uuid, uuid, uuid, uuid, text, text, text, text),
  app.edit_eligibility(uuid, uuid, uuid, int, text, text, text, text) from public, anon, authenticated;
grant execute on function app.can_upload_scan(text), app.registration_eligibility(),
  app.add_eligibility(uuid, uuid, uuid, uuid, text, text, text, text),
  app.edit_eligibility(uuid, uuid, uuid, int, text, text, text, text) to authenticated;
