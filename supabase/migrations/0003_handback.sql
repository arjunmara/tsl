-- 0003_handback.sql: discarding a refused change (logged), the server clock and client error reports.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- Activity log rows for a change outside any Tournament (a discard of a never-created one) have no
-- Tournament id; the actor reads those rows.
alter table app.activity_log alter column tournament_id drop not null;

-- One row per discarded command: id is the discarded command_id, unique per actor (command ids are
-- per actor, like app.command_result). tournament_id is null when the scope names no Tournament or
-- Season the actor belongs to (e.g. a create that never happened).
create table if not exists app.discarded_command (
  id uuid not null,
  tournament_id uuid,
  actor uuid not null,
  name text not null,
  scope text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  version int not null default 1,
  primary key (actor, id)
);
create index if not exists discarded_command_tournament_idx on app.discarded_command (tournament_id);

create or replace trigger log_change after insert or update or delete on app.discarded_command
  for each row execute function app.log_change();

-- authorize: as in 0002, plus discard_command with no Tournament target (signed in and verified is enough).
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
  if p_action = 'discard_command' and t is null and s is null then return null; end if;
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

-- Helpers ----------------------------------------------------------------------------------------

-- The server clock, for the outbox's entered_at offset.
create or replace function app.server_now() returns timestamptz
language sql stable security definer set search_path = '' as $$ select now() $$;

-- One line of JSON in the Postgres log (Supabase > Logs > Postgres). The client strips personal data;
-- every field is cut to 200 characters here. frame: the first stack frame's file:line.
-- ponytail: no server-side rate limit (the client sends at most 5 per page load); add one if logs get spammed.
create or replace function app.report_client_error(app_version text, route text, error_name text, message text, frame text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  raise log '%', jsonb_build_object('event', 'client_error', 'app_version', left(app_version, 200),
    'route', left(route, 200), 'error_name', left(error_name, 200), 'message', left(message, 200),
    'frame', left(frame, 200))::text;
end $$;

-- Commands ---------------------------------------------------------------------------------------

-- Logs that the user discarded a refused change (it is never sent). scope: the outbox scope of the
-- discarded change (a Tournament or Season id, or a word like 'global'). The row gets the Tournament
-- only when the actor is one of its Organisers; any other scope (someone else's, unknown, a word) is
-- logged with tournament_id null, visible only to the actor, so the answer never reveals what exists.
create or replace function app.discard_command(command_id uuid, discarded_id uuid, name text, scope text, reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'discard_command', '{}'::jsonb);
  sid uuid := case when scope ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then scope::uuid end;
  t uuid;
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true),
          set_config('app.reason', left(coalesce(reason, ''), 200), true);
  select m.tournament_id into t from app.organiser_membership m
  where m.user_id = actor and m.tournament_id = coalesce((select s.tournament_id from app.season s where s.id = sid), sid);
  if discarded_id is null then
    r := jsonb_build_object('ok', false, 'code', 'request_failed', 'message', 'discarded_id is required.');
  else
    -- Discarding the same change twice is not an error: it is already discarded.
    insert into app.discarded_command (id, tournament_id, actor, name, scope, reason)
    values (discarded_id, t, actor, left(coalesce(name, ''), 200), left(coalesce(scope, ''), 200), left(coalesce(reason, ''), 200))
    on conflict on constraint discarded_command_pkey do nothing;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Change discarded.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- RLS and grants ---------------------------------------------------------------------------------

alter table app.discarded_command enable row level security;
drop policy if exists member_read on app.discarded_command;
create policy member_read on app.discarded_command for select to authenticated
  using (app.is_member(tournament_id) or (tournament_id is null and actor = auth.uid()));
drop policy if exists member_read on app.activity_log;
create policy member_read on app.activity_log for select to authenticated
  using (app.is_member(tournament_id) or (tournament_id is null and actor = auth.uid()));

revoke all on app.discarded_command from public, anon, authenticated;
revoke all on function app.authorize(uuid, text, jsonb), app.server_now(),
  app.report_client_error(text, text, text, text, text), app.discard_command(uuid, uuid, text, text, text)
  from public, anon, authenticated;

grant select on app.discarded_command to authenticated;
grant execute on function app.discard_command(uuid, uuid, text, text, text) to authenticated;
grant execute on function app.server_now(), app.report_client_error(text, text, text, text, text) to anon, authenticated;
