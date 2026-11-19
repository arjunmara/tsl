-- 0035_handover.sql: hand over and take over scoring (Story 4.8, FR-3, AD-20, AD-6). app.takeover_request holds a Scorer phone's ask to take over a
-- Match (status pending, approved, declined or expired; a pending one past expires_at, 2 minutes, counts as expired; one pending per Match, a newer
-- ask replaces older ones). Commands: hand_over_scoring (the holder passes scoring to another approved Scorer phone of the Season), ask_take_over (an
-- approved phone that is not the holder), approve_take_over and decline_take_over (Organisers), take_over_scoring (an Organiser takes it directly).
-- Every move puts the old holder on app.match.scoring_prev (a list of {device, moved_at}, pruned past the grace window; scoring_prev_device and
-- scoring_moved_at stay as the latest one) and closes the Match's other pending asks; it does not change the Match's version. app.holds_scoring (0034) is
-- recreated here: it also accepts any device on that list for changes entered before its moved_at plus the grace window, so A to B to C keeps A's grace. Reads: app.scoring_state(match) (the holder's name, whether the caller holds it, the caller's own ask, the
-- version; for the holder also the phones it can hand over to) and app.takeover_requests(tournament) (pending asks, Organisers only). The founder
-- applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.match add column if not exists scoring_prev jsonb not null default '[]';

create table if not exists app.takeover_request (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references app.tournament (id),
  season_id uuid not null references app.season (id),
  match_id uuid not null references app.match (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 40),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  version int not null default 1
);
create unique index if not exists takeover_request_pending_idx on app.takeover_request (match_id) where status = 'pending';
create index if not exists takeover_request_user_idx on app.takeover_request (user_id, created_at desc);

-- The label is a name for a phone, not personal data.
create or replace trigger log_change after insert or update or delete on app.takeover_request
  for each row execute function app.log_change('tournament_id', '{}');

-- Organisers read their Tournament's asks; a Scorer phone reads its own only through app.scoring_state.
alter table app.takeover_request enable row level security;
drop policy if exists member_read on app.takeover_request;
create policy member_read on app.takeover_request for select to authenticated using (app.is_member(tournament_id));
revoke all on app.takeover_request from public, anon, authenticated;
grant select on app.takeover_request to authenticated;

insert into app.season_action values ('hand_over_scoring', 'started'), ('ask_take_over', 'started'), ('approve_take_over', 'started'),
  ('decline_take_over', 'started'), ('take_over_scoring', 'started')
on conflict do nothing;

-- authorize: as in 0032, plus hand_over_scoring and ask_take_over for an approved Scorer phone of the Season (the other three are Organiser-only).
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
  entered timestamptz;
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
    if p_action in ('redeem_registration_link', 'request_scorer_approval') then return null; end if;
    if p_action = 'discard_command' and t is null and s is null then return null; end if;
    if p_action in ('take_scoring', 'confirm_lineups', 'show_on_stream', 'start_clock', 'pause_clock', 'next_period', 'set_clock', 'end_match',
      'record_goal', 'add_assist', 'edit_event', 'delete_event', 'record_event', 'hand_over_scoring', 'ask_take_over') then
      begin
        entered := (nullif(current_setting('request.headers', true), '')::json ->> 'x-entered-at')::timestamptz;
      exception when others then
        entered := null;
      end;
      if s is null or not app.scorer_allows(p_actor, s, least(coalesce(entered, now()), now())) then return 'not_authorized'; end if;
      return app.season_allows(s, p_action);
    end if;
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
  if p_action in ('redeem_registration_link', 'request_scorer_approval') then return 'not_authorized'; end if;
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
  if s is not null then return app.season_allows(s, p_action, null, coalesce((p_target ->> 'confirmed')::boolean, false)); end if;
  return null;
end $$;

-- Helpers ----------------------------------------------------------------------------------------

