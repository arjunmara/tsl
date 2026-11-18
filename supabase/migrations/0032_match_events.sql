-- 0032_match_events.sql: cards, fouls, substitutions, timeouts and missed penalties for the scoring console (Story 4.5, FR-5, FR-24, AD-14).
-- app.match_event gains the kinds card, foul, sub, timeout and missed_penalty and the columns card ('yellow' or 'red'), player_on_id (a
-- substitution: player_id goes off, player_on_id comes on) and clock_ms (the Match clock's elapsed milliseconds in the period). team_id and
-- player_id are as for goals. These events never change the score: the 0031 trigger and app.match_score count only goals. record_event is one
-- command for the five kinds, only for the holder of scoring (not_scoring_device) and only while the Match is live (match_not_live); the
-- command id is the event id, and period, minute, clock_ms and at come from the phone. Server rules: foul needs the Season's foul_warning and
-- timeout needs timeouts_per_period above 0 (else event_not_allowed); a timeout is one (timeouts_per_period) per Team per regular period and
-- none in extra time (timeout_used); a limited Season stops substitutions at max_substitutions per Team per Match (subs_used); the Player going
-- off must be on the pitch (not_on_pitch) and the one coming on on the bench or, when rolling, subbed off earlier (not_on_bench). On the pitch
-- = the confirmed starters with each undeleted sub applied in order (app.on_pitch). edit_event and delete_event now also take these kinds
-- (a sub change that would leave a later sub without its Player on the pitch is refused: not_on_pitch; edit: the Player and the minute; a foul or timeout takes the minute only); add_assist takes goals only. console_match gains the Season's
-- foul_warning, timeouts_per_period, substitutions, max_substitutions and power_play_minutes in rules, and card, player_on_id and clock_ms on
-- events. The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.match_event
  add column if not exists card text check (card in ('yellow', 'red')),
  add column if not exists player_on_id uuid references app.player (id),
  add column if not exists clock_ms int check (clock_ms >= 0);
alter table app.match_event drop constraint if exists match_event_kind_check;
alter table app.match_event add constraint match_event_kind_check
  check (kind in ('period_start', 'period_end', 'match_end', 'clock_set', 'goal', 'card', 'foul', 'sub', 'timeout', 'missed_penalty'));

insert into app.season_action (action, status) values ('record_event', 'started') on conflict do nothing;

-- authorize: as in 0031, plus record_event for an approved Scorer phone.
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
      'record_goal', 'add_assist', 'edit_event', 'delete_event', 'record_event') then
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

-- Reads: console_match as in 0031, plus the Season's settings and the new event fields.
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
      'extra_time_periods', case when coalesce(sn.extra_time, false) and m.stage = 'knockout' then coalesce(sn.extra_time_periods, 2) else 0 end,
      'foul_warning', sn.foul_warning, 'timeouts_per_period', sn.timeouts_per_period, 'substitutions', coalesce(sn.substitutions, 'rolling'),
      'max_substitutions', sn.max_substitutions, 'power_play_minutes', sn.power_play_minutes),
    'clock', coalesce(m.clock, '{"running": false, "anchor_at": null, "elapsed_ms": 0, "period": 0, "interval": false}'),
    'score', (select jsonb_build_object('home', case when swap then s.ag else s.hg end, 'away', case when swap then s.hg else s.ag end) from app.match_score(m.id) s),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'period', e.period, 'minute', e.minute,
        'entered_at', e.entered_at, 'home', case when swap then e.score_away else e.score_home end, 'away', case when swap then e.score_home else e.score_away end,
        'team_id', e.team_id, 'player_id', e.player_id, 'assist_id', e.assist_id, 'own_goal', e.own_goal, 'card', e.card, 'player_on_id', e.player_on_id, 'clock_ms', e.clock_ms, 'version', e.version)
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

