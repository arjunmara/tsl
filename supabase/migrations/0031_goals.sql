-- 0031_goals.sql: goals for the scoring console (Story 4.4, FR-24, AD-5, AD-7, AD-20). app.match_event gains the kind 'goal' and the columns
-- team_id (the Team the goal counts for; an own goal is recorded for the Team that gets it), player_id (null: own goal or unknown scorer),
-- assist_id, own_goal and deleted_at (a delete is soft, so the table stays append-only and the Activity log keeps the row). app.match.hg and
-- ag are derived: a trigger on app.match_event recomputes them from the undeleted goals of the Match, in the Match's own sides
-- (home_team_id first), and does not touch app.match.version, so a goal never makes the holder's next clock command a version_conflict.
-- app.match_score reads the same. No command writes a score. Commands, each only for the holder of scoring (not_scoring_device) and only
-- while the Match is live (match_not_live): record_goal (a new row; the command id is the event id; period, minute and at come from the
-- phone's clock), add_assist, edit_event (Player or minute) and delete_event, each with the event's expected version (+1 per change; a stale
-- one is a version_conflict the hand-back shows). console_match gains the goal fields on events (deleted ones are skipped), the score and the
-- dividers' scores in the line-up's home and away order, and period_minutes and extra_time_minutes in the rules.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.match_event
  add column if not exists team_id uuid references app.team (id),
  add column if not exists player_id uuid references app.player (id),
  add column if not exists assist_id uuid references app.player (id),
  add column if not exists own_goal boolean not null default false,
  add column if not exists deleted_at timestamptz;
alter table app.match_event drop constraint if exists match_event_kind_check;
alter table app.match_event add constraint match_event_kind_check
  check (kind in ('period_start', 'period_end', 'match_end', 'clock_set', 'goal'));

insert into app.season_action (action, status) values ('record_goal', 'started'), ('add_assist', 'started'), ('edit_event', 'started'),
  ('delete_event', 'started')
on conflict do nothing;

-- authorize: as in 0030, plus the four goal commands for an approved Scorer phone.
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
      'record_goal', 'add_assist', 'edit_event', 'delete_event') then
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

-- Score ------------------------------------------------------------------------------------------

-- The Match's score from its undeleted goals: home and away, in the Match's own sides (an own goal counts for the Team it is recorded for).
create or replace function app.match_score(p_match_id uuid) returns table (hg int, ag int)
language sql stable security definer set search_path = '' as $$
  select (count(*) filter (where e.team_id = r.home_team_id))::int, (count(*) filter (where e.team_id = r.away_team_id))::int
  from app.match m join app.match_resolve(m.season_id) r on r.match_id = m.id
  left join app.match_event e on e.match_id = m.id and e.kind = 'goal' and e.deleted_at is null
  where m.id = p_match_id
$$;

-- After a goal row is added or changed: hg and ag on the Match follow. app.match.version is not touched.
create or replace function app.match_goal_score() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'goal' then
    update app.match x set hg = s.hg, ag = s.ag from app.match_score(new.match_id) s
    where x.id = new.match_id and (x.hg, x.ag) is distinct from (s.hg, s.ag);
  end if;
  return null;
end $$;
create or replace trigger match_goal_score after insert or update on app.match_event
  for each row execute function app.match_goal_score();

-- Reads ------------------------------------------------------------------------------------------

