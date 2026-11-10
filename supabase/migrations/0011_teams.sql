-- 0011_teams.sql: add Teams and share each one's Registration link (Story 2.1). The Teams of a Season and one private
-- Registration link per Team. The link's token is made on the Organiser's device; only its SHA-256 reaches the server.
-- Redeeming a link (anonymous session, grant-aware RLS) is Story 2.2. The founder applies this in the Supabase SQL Editor
-- as `postgres`: test first, then live. Safe to run twice.

-- Tables -----------------------------------------------------------------------------------------

-- code: 2–5 upper-case letters or digits, unique within the Season. kit_colour: set by the Team manager later (2.2).
-- status: invited until the Team submits (2.2) and the Organiser reviews it (2.8).
create table if not exists app.team (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  season_id uuid not null references app.season (id),
  name text not null check (char_length(name) between 1 and 80 and name !~ '[\u0001-\u001f\u007f-\u009f  ]'),
  code text not null check (code ~ '^[A-Z0-9]{2,5}$'),
  kit_colour text check (kit_colour ~ '^#[0-9a-f]{6}$'),
  status text not null default 'invited' check (status in ('invited', 'submitted', 'approved', 'returned')),
  created_at timestamptz not null default now(),
  version int not null default 1
);
create unique index if not exists team_season_code_idx on app.team (season_id, code);

-- token_hash: SHA-256 of the link's token, 64 lower-case hex; the token itself is never stored. Active = not revoked;
-- at most one active link per Team. Revoking sets revoked_at; a revoked link never comes back.
create table if not exists app.registration_link (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  team_id uuid not null references app.team (id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  version int not null default 1
);
create unique index if not exists registration_link_active_idx on app.registration_link (team_id) where revoked_at is null;

create or replace trigger log_change after insert or update or delete on app.team
  for each row execute function app.log_change();
create or replace trigger log_change after insert or update or delete on app.registration_link
  for each row execute function app.log_change();

alter table app.team enable row level security;
alter table app.registration_link enable row level security;
drop policy if exists member_read on app.team;
create policy member_read on app.team for select to authenticated using (app.is_member(tournament_id));
drop policy if exists member_read on app.registration_link;
create policy member_read on app.registration_link for select to authenticated using (app.is_member(tournament_id));
revoke all on app.team, app.registration_link from public, anon, authenticated;
grant select on app.team, app.registration_link to authenticated;

-- Teams are added and links reissued while setup or registration is open; a link can be revoked in any status.
insert into app.season_action values
  ('manage_teams', 'setup'), ('manage_teams', 'registration'),
  ('revoke_links', 'setup'), ('revoke_links', 'registration'), ('revoke_links', 'started'), ('revoke_links', 'finished'),
  ('open_registration', 'setup'), ('open_registration', 'registration')
on conflict do nothing;

-- Commands ---------------------------------------------------------------------------------------

-- Adds a Team with its first Registration link. Insert-only: a reused Team or link id (or hash) is already_exists; a
-- code the Season already uses is team_code_taken. The answer carries no version (the outbox would file it under the
-- scope); a new Team and link are version 1.
create or replace function app.add_team(
  command_id uuid, team_id uuid, season_id uuid, name text, code text, link_id uuid, token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'manage_teams', jsonb_build_object('season_id', season_id));
  r jsonb;
  t uuid;
  n text := regexp_replace(name, '^\s+|\s+$', '', 'g');
  c text := upper(regexp_replace(code, '^\s+|\s+$', '', 'g'));
  k text;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select x.tournament_id into t from app.season x where x.id = season_id;
  if n is null or char_length(n) not between 1 and 80 or n ~ '[\u0001-\u001f\u007f-\u009f  ]' then
    r := jsonb_build_object('ok', false, 'code', 'name_invalid', 'message', 'Name must be 1 to 80 characters.');
  elsif c is null or c !~ '^[A-Z0-9]{2,5}$' then
    r := jsonb_build_object('ok', false, 'code', 'code_invalid', 'message', 'Team code must be 2 to 5 letters or digits.');
  elsif token_hash is null or token_hash !~ '^[0-9a-f]{64}$' or link_id is null then
    r := jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'The link is not valid.');
  else
    begin
      insert into app.team (id, tournament_id, season_id, name, code) values (team_id, t, season_id, n, c);
      insert into app.registration_link (id, tournament_id, team_id, token_hash, created_by)
      values (link_id, t, team_id, token_hash, actor);
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Team added.');
    exception when unique_violation then
      get stacked diagnostics k = constraint_name;
      r := case when k = 'team_season_code_idx'
        then jsonb_build_object('ok', false, 'code', 'team_code_taken', 'message', 'That Team code is already used in this Season.')
        else jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.') end;
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Opens registration: the Season moves from setup to registration (through app.season_transition). Already open is ok.
-- Needs the photo-consent statement and all three dates (setup_incomplete). Status is not versioned content, so the
-- Season's version stays.
create or replace function app.open_registration(command_id uuid, season_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'open_registration', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.season;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.season x where x.id = season_id for update;
  if cur.status = 'registration' then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Registration is already open.');
  elsif btrim(cur.photo_consent) = '' or cur.starts_on is null or cur.ends_on is null or cur.registration_deadline is null then
    r := jsonb_build_object('ok', false, 'code', 'setup_incomplete', 'message', 'Add the photo-consent statement and the Season dates first.');
  else
    update app.season x set status = 'registration' where x.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Registration open.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Revokes a Registration link: it stops working at once. Revoking one already revoked is ok.
create or replace function app.revoke_registration_link(command_id uuid, season_id uuid, link_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'revoke_links', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.registration_link;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select l.* into cur from app.registration_link l join app.team x on x.id = l.team_id
  where l.id = link_id and x.season_id = season_id for update of l;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'link_missing', 'message', 'That link does not exist.');
  else
    update app.registration_link l set revoked_at = now(), version = l.version + 1 where l.id = cur.id and l.revoked_at is null;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Link revoked.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Replaces a Team's link: its active link (if any) is revoked and the new one is active, in one step with the Team row
-- locked, so two reissues at once still leave exactly one active link. Insert-only for the new link.
create or replace function app.reissue_registration_link(command_id uuid, season_id uuid, team_id uuid, link_id uuid, token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'manage_teams', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.team;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.team x where x.id = team_id and x.season_id = season_id for update;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'team_missing', 'message', 'That Team does not exist.');
  elsif token_hash is null or token_hash !~ '^[0-9a-f]{64}$' or link_id is null then
    r := jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'The link is not valid.');
  else
    begin
      update app.registration_link l set revoked_at = now(), version = l.version + 1 where l.team_id = cur.id and l.revoked_at is null;
      insert into app.registration_link (id, tournament_id, team_id, token_hash, created_by)
      values (link_id, cur.tournament_id, cur.id, token_hash, actor);
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'New link made.');
    exception when unique_violation then
      r := jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.add_team(uuid, uuid, uuid, text, text, uuid, text), app.open_registration(uuid, uuid),
  app.revoke_registration_link(uuid, uuid, uuid), app.reissue_registration_link(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function app.add_team(uuid, uuid, uuid, text, text, uuid, text), app.open_registration(uuid, uuid),
  app.revoke_registration_link(uuid, uuid, uuid), app.reissue_registration_link(uuid, uuid, uuid, uuid, text) to authenticated;