-- goal_step as in 0031, but edit and delete take the new kinds too (assist: goals only).
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
    select * into e from app.match_event x where x.id = p_event_id and x.season_id = p_season_id
      and x.kind in ('goal', 'card', 'foul', 'sub', 'timeout', 'missed_penalty') and x.deleted_at is null;
    if e.id is null then
      return jsonb_build_object('ok', false, 'code', 'event_missing', 'message', 'That event no longer exists.');
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
      return jsonb_build_object('ok', false, 'code', 'event_missing', 'message', 'That event no longer exists.');
    elsif e.version is distinct from p_expected then
      return app.conflict(m.tournament_id, 'match_event', e.id, e.version,
        jsonb_build_object('player_id', e.player_id, 'assist_id', e.assist_id, 'minute', e.minute, 'own_goal', e.own_goal,
          'card', e.card, 'player_on_id', e.player_on_id));
    end if;
    if p_op = 'assist' and e.kind <> 'goal' then
      return jsonb_build_object('ok', false, 'code', 'event_not_allowed', 'message', 'Only a goal takes an assist.');
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
      or (p_op = 'assist' and (e.own_goal or p_player = e.player_id)) or (p_op = 'edit' and p_player = e.player_on_id)) then
    return jsonb_build_object('ok', false, 'code', 'player_invalid', 'message', 'That Player is not in this Team''s Squad.');
  end if;
  if p_op = 'edit' and p_player is null and e.kind in ('card', 'sub', 'missed_penalty') then
    return jsonb_build_object('ok', false, 'code', 'player_invalid', 'message', 'That Player is not in this Team''s Squad.');
  end if;
  if p_op = 'edit' and p_minute is not null and (p_minute < 0 or p_minute > 400) then
    return jsonb_build_object('ok', false, 'code', 'goal_invalid', 'message', 'That goal has no valid time.');
  end if;

  if p_op in ('edit', 'delete') and e.kind = 'sub' and not app.sub_chain_ok(e.match_id, e.team_id, e.id, p_op, p_player) then
    return jsonb_build_object('ok', false, 'code', 'not_on_pitch', 'message', 'That change would leave a later substitution without its Player on the pitch.');
  end if;

  if p_op = 'record' then
    insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at, team_id, player_id, own_goal)
    values (p_command_id, m.tournament_id, m.season_id, m.id, 'goal', p_period, p_minute, least(coalesce(p_at, now()), now()), team, p_player,
      coalesce(p_own, false));
  elsif p_op = 'assist' then
    update app.match_event x set assist_id = p_player, version = x.version + 1 where x.id = e.id;
  elsif p_op = 'edit' then
    update app.match_event x set player_id = case when x.kind in ('foul', 'timeout') then x.player_id else p_player end,
      own_goal = coalesce(p_own, false) and x.kind = 'goal', minute = coalesce(p_minute, x.minute),
      assist_id = case when coalesce(p_own, false) or p_player = x.assist_id then null else x.assist_id end, version = x.version + 1
    where x.id = e.id;
  else
    update app.match_event x set deleted_at = now(), version = x.version + 1 where x.id = e.id;
  end if;
  -- A change to a goal answers the goal's new version (the outbox keeps it as the base of the next edit).
  return jsonb_build_object('ok', true, 'code', null, 'message', case when p_op <> 'record' and e.kind <> 'goal' then 'Event saved.' else 'Goal saved.' end) || case when p_op = 'record' then '{}'::jsonb else jsonb_build_object('version', e.version + 1) end;
end $$;


-- The Players of a Team on the pitch now: the confirmed starters with each undeleted sub applied in order.
create or replace function app.on_pitch(p_match_id uuid, p_team_id uuid) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  cur uuid[];
  e record;
begin
  select l.starters into cur from app.match_lineup l where l.match_id = p_match_id and l.team_id = p_team_id;
  for e in select x.player_id, x.player_on_id from app.match_event x
    where x.match_id = p_match_id and x.team_id = p_team_id and x.kind = 'sub' and x.deleted_at is null order by x.entered_at, x.created_at loop
    if e.player_id = any (cur) and e.player_on_id <> all (cur) then
      cur := array_remove(cur, e.player_id) || e.player_on_id;
    end if;
  end loop;
  -- A red-carded Player has left the pitch for good.
  return coalesce(array(select u from unnest(cur) u where not exists (select 1 from app.match_event x where x.match_id = p_match_id and x.team_id = p_team_id
    and x.kind = 'card' and x.card = 'red' and x.deleted_at is null and x.player_id = u)), '{}');