-- True for an Organiser of the Match's Tournament or an approved (not revoked) Scorer phone of its Season, as the caller.
create or replace function app.console_reads(p_tournament_id uuid, p_season_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_member(p_tournament_id) or exists (select 1 from app.scorer_device d
    where d.user_id = auth.uid() and d.season_id = p_season_id and d.status = 'approved')
$$;

-- The console's whole read for one Match, or null for anyone else (a pending phone, another Season's phone, a Registration link).
-- teams: home first, then away, each with its Squad (id, name, shirt number: no personal fields) and its saved lineup or null.
-- score and the dividers' scores follow the line-up's home and away. holder: this caller holds scoring; held: someone does; on_air: this is the Tournament's On-air Match.
create or replace function app.console_match(p_match_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  m app.match;
  sn app.season;
  r record;
  res jsonb;
  swap boolean;
begin
  select * into m from app.match x where x.id = p_match_id;
  if not found or not app.console_reads(m.tournament_id, m.season_id) then return null; end if;
  select * into sn from app.season x where x.id = m.season_id;
  select x.home_team_id as h, x.away_team_id as a into r from app.match_resolve(m.season_id) x where x.match_id = m.id;
  -- The lineup may swap home and away: the console shows the score and the dividers in that order.
  swap := exists (select 1 from app.match_lineup l where l.match_id = m.id and l.side = 'home' and l.team_id = r.a);
  select jsonb_build_object(
    'match', jsonb_build_object('id', m.id, 'season_id', m.season_id, 'tournament_id', m.tournament_id, 'stage', m.stage, 'round', m.round,
      'label', m.label, 'kick_off', m.kick_off, 'status', m.status, 'season_status', sn.status, 'version', m.version),
    'rules', jsonb_build_object('starters', coalesce(sn.starters, 5), 'max_bench', coalesce(sn.max_bench, 9),
      'periods', coalesce(sn.periods, 2), 'period_minutes', coalesce(sn.period_minutes, 20), 'extra_time_minutes', coalesce(sn.extra_time_minutes, 5),
      'extra_time_periods', case when coalesce(sn.extra_time, false) and m.stage = 'knockout' then coalesce(sn.extra_time_periods, 2) else 0 end),
    'clock', coalesce(m.clock, '{"running": false, "anchor_at": null, "elapsed_ms": 0, "period": 0, "interval": false}'),
    'score', (select jsonb_build_object('home', case when swap then s.ag else s.hg end, 'away', case when swap then s.hg else s.ag end) from app.match_score(m.id) s),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'period', e.period, 'minute', e.minute,
        'entered_at', e.entered_at, 'home', case when swap then e.score_away else e.score_home end, 'away', case when swap then e.score_home else e.score_away end,
        'team_id', e.team_id, 'player_id', e.player_id, 'assist_id', e.assist_id, 'own_goal', e.own_goal, 'version', e.version)
        order by e.entered_at desc, e.created_at desc)
      from app.match_event e where e.match_id = m.id and e.deleted_at is null), '[]'),
    'holder', m.scoring_device is not distinct from auth.uid() and m.scoring_device is not null,
    'held', m.scoring_device is not null,
    'on_air', exists (select 1 from app.live_state l where l.tournament_id = m.tournament_id and l.on_air_match_id = m.id),
    'teams', coalesce((select jsonb_agg(jsonb_build_object(
        'team_id', t.id, 'name', t.name, 'code', t.code, 'registered_kit', t.kit_colour, 'side', x.side,
        'squad', coalesce((select jsonb_agg(jsonb_build_object('player_id', e.player_id, 'name', p.name, 'shirt', e.shirt_number)
            order by e.shirt_number) from app.squad_entry e join app.player p on p.id = e.player_id where e.team_id = t.id), '[]'),
        'lineup', (select jsonb_build_object('starters', to_jsonb(l.starters), 'bench', to_jsonb(l.bench), 'kit_colour', l.kit_colour,
            'version', l.version) from app.match_lineup l where l.match_id = m.id and l.team_id = t.id)
      ) order by x.side desc)
      from (select u.team_id, coalesce(l.side, case when u.n = 1 then 'home' else 'away' end) as side
            from (values (1, r.h), (2, r.a)) u (n, team_id) left join app.match_lineup l on l.match_id = m.id and l.team_id = u.team_id
            where u.team_id is not null) x join app.team t on t.id = x.team_id), '[]'))
  into res;
  return res;
end $$;

-- Commands ---------------------------------------------------------------------------------------

