-- 0002_command_skeleton.sql: first tables, the command skeleton and the first command.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live.
-- Safe to run twice. Clients get SELECT (through RLS) and EXECUTE on commands only; every write
-- goes through a command: `security definer set search_path = ''`, calling app.authorize then
-- app.claim_command. See README.md for the helper vs command rule.

-- Tables -----------------------------------------------------------------------------------------

create table if not exists app.tournament (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  version int not null default 1
);

create table if not exists app.organiser_membership (
  tournament_id uuid not null references app.tournament (id),
  user_id uuid not null,
  created_at timestamptz not null default now(),
  version int not null default 1,
  primary key (tournament_id, user_id)
);
create index if not exists organiser_membership_user_idx on app.organiser_membership (user_id);

create table if not exists app.season (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  number int not null check (number > 0),
  status text not null default 'setup' check (status in ('setup', 'registration', 'started', 'finished')),
  created_at timestamptz not null default now(),
  version int not null default 1,
  unique (tournament_id, number)
);

-- Allowed Season status changes; only lifecycle commands (none yet) may move a Season.
create table if not exists app.season_transition (
  from_status text not null,
  to_status text not null,
  primary key (from_status, to_status)
);
insert into app.season_transition values
  ('setup', 'registration'), ('registration', 'started'), ('started', 'finished')
on conflict do nothing;

-- Which action is allowed in which Season status. Read only by app.season_allows.
create table if not exists app.season_action (
  action text not null,
  status text not null check (status in ('setup', 'registration', 'started', 'finished')),
  primary key (action, status)
);
insert into app.season_action values ('edit_setup', 'setup'), ('edit_setup', 'registration')
on conflict do nothing;

-- Stored command results, so a repeated command_id returns the first answer. result null = pending.
-- ponytail: grows unbounded; add a cleanup job deleting rows older than 30 days later.
create table if not exists app.command_result (
  actor uuid not null,
  command_id uuid not null,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (actor, command_id)
);

create table if not exists app.activity_log (
  id bigint generated always as identity primary key,
  tournament_id uuid not null,
  at timestamptz not null default now(),
  actor uuid,
  command_id uuid,
  table_name text not null,
  row_id uuid,
  op text not null,
  before jsonb,
  after jsonb,
  reason text
);
create index if not exists activity_log_tournament_idx on app.activity_log (tournament_id, at);

-- Helpers ----------------------------------------------------------------------------------------

-- RLS: is the signed-in user an Organiser of this Tournament? Security definer so the
-- organiser_membership policy can use it without recursing into itself.
create or replace function app.is_member(p_tournament_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.organiser_membership m
                 where m.tournament_id = p_tournament_id and m.user_id = auth.uid())
$$;

