-- 0004_wizard_step1.sql: setup wizard step 1 (Story 1.8). Brand colours and logo on the Tournament, the
-- furthest finished setup step on the Season, two commands and the tournament-assets Storage bucket.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- Columns ----------------------------------------------------------------------------------------

alter table app.tournament
  add column if not exists brand_primary text not null default '#0a1a3f' check (brand_primary ~ '^#[0-9a-f]{6}$'),
  add column if not exists brand_secondary text not null default '#f58220' check (brand_secondary ~ '^#[0-9a-f]{6}$'),
  -- Path inside the tournament-assets bucket: <tournament_id>/logo-<uuid>.webp.
  add column if not exists logo_path text null;

-- 0 = no step finished yet; 7 = the wizard is done.
alter table app.season add column if not exists setup_step int not null default 0 check (setup_step between 0 and 7);

-- Commands ---------------------------------------------------------------------------------------

-- create_tournament as in 0002 (same signature and meaning), now also reporting the new row's version (1), so
-- the outbox can base later edits on it.
create or replace function app.create_tournament(command_id uuid, tournament_id uuid, season_id uuid, name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'create_tournament',
                               jsonb_build_object('tournament_id', tournament_id, 'season_id', season_id));
  r jsonb;
  n text := regexp_replace(name, '^\s+|\s+$', '', 'g');
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  if n is null or char_length(n) not between 1 and 80 then
    r := jsonb_build_object('ok', false, 'code', 'name_invalid', 'message', 'Name must be 1 to 80 characters.');
  else
    begin
      insert into app.tournament (id, name) values (tournament_id, n);
      insert into app.organiser_membership (tournament_id, user_id) values (tournament_id, actor);
      insert into app.season (id, tournament_id, number) values (season_id, tournament_id, 1);
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Tournament created.', 'version', 1);
    exception when unique_violation then
      r := jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Changes the Tournament's name, brand colours or logo. null = unchanged; logo_path '' removes the logo.
-- A stale expected_version writes nothing and returns the conflict envelope (app/README.md).
create or replace function app.set_tournament_branding(
  command_id uuid, tournament_id uuid, expected_version int, name text default null,
  brand_primary text default null, brand_secondary text default null, logo_path text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'set_tournament_branding', jsonb_build_object('tournament_id', tournament_id));
  r jsonb;
  cur app.tournament;
  n text := regexp_replace(name, '^\s+|\s+$', '', 'g');
  p text := lower(brand_primary);
  s text := lower(brand_secondary);
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.tournament x where x.id = tournament_id for update;
  if name is not null and char_length(n) not between 1 and 80 then
    r := jsonb_build_object('ok', false, 'code', 'name_invalid', 'message', 'Name must be 1 to 80 characters.');
  elsif (p is not null and p !~ '^#[0-9a-f]{6}$') or (s is not null and s !~ '^#[0-9a-f]{6}$') then
    r := jsonb_build_object('ok', false, 'code', 'colour_invalid', 'message', 'Colours must be #rrggbb.');
  elsif logo_path <> '' and logo_path !~ ('^' || tournament_id::text || '/[A-Za-z0-9_-][A-Za-z0-9._-]{0,120}$') then
    r := jsonb_build_object('ok', false, 'code', 'logo_invalid', 'message', 'Logo path must be in this tournament''s folder.');
  elsif cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version,
        'current', jsonb_build_object('name', cur.name, 'brand_primary', cur.brand_primary,
                                      'brand_secondary', cur.brand_secondary, 'logo_path', cur.logo_path),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  else
    update app.tournament x set
      name = coalesce(n, x.name),
      brand_primary = coalesce(p, x.brand_primary),
      brand_secondary = coalesce(s, x.brand_secondary),
      logo_path = case when logo_path is null then x.logo_path else nullif(logo_path, '') end,
      version = x.version + 1
    where x.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Tournament updated.', 'version', cur.version + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Records the furthest finished wizard step; it never goes back. Only while setup can be edited.
-- Branding has no Season check: name, colours and logo stay editable after the Season starts.
create or replace function app.set_setup_step(command_id uuid, season_id uuid, step int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_setup', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  if step is null or step not between 0 and 7 then
    r := jsonb_build_object('ok', false, 'code', 'step_invalid', 'message', 'Step must be 0 to 7.');
  else
    -- Progress, not an answer: it leaves the Season's version alone, so it never conflicts with an edit.
    update app.season x set setup_step = step where x.id = season_id and x.setup_step < step;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Setup step saved.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.set_tournament_branding(uuid, uuid, int, text, text, text, text),
  app.set_setup_step(uuid, uuid, int) from public, anon, authenticated;
grant execute on function app.set_tournament_branding(uuid, uuid, int, text, text, text, text),
  app.set_setup_step(uuid, uuid, int) to authenticated;

-- Storage ----------------------------------------------------------------------------------------

-- Tournament and Sponsor logos and ads. Public read; never personal data (no player photos or documents).
-- Only resized images (the app uploads WebP; PNG and JPEG for later uploads), at most 1 MiB each.
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values ('tournament-assets', 'tournament-assets', true, '{image/webp,image/png,image/jpeg}', 1048576)
on conflict (id) do update set public = true, allowed_mime_types = excluded.allowed_mime_types, file_size_limit = excluded.file_size_limit;

-- RLS helper for storage.objects: is the first folder of this object path a Tournament the caller organises?
create or replace function app.is_asset_member(object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select app.is_member(f::uuid) from (select (storage.foldername(object_name))[1] f) x
                   where f ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), false)
$$;
revoke all on function app.is_asset_member(text) from public, anon, authenticated;
grant execute on function app.is_asset_member(text) to authenticated;

-- Writes only into a folder named after a Tournament the caller organises: <tournament_id>/<file>.
-- Select is needed for upsert; it is limited the same way so nobody can list other Tournaments' files.
drop policy if exists tournament_assets_select on storage.objects;
drop policy if exists tournament_assets_insert on storage.objects;
drop policy if exists tournament_assets_update on storage.objects;
drop policy if exists tournament_assets_delete on storage.objects;
create policy tournament_assets_select on storage.objects for select to authenticated
  using (bucket_id = 'tournament-assets' and app.is_asset_member(name));
create policy tournament_assets_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'tournament-assets' and app.is_asset_member(name));
create policy tournament_assets_update on storage.objects for update to authenticated
  using (bucket_id = 'tournament-assets' and app.is_asset_member(name))
  with check (bucket_id = 'tournament-assets' and app.is_asset_member(name));
create policy tournament_assets_delete on storage.objects for delete to authenticated
  using (bucket_id = 'tournament-assets' and app.is_asset_member(name));
