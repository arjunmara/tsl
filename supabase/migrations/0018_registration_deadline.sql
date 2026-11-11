-- 0018_registration_deadline.sql: Registration links close at the deadline by themselves; an Organiser reopens one Team's
-- link for a named reason (Story 2.9, FR-14). The deadline is a whole day in Asia/Kathmandu: a link is open through the end
-- of that day, or of the Team's reopen date if later. app.season_allows decides it, for Registration-link (grant) actions
-- only; Organisers keep editing until the Season starts. A command counts by when it was entered on the phone (the
-- outbox's entered_at, sent as the request header x-entered-at, capped at the server's now) and is accepted if entered
-- before the close and received within app.grace_window() after it. The founder applies this in the Supabase SQL Editor as
-- `postgres`: test first, then live. Safe to run twice.

-- reopened_until: the Team's link is open through this day (Asia/Kathmandu) even after the deadline. reopen_reason: the
-- Organiser's reason in words, shown to the Team manager and put on their changes in the Activity log. Not personal.
alter table app.team add column if not exists reopened_until date;
alter table app.team add column if not exists reopen_reason text check (char_length(reopen_reason) between 1 and 200);

-- Links are reopened while setup or registration is open.
insert into app.season_action values ('reopen_link', 'setup'), ('reopen_link', 'registration') on conflict do nothing;

-- The one grace window (AD-6): how long after a close a command entered before it is still accepted.
create or replace function app.grace_window() returns interval
language sql immutable security definer set search_path = '' as $$ select interval '1 hour' $$;