-- The only function that reads season_action. null = allowed, else season_<status>.
create or replace function app.season_allows(p_season_id uuid, p_action text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare s text;
begin
  select status into s from app.season where id = p_season_id;
  if s is null then return 'not_found'; end if;
  if exists (select 1 from app.season_action a where a.action = p_action and a.status = s) then
    return null;
  end if;
  return 'season_' || s;
end $$;

-- null = allowed, else a code. target: {tournament_id?, season_id?}.
create or replace function app.authorize(p_actor uuid, p_action text, p_target jsonb) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  confirmed timestamptz;
  t uuid := (p_target ->> 'tournament_id')::uuid;
  s uuid := (p_target ->> 'season_id')::uuid;
begin
  if p_actor is null then return 'not_signed_in'; end if;
  select email_confirmed_at into confirmed from auth.users where id = p_actor;
  if not found then return 'not_signed_in'; end if;
  if confirmed is null then return 'email_not_verified'; end if;
  if p_action = 'create_tournament' then return null; end if;
  if s is not null then
    select tournament_id into t from app.season where id = s;
  end if;
  if t is null or not exists (select 1 from app.organiser_membership m
                              where m.tournament_id = t and m.user_id = p_actor) then
    return 'not_authorized';
  end if;
  if s is not null then return app.season_allows(s, p_action); end if;
  return null;
end $$;

-- Stored result for a repeated command, else null after inserting a pending row.
create or replace function app.claim_command(p_actor uuid, p_command_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  insert into app.command_result (actor, command_id) values (p_actor, p_command_id)
  on conflict do nothing;
  if found then return null; end if;
  select result into r from app.command_result where actor = p_actor and command_id = p_command_id;
  return coalesce(r, '{"ok": false, "code": "in_progress", "message": "This command is still running."}');
end $$;

create or replace function app.finish_command(p_actor uuid, p_command_id uuid, p_result jsonb) returns void
language sql security definer set search_path = '' as $$
  update app.command_result set result = p_result where actor = p_actor and command_id = p_command_id
$$;

-- Generic Activity log row trigger. TG_ARGV[0]: the column holding the Tournament id
-- (default tournament_id). Personal fields are logged by name only.
create or replace function app.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  a jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  k text;
begin
  foreach k in array array['email', 'phone', 'date_of_birth', 'guardian_name', 'document_number'] loop
    if b ? k then b := jsonb_set(b, array[k], to_jsonb(k)); end if;
    if a ? k then a := jsonb_set(a, array[k], to_jsonb(k)); end if;
  end loop;
  insert into app.activity_log (tournament_id, actor, command_id, table_name, row_id, op, before, after, reason)
  values (
    (coalesce(a, b) ->> coalesce(tg_argv[0], 'tournament_id'))::uuid,
    nullif(current_setting('app.actor', true), '')::uuid,
    nullif(current_setting('app.command_id', true), '')::uuid,
    tg_table_name,
    (coalesce(a, b) ->> 'id')::uuid,
    lower(tg_op), b, a,
    nullif(current_setting('app.reason', true), ''));
  return null;
end $$;

-- Season status may only move along app.season_transition (or stay the same).
create or replace function app.season_status_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> old.status and not exists (select 1 from app.season_transition t
      where t.from_status = old.status and t.to_status = new.status) then
    raise exception 'season status cannot change from % to %', old.status, new.status;
  end if;
  return new;
end $$;

create or replace function app.activity_log_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'activity_log is append-only';
end $$;

-- Commands ---------------------------------------------------------------------------------------

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
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Tournament created.');
    exception when unique_violation then
      r := jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Triggers ---------------------------------------------------------------------------------------

create or replace trigger log_change after insert or update or delete on app.tournament
  for each row execute function app.log_change('id');
create or replace trigger log_change after insert or update or delete on app.organiser_membership
  for each row execute function app.log_change();
create or replace trigger log_change after insert or update or delete on app.season
  for each row execute function app.log_change();
create or replace trigger status_guard before update of status on app.season
  for each row execute function app.season_status_guard();
create or replace trigger immutable before update or delete on app.activity_log
  for each row execute function app.activity_log_immutable();
create or replace trigger immutable_truncate before truncate on app.activity_log
  for each statement execute function app.activity_log_immutable();

-- RLS and grants ---------------------------------------------------------------------------------

alter table app.tournament enable row level security;
alter table app.organiser_membership enable row level security;
alter table app.season enable row level security;
alter table app.season_transition enable row level security;
alter table app.season_action enable row level security;
alter table app.command_result enable row level security;
alter table app.activity_log enable row level security;

drop policy if exists member_read on app.tournament;
create policy member_read on app.tournament for select to authenticated using (app.is_member(id));
drop policy if exists member_read on app.organiser_membership;
create policy member_read on app.organiser_membership for select to authenticated using (app.is_member(tournament_id));
drop policy if exists member_read on app.season;
create policy member_read on app.season for select to authenticated using (app.is_member(tournament_id));
drop policy if exists member_read on app.activity_log;
create policy member_read on app.activity_log for select to authenticated using (app.is_member(tournament_id));
drop policy if exists read_all on app.season_transition;
create policy read_all on app.season_transition for select to authenticated using (true);
drop policy if exists read_all on app.season_action;
create policy read_all on app.season_action for select to authenticated using (true);
-- command_result: no policy, no grant; only the commands read it.

-- 0001's default privileges already start everything locked; repeat it so a run by another role
-- cannot leave anything open.
revoke all on app.tournament, app.organiser_membership, app.season, app.season_transition,
  app.season_action, app.command_result, app.activity_log from public, anon, authenticated;
revoke update, delete, truncate on app.activity_log from public, anon, authenticated, service_role;
revoke all on function app.is_member(uuid), app.season_allows(uuid, text), app.authorize(uuid, text, jsonb),
  app.claim_command(uuid, uuid), app.finish_command(uuid, uuid, jsonb), app.log_change(),
  app.season_status_guard(), app.activity_log_immutable(), app.create_tournament(uuid, uuid, uuid, text) from public, anon, authenticated;

grant select on app.tournament, app.organiser_membership, app.season, app.activity_log,
  app.season_transition, app.season_action to authenticated;
grant execute on function app.is_member(uuid) to authenticated;
grant execute on function app.create_tournament(uuid, uuid, uuid, text) to authenticated;