-- 0034's grace rule, widened from one previous holder to the list: a device on scoring_prev (or the latest, scoring_prev_device) is accepted for a change
-- entered before its own moved_at plus the grace window.
create or replace function app.holds_scoring(m app.match, p_actor uuid, p_at timestamptz) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  entered timestamptz;
begin
  if m.scoring_device is not distinct from p_actor then return true; end if;
  begin
    entered := (nullif(current_setting('request.headers', true), '')::json ->> 'x-entered-at')::timestamptz;
  exception when others then
    entered := null;
  end;
  entered := least(coalesce(entered, p_at, now()), now());
  return coalesce(m.scoring_prev_device = p_actor and entered < m.scoring_moved_at + app.grace_window(), false)
    or exists (select 1 from jsonb_array_elements(m.scoring_prev) x
      where (x ->> 'device')::uuid = p_actor and entered < (x ->> 'moved_at')::timestamptz + app.grace_window());
end $$;

-- The name of a phone as the Match shows it: its Scorer label, or null for an Organiser or nobody.
create or replace function app.holder_label(p_season_id uuid, p_actor uuid) returns text
language sql stable security definer set search_path = '' as $$
  select d.label from app.scorer_device d where d.user_id = p_actor and d.season_id = p_season_id order by (d.status = 'approved') desc, d.created_at desc limit 1
$$;

-- Moves scoring of a locked Match to p_to: the old holder joins the list of previous holders (4.7's grace; the version does not change), other pending asks close.
create or replace function app.move_scoring(p_match_id uuid, p_to uuid) returns void
language sql security definer set search_path = '' as $$
  update app.match x set scoring_prev_device = x.scoring_device, scoring_device = p_to, scoring_moved_at = now(),
    scoring_prev = coalesce((select jsonb_agg(e) from jsonb_array_elements(x.scoring_prev) e
        where (e ->> 'moved_at')::timestamptz + app.grace_window() > now() and (e ->> 'device')::uuid is distinct from p_to), '[]')
      || case when x.scoring_device is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('device', x.scoring_device, 'moved_at', now())) end
  where x.id = p_match_id;
  update app.takeover_request x set status = 'expired', version = x.version + 1 where x.match_id = p_match_id and x.status = 'pending'
$$;

-- Reads ------------------------------------------------------------------------------------------

-- The light read a console polls: null for anyone but an Organiser or approved Scorer phone of the Match's Season. holder_label: the holder's phone name
-- (null for an Organiser or nobody); stamp: changes with the Match's events, line-ups and On-air flag (none of them changes the version); mine: this caller holds it; request: the caller's latest ask (id, status with expiry applied); devices: for the holder,
-- the approved phones it can hand over to (not itself).
create or replace function app.scoring_state(p_match_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  m app.match;
  rq app.takeover_request;
begin
  select * into m from app.match x where x.id = p_match_id;
  if not found or not app.console_reads(m.tournament_id, m.season_id) then return null; end if;
  select * into rq from app.takeover_request x where x.match_id = m.id and x.user_id = auth.uid() and x.created_at >= coalesce(m.scoring_moved_at, '-infinity')
    order by x.created_at desc limit 1;
  return jsonb_build_object('version', m.version, 'stamp', md5(coalesce((select string_agg(e.id || ':' || e.version || ':' || (e.deleted_at is not null), ',' order by e.id) from app.match_event e where e.match_id = m.id), '')
      || '|' || coalesce((select string_agg(l.team_id || ':' || l.version, ',' order by l.team_id) from app.match_lineup l where l.match_id = m.id), '')
      || '|' || exists (select 1 from app.live_state l where l.tournament_id = m.tournament_id and l.on_air_match_id = m.id)), 'status', m.status, 'held', m.scoring_device is not null,
    'mine', m.scoring_device is not null and m.scoring_device = auth.uid(),
    'holder_label', app.holder_label(m.season_id, m.scoring_device),
    'request', case when rq.id is null then null else jsonb_build_object('id', rq.id,
      'status', case when rq.status = 'pending' and rq.expires_at <= now() then 'expired' else rq.status end) end,
    'devices', case when m.scoring_device is not distinct from auth.uid() and m.scoring_device is not null then coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'label', d.label) order by d.label, d.created_at)
      from (select distinct on (x.user_id) x.* from app.scorer_device x where x.season_id = m.season_id order by x.user_id, x.created_at desc) d
      where d.status = 'approved' and d.user_id <> m.scoring_device), '[]') else '[]'::jsonb end);
end $$;