-- The moment a Team's Registration link closes: the end of the deadline day (or the reopen day, if later) in
-- Asia/Kathmandu. null: no deadline set (open).
create or replace function app.link_closes_at(p_team_id uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select ((greatest(s.registration_deadline, t.reopened_until) + 1)::timestamp) at time zone 'Asia/Kathmandu'
  from app.team t join app.season s on s.id = t.season_id where t.id = p_team_id
$$;

-- The only "allowed now?" decision. p_team_id: the Team whose Registration link is acting (a grant); its deadline applies.
-- null = allowed, else not_found, season_<status> or registration_closed.
create or replace function app.season_allows(p_season_id uuid, p_action text, p_team_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  s text;
  closes timestamptz;
  entered timestamptz;
begin
  select status into s from app.season where id = p_season_id;
  if s is null then return 'not_found'; end if;
  if not exists (select 1 from app.season_action a where a.action = p_action and a.status = s) then
    return 'season_' || s;
  end if;
  if p_team_id is null then return null; end if;
  closes := app.link_closes_at(p_team_id);
  if closes is null then return null; end if;
  begin
    entered := (nullif(current_setting('request.headers', true), '')::json ->> 'x-entered-at')::timestamptz;
  exception when others then
    entered := null;
  end;
  entered := least(coalesce(entered, now()), now());
  if entered < closes and now() < closes + app.grace_window() then return null; end if;
  return 'registration_closed';
end $$;

create or replace function app.season_allows(p_season_id uuid, p_action text) returns text
language sql stable security definer set search_path = '' as $$ select app.season_allows(p_season_id, p_action, null) $$;

-- authorize: as in 0017; a grant's actions also pass its Team to season_allows (the deadline).
create or replace function app.authorize(p_actor uuid, p_action text, p_target jsonb) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  confirmed timestamptz;
  anonymous boolean;
  t uuid := (p_target ->> 'tournament_id')::uuid;
  s uuid := (p_target ->> 'season_id')::uuid;
  tm uuid := (p_target ->> 'team_id')::uuid;
  ts uuid;
  st text;
begin
  if p_actor is null then return 'not_signed_in'; end if;
  select u.email_confirmed_at, coalesce(u.is_anonymous, false) into confirmed, anonymous from auth.users u where u.id = p_actor;
  if not found then return 'not_signed_in'; end if;
  if tm is not null then
    select x.season_id, x.status into ts, st from app.team x where x.id = tm;
    if ts is null or ts <> coalesce(s, ts) then return 'not_authorized'; end if;
    s := ts;
  end if;
  if anonymous then
    if p_action = 'redeem_registration_link' then return null; end if;
    if p_action = 'discard_command' and t is null and s is null then return null; end if;
    if p_action <> all (array['edit_team', 'edit_squad', 'submit_team']) or tm is null or not exists (
        select 1 from app.registration_grant g join app.registration_link l on l.id = g.link_id and l.revoked_at is null
        where g.id = p_actor and g.team_id = tm) then
      return 'not_authorized';
    end if;
    if st = 'withdrawn' then return 'team_withdrawn'; end if;
    if st = 'approved' then return 'team_approved'; end if;
    return app.season_allows(s, p_action, tm);
  end if;
  if confirmed is null then return 'email_not_verified'; end if;
  if p_action = 'redeem_registration_link' then return 'not_authorized'; end if;
  if p_action = 'create_tournament' then return null; end if;
  if p_action in ('discard_command', 'accept_invite') and t is null and s is null then return null; end if;
  if s is not null then
    select tournament_id into t from app.season where id = s;
  end if;
  if t is null or not exists (select 1 from app.organiser_membership m
                              where m.tournament_id = t and m.user_id = p_actor) then
    return 'not_authorized';
  end if;
  if st = 'withdrawn' and p_action <> 'review_team' then return 'team_withdrawn'; end if;
  if s is not null then return app.season_allows(s, p_action); end if;
  return null;
end $$;

-- log_change: as in 0013; a grant's change made after the Season's deadline (so through a reopened link) carries the
-- reopen reason when the command set none. The actor is the grant: one per phone that opened the link.
create or replace function app.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  a jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  k text;
  actor uuid := nullif(current_setting('app.actor', true), '')::uuid;
  why text := nullif(current_setting('app.reason', true), '');
begin
  if tg_nargs < 2 then
    raise exception 'log_change on app.%: declare the personal fields as the second trigger argument', tg_table_name;
  end if;
  foreach k in array tg_argv[1]::text[] loop
    if jsonb_typeof(b -> k) <> 'null' then b := jsonb_set(b, array[k], to_jsonb(k)); end if;
    if jsonb_typeof(a -> k) <> 'null' then a := jsonb_set(a, array[k], to_jsonb(k)); end if;
  end loop;
  if why is null and actor is not null then
    select t.reopen_reason into why from app.registration_grant g join app.team t on t.id = g.team_id
      join app.season s on s.id = t.season_id
    where g.id = actor and t.reopen_reason is not null
      and now() >= ((s.registration_deadline + 1)::timestamp) at time zone 'Asia/Kathmandu';
  end if;
  insert into app.activity_log (tournament_id, actor, command_id, table_name, row_id, op, before, after, reason)
  values (
    (coalesce(a, b) ->> tg_argv[0])::uuid,
    actor,
    nullif(current_setting('app.command_id', true), '')::uuid,
    tg_table_name,
    (coalesce(a, b) ->> 'id')::uuid,
    lower(tg_op), b, a,
    why);
  return null;
end $$;

-- Commands ---------------------------------------------------------------------------------------

-- Reopens one Team's link through `until` (from today, Asia/Kathmandu, up to the Season's start) for a reason (1–200
-- characters, trimmed), logged with that reason. Organisers only; a grant is not_authorized. A later reopen replaces the
-- earlier one. Not versioned content (as the review commands in 0017): queued manager edits keep their base.
create or replace function app.reopen_registration_link(command_id uuid, team_id uuid, reason text, until date)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'reopen_link', jsonb_build_object('team_id', team_id));
  r jsonb;
  n text := btrim(reason);
  starts date;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  select s.starts_on into starts from app.team t join app.season s on s.id = t.season_id where t.id = team_id;
  if n is null or char_length(n) not between 1 and 200 then
    r := jsonb_build_object('ok', false, 'code', 'reason_invalid', 'message', 'Write a reason of 1 to 200 characters.');
  elsif until is null or until < (now() at time zone 'Asia/Kathmandu')::date or until > coalesce(starts, until) then
    r := jsonb_build_object('ok', false, 'code', 'reopen_date_invalid', 'message', 'Choose a closing date from today up to the start date.');
  else
    perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true),
            set_config('app.reason', n, true);
    update app.team t set reopened_until = until, reopen_reason = n where t.id = team_id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Link reopened.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.grace_window(), app.link_closes_at(uuid), app.season_allows(uuid, text, uuid),
  app.reopen_registration_link(uuid, uuid, text, date) from public, anon, authenticated;
grant execute on function app.reopen_registration_link(uuid, uuid, text, date) to authenticated;