end $$;

-- True when every undeleted sub of the Team still works after p_op ('delete', or 'edit' with p_player as the new Player going off) changes p_event.
create or replace function app.sub_chain_ok(p_match_id uuid, p_team_id uuid, p_event uuid, p_op text, p_player uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  cur uuid[];
  e record;
  off uuid;
begin
  select l.starters into cur from app.match_lineup l where l.match_id = p_match_id and l.team_id = p_team_id;
  for e in select x.id, x.player_id, x.player_on_id from app.match_event x
    where x.match_id = p_match_id and x.team_id = p_team_id and x.kind = 'sub' and x.deleted_at is null order by x.entered_at, x.created_at loop
    if e.id = p_event and p_op = 'delete' then continue; end if;
    off := case when e.id = p_event then p_player else e.player_id end;
    if off is null or off <> all (coalesce(cur, '{}')) or e.player_on_id = any (cur) then return false; end if;
    cur := array_remove(cur, off) || e.player_on_id;
  end loop;
  return true;
end $$;

-- Records one card, foul, sub, timeout or missed penalty after the caller's checks. p_player: the Player carded, who missed, or going off;
-- p_on: the Player coming on. Answers the command's envelope; nothing changes unless ok.
create or replace function app.event_step(p_actor uuid, p_command_id uuid, p_season_id uuid, p_match_id uuid, p_kind text, p_team uuid, p_player uuid,
  p_on uuid, p_card text, p_period int, p_minute int, p_clock_ms int, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m app.match;
  sn app.season;
  r record;
  code text;
  n int;
  pitch uuid[];
  lu app.match_lineup;
begin
  select * into m from app.match x where x.id = p_match_id and x.season_id = p_season_id for update;
  if m.id is null then
    return jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match no longer exists.');
  elsif m.scoring_device is distinct from p_actor then
    return jsonb_build_object('ok', false, 'code', 'not_scoring_device', 'message', 'Another phone is scoring this match.');
  elsif m.status <> 'live' then
    return jsonb_build_object('ok', false, 'code', 'match_not_live', 'message', 'This Match is not live.');
  end if;
  select * into sn from app.season x where x.id = m.season_id;
  select x.home_team_id as h, x.away_team_id as a into r from app.match_resolve(m.season_id) x where x.match_id = m.id;
  if p_team is null or p_team not in (r.h, r.a) then
    return jsonb_build_object('ok', false, 'code', 'team_invalid', 'message', 'That Team is not playing this Match.');
  elsif coalesce(p_kind, '') <> all (array['card', 'foul', 'sub', 'timeout', 'missed_penalty'])
      or (p_kind = 'card' and coalesce(p_card, '') <> all (array['yellow', 'red']))
      or p_period is null or p_period < 1 or p_period > coalesce((m.clock ->> 'period')::int, 0) or p_minute is null or p_minute < 0 or p_minute > 400
      or p_clock_ms is null or p_clock_ms < 0 or p_clock_ms > 21600000 then
    return jsonb_build_object('ok', false, 'code', 'event_invalid', 'message', 'That event has no valid time.');
  elsif (p_kind = 'foul' and sn.foul_warning is null) or (p_kind = 'timeout' and coalesce(sn.timeouts_per_period, 0) = 0) then
    return jsonb_build_object('ok', false, 'code', 'event_not_allowed', 'message', 'This Format does not record that.');
  end if;
  if p_kind in ('foul', 'timeout') then
    p_player := null;
    p_on := null;
  elsif p_player is null or (p_kind = 'sub' and p_on is null) or (p_kind <> 'sub' and p_on is not null)
      or not exists (select 1 from app.squad_entry s where s.team_id = p_team and s.player_id = p_player)
      or (p_on is not null and not exists (select 1 from app.squad_entry s where s.team_id = p_team and s.player_id = p_on)) then
    return jsonb_build_object('ok', false, 'code', 'player_invalid', 'message', 'That Player is not in this Team''s Squad.');
  end if;
  select t.code into code from app.team t where t.id = p_team;
  if p_kind = 'timeout' then
    select count(*) into n from app.match_event x
    where x.match_id = m.id and x.team_id = p_team and x.kind = 'timeout' and x.deleted_at is null and x.period = p_period;
    if p_period > coalesce(sn.periods, 2) then
      return jsonb_build_object('ok', false, 'code', 'timeout_used', 'message', 'No timeouts in extra time.');
    elsif n >= sn.timeouts_per_period then
      return jsonb_build_object('ok', false, 'code', 'timeout_used', 'message',
        code || ' has used ' || case when sn.timeouts_per_period = 1 then 'its timeout' else 'all ' || n || ' timeouts' end
        || ' this ' || case when coalesce(sn.periods, 2) = 2 then 'half' else 'period' end || '.');
    end if;
  elsif p_kind = 'sub' then
    select count(*) into n from app.match_event x where x.match_id = m.id and x.team_id = p_team and x.kind = 'sub' and x.deleted_at is null;
    if sn.substitutions = 'limited' and n >= sn.max_substitutions then
      return jsonb_build_object('ok', false, 'code', 'subs_used', 'message', code || ' has used all ' || sn.max_substitutions || ' substitutions.');
    end if;
    pitch := app.on_pitch(m.id, p_team);
    select * into lu from app.match_lineup l where l.match_id = m.id and l.team_id = p_team;
    if p_player <> all (pitch) then
      return jsonb_build_object('ok', false, 'code', 'not_on_pitch', 'message', 'That Player is not on the pitch.');
    elsif p_on = any (pitch) or exists (select 1 from app.match_event x where x.match_id = m.id and x.team_id = p_team and x.kind = 'card'
          and x.card = 'red' and x.deleted_at is null and x.player_id = p_on) or p_on <> all (coalesce(lu.starters, '{}') || coalesce(lu.bench, '{}'))
        or (sn.substitutions = 'limited' and exists (select 1 from app.match_event x where x.match_id = m.id and x.team_id = p_team
          and x.kind = 'sub' and x.deleted_at is null and x.player_id = p_on)) then
      return jsonb_build_object('ok', false, 'code', 'not_on_bench', 'message', 'That Player is not on the bench.');
    end if;
  end if;
  insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at, team_id, player_id, player_on_id, card, clock_ms)
  values (p_command_id, m.tournament_id, m.season_id, m.id, p_kind, p_period, p_minute, least(coalesce(p_at, now()), now()), p_team, p_player, p_on,
    case when p_kind = 'card' then p_card end, p_clock_ms);
  return jsonb_build_object('ok', true, 'code', null, 'message', 'Event saved.');
end $$;

-- record_event: a new card, foul, sub, timeout or missed penalty row for a Team.
create or replace function app.record_event(command_id uuid, season_id uuid, match_id uuid, kind text, team_id uuid, player_id uuid, player_on_id uuid,
  card text, period int, minute int, clock_ms int, at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'record_event', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  r := app.event_step(actor, command_id, season_id, match_id, kind, team_id, player_id, player_on_id, card, period, minute, clock_ms, at);
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.on_pitch(uuid, uuid), app.sub_chain_ok(uuid, uuid, uuid, text, uuid), app.event_step(uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, int, int, int, timestamptz),
  app.record_event(uuid, uuid, uuid, text, uuid, uuid, uuid, text, int, int, int, timestamptz), app.console_match(uuid),
  app.goal_step(uuid, text, uuid, uuid, uuid, uuid, int, uuid, uuid, boolean, int, int, timestamptz) from public, anon, authenticated;
grant execute on function app.console_match(uuid), app.record_event(uuid, uuid, uuid, text, uuid, uuid, uuid, text, int, int, int, timestamptz) to authenticated;
