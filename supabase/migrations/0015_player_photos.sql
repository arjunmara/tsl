-- 0015_player_photos.sql: Player and Staff photos with in-browser background removal (Story 2.5). Each Player and Staff
-- member gets one photo: the object path in the private player-photos Storage bucket and whether it is a cut-out (false:
-- kept with its background). set_photo stores it after the phone uploads the file. Graphics, the Post-match pack and the
-- Overlay read a Player's photo only through app.player_photo_public, which gives it only with Photo consent and as a
-- cut-out (AD-23). The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- Columns ----------------------------------------------------------------------------------------

-- photo_path: <tournament_id>/<team_id>/<person_id>/<uuid>.webp in player-photos (personal, logged by field name only).
-- is_cutout: the background was removed; set with the path, both or neither.
alter table app.player add column if not exists photo_path text, add column if not exists is_cutout boolean;
alter table app.staff add column if not exists photo_path text, add column if not exists is_cutout boolean;
alter table app.player drop constraint if exists player_photo_check,
  add constraint player_photo_check check ((photo_path is null) = (is_cutout is null));
alter table app.staff drop constraint if exists staff_photo_check,
  add constraint staff_photo_check check ((photo_path is null) = (is_cutout is null));

create or replace trigger log_change after insert or update or delete on app.player
  for each row execute function app.log_change('tournament_id', '{date_of_birth,photo_path}');
create or replace trigger log_change after insert or update or delete on app.staff
  for each row execute function app.log_change('tournament_id', '{photo_path}');

-- Storage ----------------------------------------------------------------------------------------

-- Private, fenced by Tournament: no public URL works; readers sign a URL. WebP (PNG where the browser can't encode WebP).
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values ('player-photos', 'player-photos', false, '{image/webp,image/png}', 2097152)
on conflict (id) do update set public = false, allowed_mime_types = excluded.allowed_mime_types, file_size_limit = excluded.file_size_limit;

-- RLS helper: the path is <tournament_id>/<team_id>/<person_id>/<file>, and the caller organises that Tournament, or holds
-- a live grant for exactly that Team. To add (adding = true) the grant also needs the person in its Squad or Staff and the
-- Squad able to change. Write-free.
create or replace function app.can_use_photo(object_name text, adding boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when coalesce(array_length(f, 1), 0) <> 3 or exists (select 1 from unnest(f) p
        where p !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then false
      when app.is_member(f[1]::uuid) then true
      else exists (select 1 from app.registration_grant g
        join app.registration_link l on l.id = g.link_id and l.revoked_at is null
        where g.id = auth.uid() and g.tournament_id = f[1]::uuid and g.team_id = f[2]::uuid
          and (not adding or (app.season_allows(g.season_id, 'edit_squad') is null
            and (exists (select 1 from app.squad_entry e where e.team_id = g.team_id and e.player_id = f[3]::uuid)
              or exists (select 1 from app.staff s where s.team_id = g.team_id and s.id = f[3]::uuid)))))
    end
    from (select storage.foldername(object_name) f) x), false)
$$;

-- Organisers and the Team's own grant read (to show and download the photo); the same add. No update (uploads never
-- upsert: each photo has a fresh path) and no delete (Story 2.10 deletes through the Storage API).
drop policy if exists player_photos_select on storage.objects;
drop policy if exists player_photos_insert on storage.objects;
create policy player_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'player-photos' and app.can_use_photo(name, false));
create policy player_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'player-photos' and app.can_use_photo(name, true));

-- The consent gate (AD-23) -------------------------------------------------------------------------

-- One row per Player per Team they play for. photo_path (the object in player-photos; the caller signs a URL) is given
-- only when that Season's Photo consent is recorded with who gave it (a parent or guardian for a minor: the commands
-- refuse consent for a minor without one) and the photo is a cut-out; otherwise null. security_invoker: the caller's own
-- RLS applies, so Organisers see their Tournament and a grant its own Team; anon nothing.
create or replace view app.player_photo_public with (security_invoker = true) as
  select p.id as player_id, p.tournament_id, t.season_id, e.team_id,
    case when c.consent_given and c.given_by is not null and p.is_cutout then p.photo_path end as photo_path
  from app.player p
  join app.squad_entry e on e.player_id = p.id
  join app.team t on t.id = e.team_id
  left join app.photo_consent c on c.player_id = p.id and c.season_id = t.season_id;
revoke all on app.player_photo_public from public, anon, authenticated;
grant select on app.player_photo_public to authenticated;

-- Command ----------------------------------------------------------------------------------------

-- Sets the photo of a Player in the Team's Squad or of one of its Staff (person_id): the uploaded object's path and
-- whether it is a cut-out. Versioned on that Player's or Staff member's version, with the conflict envelope (its current
-- never carries the path). The replaced object is left for Story 2.10 to delete.
create or replace function app.set_photo(
  command_id uuid, team_id uuid, person_id uuid, expected_version int, photo_path text, is_cutout boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  kind text;
  v int;
  cut boolean;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id;
  if exists (select 1 from app.squad_entry s where s.team_id = team_id and s.player_id = person_id) then
    kind := 'player';
    select p.version, p.is_cutout into v, cut from app.player p where p.id = person_id for update;
  else
    select s.version, s.is_cutout into v, cut from app.staff s where s.id = person_id and s.team_id = team_id for update;
    if found then kind := 'staff'; end if;
  end if;
  if kind is null then
    r := jsonb_build_object('ok', false, 'code', 'person_missing', 'message', 'That person is not in this Team.');
  elsif v is distinct from expected_version then
    r := app.conflict(x.tournament_id, kind, person_id, v, jsonb_build_object('is_cutout', cut));
  elsif is_cutout is null or photo_path is null or photo_path !~ ('^' || x.tournament_id || '/' || x.id || '/' || person_id
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$') then
    r := jsonb_build_object('ok', false, 'code', 'photo_invalid', 'message', 'Photo didn''t upload. Try again.');
  else
    if kind = 'player' then
      update app.player p set photo_path = photo_path, is_cutout = is_cutout, version = p.version + 1 where p.id = person_id;
    else
      update app.staff s set photo_path = photo_path, is_cutout = is_cutout, version = s.version + 1 where s.id = person_id;
    end if;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Photo saved.', 'version', v + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.can_use_photo(text, boolean), app.set_photo(uuid, uuid, uuid, int, text, boolean)
  from public, anon, authenticated;
grant execute on function app.can_use_photo(text, boolean), app.set_photo(uuid, uuid, uuid, int, text, boolean) to authenticated;