-- The Tournament's pending asks (Organisers only; none for anyone else): the Match's Teams, who asks and who holds it now.
create or replace function app.takeover_requests(p_tournament_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'match_id', q.match_id, 'season_id', q.season_id, 'label', q.label,
      'home_code', h.code, 'away_code', a.code, 'holder_label', app.holder_label(q.season_id, m.scoring_device), 'expires_at', q.expires_at, 'version', q.version)
    order by q.created_at), '[]')
  from app.takeover_request q join app.match m on m.id = q.match_id
  left join app.match_resolve(q.season_id) r on r.match_id = m.id
  left join app.team h on h.id = r.home_team_id left join app.team a on a.id = r.away_team_id
  where q.tournament_id = p_tournament_id and app.is_member(p_tournament_id) and q.status = 'pending' and q.expires_at > now()
$$;

-- Commands ---------------------------------------------------------------------------------------

-- The holder hands scoring to another approved Scorer phone of the Season (device: its app.scorer_device id). A stale version is a version_conflict.
create or replace function app.hand_over_scoring(command_id uuid, season_id uuid, match_id uuid, device_id uuid, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'hand_over_scoring', jsonb_build_object('season_id', season_id));
  r jsonb;
  m app.match;
  d app.scorer_device;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into m from app.match x where x.id = match_id and x.season_id = season_id for update;
  select * into d from app.scorer_device x where x.id = device_id and x.season_id = season_id and x.status = 'approved';
  if m.id is null then
    r := jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match no longer exists.');
  elsif not app.is_member(m.tournament_id) and not exists (select 1 from app.scorer_device x where x.user_id = actor and x.season_id = season_id and x.status = 'approved') then
    r := jsonb_build_object('ok', false, 'code', 'not_authorized', 'message', 'Not allowed.');
  elsif m.scoring_device is distinct from actor then
    r := jsonb_build_object('ok', false, 'code', 'not_scoring_device', 'message', 'Another phone is scoring this match.');
  elsif m.status = 'finished' then
    r := jsonb_build_object('ok', false, 'code', 'match_finished', 'message', 'This Match is finished.');
  elsif d.id is null or d.user_id = actor then
    r := jsonb_build_object('ok', false, 'code', 'device_not_approved', 'message', 'That phone is not an approved Scorer for this Season.');
  elsif m.version is distinct from expected_version then
    r := app.conflict(m.tournament_id, 'match', m.id, m.version, '{}');
  else
    perform app.move_scoring(m.id, d.user_id);
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Scoring handed over.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- An approved Scorer phone asks to take over a Match another phone holds; the ask lasts 2 minutes and replaces this Match's older asks.
create or replace function app.ask_take_over(command_id uuid, season_id uuid, match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'ask_take_over', jsonb_build_object('season_id', season_id));
  r jsonb;
  m app.match;
  d app.scorer_device;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into m from app.match x where x.id = match_id and x.season_id = season_id for update;
  select * into d from app.scorer_device x where x.user_id = actor and x.season_id = season_id and x.status = 'approved' order by x.created_at desc limit 1;
  if m.id is null then
    r := jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match no longer exists.');
  elsif d.id is null then
    r := jsonb_build_object('ok', false, 'code', 'not_authorized', 'message', 'Not allowed.');
  elsif m.status = 'finished' then
    r := jsonb_build_object('ok', false, 'code', 'match_finished', 'message', 'This Match is finished.');
  elsif m.scoring_device is null then
    r := jsonb_build_object('ok', false, 'code', 'scoring_free', 'message', 'Nobody is scoring this match. Open it to score.');
  elsif m.scoring_device = actor then
    r := jsonb_build_object('ok', false, 'code', 'already_scoring', 'message', 'You are already scoring this match.');
  else
    update app.takeover_request x set status = 'expired', version = x.version + 1 where x.match_id = m.id and x.status = 'pending';
    insert into app.takeover_request (tournament_id, season_id, match_id, user_id, label, expires_at)
    values (m.tournament_id, season_id, m.id, actor, d.label, now() + interval '2 minutes');
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Asked to take over.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- An Organiser lets the asking phone score, even when the old holder is offline or dead. After the 2 minutes: request_expired.
create or replace function app.approve_take_over(command_id uuid, season_id uuid, request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'approve_take_over', jsonb_build_object('season_id', season_id));
  r jsonb;
  q app.takeover_request;
  m app.match;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  -- The request row is locked first (decline locks it too), then the Match: a concurrent answer waits and then finds the ask answered.
  select * into q from app.takeover_request x where x.id = request_id and x.season_id = season_id for update;
  select * into m from app.match x where x.id = q.match_id for update;
  if q.id is null then
    r := jsonb_build_object('ok', false, 'code', 'request_missing', 'message', 'That request no longer exists.');
  elsif q.status in ('approved', 'declined') then
    r := jsonb_build_object('ok', false, 'code', 'request_answered', 'message', 'Another organiser already answered this request.');
  elsif q.status <> 'pending' or q.expires_at <= now() then
    if q.status = 'pending' then update app.takeover_request x set status = 'expired', version = x.version + 1 where x.id = q.id; end if;
    r := jsonb_build_object('ok', false, 'code', 'request_expired', 'message', 'That request has expired.');
  elsif m.status = 'finished' then
    r := jsonb_build_object('ok', false, 'code', 'match_finished', 'message', 'This Match is finished.');
  elsif not exists (select 1 from app.scorer_device x where x.user_id = q.user_id and x.season_id = season_id and x.status = 'approved') then
    r := jsonb_build_object('ok', false, 'code', 'device_not_approved', 'message', 'That phone is not an approved Scorer for this Season.');
  else
    update app.takeover_request x set status = 'approved', version = x.version + 1 where x.id = q.id;
    perform app.move_scoring(m.id, q.user_id);
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Scoring moved.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- An Organiser keeps the holder: the ask closes and nothing else changes.
create or replace function app.decline_take_over(command_id uuid, season_id uuid, request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'decline_take_over', jsonb_build_object('season_id', season_id));
  r jsonb;
  q app.takeover_request;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into q from app.takeover_request x where x.id = request_id and x.season_id = season_id for update;
  if q.id is null then
    r := jsonb_build_object('ok', false, 'code', 'request_missing', 'message', 'That request no longer exists.');
  elsif q.status in ('approved', 'declined') then
    r := jsonb_build_object('ok', false, 'code', 'request_answered', 'message', 'Another organiser already answered this request.');
  elsif q.status <> 'pending' or q.expires_at <= now() then
    if q.status = 'pending' then update app.takeover_request x set status = 'expired', version = x.version + 1 where x.id = q.id; end if;
    r := jsonb_build_object('ok', false, 'code', 'request_expired', 'message', 'That request has expired.');
  else
    update app.takeover_request x set status = 'declined', version = x.version + 1 where x.id = q.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Request declined.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- An Organiser takes scoring of a held Match directly (also true again for its own holder).