-- The one step every goal command takes, after the caller's checks: p_op is record, assist, edit or delete. For record, p_match_id and
-- p_team are the Match and the Team the goal counts for; p_player the scorer (null: unknown scorer); p_own an own goal (no scorer); p_period
-- and p_minute from the phone's clock; p_at the time of the tap. For the others p_event_id is the goal and p_expected its version; assist
-- takes the assisting Player in p_player; edit takes p_player and p_own (the scorer) and p_minute (null keeps it).
-- Answers the command's envelope; nothing changes unless ok.
create or replace function app.goal_step(p_actor uuid, p_op text, p_command_id uuid, p_season_id uuid, p_match_id uuid, p_event_id uuid,
  p_expected int, p_team uuid, p_player uuid, p_own boolean, p_period int, p_minute int, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m app.match;
  e app.match_event;
  r record;
  team uuid;
begin
  if p_op <> 'record' then
    select * into e from app.match_event x where x.id = p_event_id and x.season_id = p_season_id and x.kind = 'goal' and x.deleted_at is null;
    if e.id is null then
      return jsonb_build_object('ok', false, 'code', 'event_missing', 'message', 'That goal no longer exists.');
    end if;
    p_match_id := e.match_id;
  end if;
  select * into m from app.match x where x.id = p_match_id and x.season_id = p_season_id for update;
  if m.id is null then
    return jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match no longer exists.');
  elsif m.scoring_device is distinct from p_actor then
    return jsonb_build_object('ok', false, 'code', 'not_scoring_device', 'message', 'Another phone is scoring this match.');
  elsif m.status <> 'live' then
    return jsonb_build_object('ok', false, 'code', 'match_not_live', 'message', 'This Match is not live.');
  end if;
  if p_op <> 'record' then
    -- Read again under the Match's lock: another change may have come in between.
    select * into e from app.match_event x where x.id = p_event_id and x.deleted_at is null;
    if e.id is null then
      return jsonb_build_object('ok', false, 'code', 'event_missing', 'message', 'That goal no longer exists.');
    elsif e.version is distinct from p_expected then
      return app.conflict(m.tournament_id, 'match_event', e.id, e.version,
        jsonb_build_object('player_id', e.player_id, 'assist_id', e.assist_id, 'minute', e.minute, 'own_goal', e.own_goal));
    end if;
    team := e.team_id;
  else
    team := p_team;
    select x.home_team_id as h, x.away_team_id as a into r from app.match_resolve(m.season_id) x where x.match_id = m.id;
    if team is null or team not in (r.h, r.a) then
      return jsonb_build_object('ok', false, 'code', 'team_invalid', 'message', 'That Team is not playing this Match.');
    elsif p_period is null or p_period < 1 or p_period > 8 or p_minute is null or p_minute < 0 or p_minute > 400 then
      return jsonb_build_object('ok', false, 'code', 'goal_invalid', 'message', 'That goal has no valid time.');
    end if;
  end if;
  if p_op in ('record', 'edit', 'assist') and p_player is not null and (coalesce(p_own, false) and p_op <> 'assist'
      or not exists (select 1 from app.squad_entry s where s.team_id = team and s.player_id = p_player)
      or (p_op = 'assist' and (e.own_goal or p_player = e.player_id))) then
    return jsonb_build_object('ok', false, 'code', 'player_invalid', 'message', 'That Player is not in this Team''s Squad.');
  end if;
  if p_op = 'edit' and p_minute is not null and (p_minute < 0 or p_minute > 400) then
    return jsonb_build_object('ok', false, 'code', 'goal_invalid', 'message', 'That goal has no valid time.');
  end if;

  if p_op = 'record' then
    insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at, team_id, player_id, own_goal)
    values (p_command_id, m.tournament_id, m.season_id, m.id, 'goal', p_period, p_minute, least(coalesce(p_at, now()), now()), team, p_player,
      coalesce(p_own, false));
  elsif p_op = 'assist' then
    update app.match_event x set assist_id = p_player, version = x.version + 1 where x.id = e.id;
  elsif p_op = 'edit' then
    update app.match_event x set player_id = p_player, own_goal = coalesce(p_own, false), minute = coalesce(p_minute, x.minute),
      assist_id = case when coalesce(p_own, false) or p_player = x.assist_id then null else x.assist_id end, version = x.version + 1
    where x.id = e.id;
  else
    update app.match_event x set deleted_at = now(), version = x.version + 1 where x.id = e.id;
  end if;
  -- A change to a goal answers the goal's new version (the outbox keeps it as the base of the next edit).
  return jsonb_build_object('ok', true, 'code', null, 'message', 'Goal saved.') || case when p_op = 'record' then '{}'::jsonb else jsonb_build_object('version', e.version + 1) end;
end $$;

-- record_goal: a new goal row for the Team it counts for (the Team's id), with the scorer, or none, or an own goal.
create or replace function app.record_goal(command_id uuid, season_id uuid, match_id uuid, team_id uuid, player_id uuid, own_goal boolean,
  period int, minute int, at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'record_goal', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  r := app.goal_step(actor, 'record', command_id, season_id, match_id, null, null, team_id, player_id, own_goal, period, minute, at);
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- add_assist: sets (or, with a null assist_id, clears) the assist of a goal.
create or replace function app.add_assist(command_id uuid, season_id uuid, event_id uuid, expected_version int, assist_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'add_assist', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  r := app.goal_step(actor, 'assist', command_id, season_id, null, event_id, expected_version, null, assist_id, null, null, null, null);
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- edit_event: a goal's scorer (player_id, or own_goal with none) and minute (null keeps it).
create or replace function app.edit_event(command_id uuid, season_id uuid, event_id uuid, expected_version int, player_id uuid, own_goal boolean,
  minute int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_event', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  r := app.goal_step(actor, 'edit', command_id, season_id, null, event_id, expected_version, null, player_id, own_goal, null, minute, null);
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- delete_event: a soft delete (the row stays, deleted_at is set); the score follows.
create or replace function app.delete_event(command_id uuid, season_id uuid, event_id uuid, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'delete_event', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  r := app.goal_step(actor, 'delete', command_id, season_id, null, event_id, expected_version, null, null, null, null, null, null);
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.match_score(uuid), app.match_goal_score(), app.console_match(uuid),
  app.goal_step(uuid, text, uuid, uuid, uuid, uuid, int, uuid, uuid, boolean, int, int, timestamptz),
  app.record_goal(uuid, uuid, uuid, uuid, uuid, boolean, int, int, timestamptz), app.add_assist(uuid, uuid, uuid, int, uuid),
  app.edit_event(uuid, uuid, uuid, int, uuid, boolean, int), app.delete_event(uuid, uuid, uuid, int) from public, anon, authenticated;
grant execute on function app.console_match(uuid), app.record_goal(uuid, uuid, uuid, uuid, uuid, boolean, int, int, timestamptz),
  app.add_assist(uuid, uuid, uuid, int, uuid), app.edit_event(uuid, uuid, uuid, int, uuid, boolean, int),
  app.delete_event(uuid, uuid, uuid, int) to authenticated;