create or replace function app.take_over_scoring(command_id uuid, season_id uuid, match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'take_over_scoring', jsonb_build_object('season_id', season_id));
  r jsonb;
  m app.match;
  sides record;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into m from app.match x where x.id = match_id and x.season_id = season_id for update;
  select x.home_team_id as h, x.away_team_id as a into sides from app.match_resolve(season_id) x where x.match_id = match_id;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match no longer exists.');
  elsif m.status = 'finished' then
    r := jsonb_build_object('ok', false, 'code', 'match_finished', 'message', 'This Match is finished.');
  elsif sides.h is null or sides.a is null then
    r := jsonb_build_object('ok', false, 'code', 'sides_unknown', 'message', 'This Match has no Teams yet.');
  else
    if m.scoring_device is distinct from actor then perform app.move_scoring(m.id, actor); end if;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'You are scoring this match.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.holder_label(uuid, uuid), app.move_scoring(uuid, uuid), app.scoring_state(uuid), app.takeover_requests(uuid),
  app.hand_over_scoring(uuid, uuid, uuid, uuid, int), app.ask_take_over(uuid, uuid, uuid), app.approve_take_over(uuid, uuid, uuid),
  app.decline_take_over(uuid, uuid, uuid), app.take_over_scoring(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function app.scoring_state(uuid), app.takeover_requests(uuid),
  app.hand_over_scoring(uuid, uuid, uuid, uuid, int), app.ask_take_over(uuid, uuid, uuid), app.approve_take_over(uuid, uuid, uuid),
  app.decline_take_over(uuid, uuid, uuid), app.take_over_scoring(uuid, uuid, uuid) to authenticated;
