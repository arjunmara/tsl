-- 0034_holder_grace.sql: the holder grace (Story 4.7, FR-24, AD-6, AD-25). app.match gains scoring_prev_device and scoring_moved_at (nothing sets
-- them yet: Story 4.8, hand over and take over, will). A scoring command from a phone that is no longer the holder is still accepted when that
-- phone was the previous holder and the change was entered before scoring_moved_at + app.grace_window(); later ones answer not_scoring_device,
-- and the phone's outbox holds that Match's queue and hands the command back. app.holds_scoring is the one question; goal_step (0033),
-- event_step (0032), clock_step (0030) and end_match (0033) ask it instead of comparing scoring_device. The founder applies this in the
-- Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.match add column if not exists scoring_prev_device uuid, add column if not exists scoring_moved_at timestamptz;

-- True when p_actor holds scoring on the Match, or held it before scoring_moved_at and the change was entered within the grace window of the move.
-- Entered: the x-entered-at header (as app.authorize reads it), else p_at (the time of the tap), else now(); never later than now().
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
  return coalesce(m.scoring_prev_device = p_actor and least(coalesce(entered, p_at, now()), now()) < m.scoring_moved_at + app.grace_window(), false);
end $$;

create or replace function app.goal_step(p_actor uuid, p_op text, p_command_id uuid, p_season_id uuid, p_match_id uuid, p_event_id uuid,
  p_expected int, p_team uuid, p_player uuid, p_own boolean, p_period int, p_minute int, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m app.match;
  e app.match_event;
  r record;
  team uuid;
  org boolean;
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
  org := coalesce(m.status = 'finished' and app.is_member(m.tournament_id), false);
  if m.id is null then
    return jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match no longer exists.');
  elsif not org and not app.holds_scoring(m, p_actor, p_at) then
    return jsonb_build_object('ok', false, 'code', 'not_scoring_device', 'message', 'Another phone is scoring this match.');
  elsif not org and m.status <> 'live' then
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

  begin
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
  exception when raise_exception then
    if sqlerrm <> 'downstream_started' then raise; end if;
    return jsonb_build_object('ok', false, 'code', 'downstream_started', 'message', 'This can''t change: the next round has already started.');
  end;
  -- A change to a goal answers the goal's new version (the outbox keeps it as the base of the next edit).
  return jsonb_build_object('ok', true, 'code', null, 'message', case when p_op <> 'record' and e.kind <> 'goal' then 'Event saved.' else 'Goal saved.' end) || case when p_op = 'record' then '{}'::jsonb else jsonb_build_object('version', e.version + 1) end;
end $$;

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
  elsif not app.holds_scoring(m, p_actor, p_at) then
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

create or replace function app.clock_step(p_actor uuid, p_op text, p_command_id uuid, p_season_id uuid, p_match_id uuid, p_expected int,
  p_at timestamptz, p_ms bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m app.match;
  sn app.season;
  c jsonb;
  run boolean; brk boolean; per int; el bigint; stamp timestamptz;
  regular int; extra int;
  nc jsonb; kind text; ev_el bigint; ev_per int; st text;
  sc record;
begin
  select * into m from app.match x where x.id = p_match_id and x.season_id = p_season_id for update;
  select * into sn from app.season x where x.id = p_season_id;
  if m.id is null then
    return jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match no longer exists.');
  elsif not app.holds_scoring(m, p_actor, p_at) then
    return jsonb_build_object('ok', false, 'code', 'not_scoring_device', 'message', 'Another phone is scoring this match.');
  elsif m.status = 'finished' then
    return jsonb_build_object('ok', false, 'code', 'match_finished', 'message', 'This Match is finished.');
  end if;
  c := coalesce(m.clock, '{"running": false, "anchor_at": null, "elapsed_ms": 0, "period": 0, "interval": false}');
  if m.version is distinct from p_expected then
    return app.conflict(m.tournament_id, 'match', m.id, m.version, jsonb_build_object('clock', c));
  end if;
  run := (c ->> 'running')::boolean; brk := (c ->> 'interval')::boolean; per := (c ->> 'period')::int;
  stamp := greatest(coalesce((c ->> 'anchor_at')::timestamptz, now() - app.grace_window()), least(coalesce(p_at, now()), now()));
  el := (c ->> 'elapsed_ms')::bigint + case when run then round(extract(epoch from stamp - (c ->> 'anchor_at')::timestamptz) * 1000)::bigint else 0 end;
  regular := coalesce(sn.periods, 2);
  extra := case when coalesce(sn.extra_time, false) and m.stage = 'knockout' then coalesce(sn.extra_time_periods, 2) else 0 end;
  st := m.status; ev_el := el; ev_per := per;
  nc := jsonb_build_object('running', false, 'anchor_at', stamp, 'elapsed_ms', el, 'period', per, 'interval', brk);

  if p_op = 'start' then
    if run or brk then return jsonb_build_object('ok', false, 'code', 'clock_invalid', 'message', 'The clock can''t do that now.'); end if;
    if per = 0 then
      if (select count(*) from app.match_lineup l where l.match_id = m.id) < 2 then
        return jsonb_build_object('ok', false, 'code', 'lineups_missing', 'message', 'Confirm both line-ups before starting the clock.');
      end if;
      st := 'live'; per := 1; el := 0; ev_per := 1; ev_el := 0; kind := 'period_start';
    end if;
    nc := jsonb_build_object('running', true, 'anchor_at', stamp, 'elapsed_ms', el, 'period', per, 'interval', false);
  elsif p_op = 'pause' then
    if not run then return jsonb_build_object('ok', false, 'code', 'clock_invalid', 'message', 'The clock can''t do that now.'); end if;
  elsif p_op = 'next' then
    if per = 0 then
      return jsonb_build_object('ok', false, 'code', 'clock_invalid', 'message', 'The clock can''t do that now.');
    elsif brk and per < regular + extra then
      per := per + 1; el := 0; ev_per := per; ev_el := 0; kind := 'period_start';
      nc := jsonb_build_object('running', true, 'anchor_at', stamp, 'elapsed_ms', 0, 'period', per, 'interval', false);
    elsif not brk and (per < regular or (per > regular and per < regular + extra)) then
      kind := 'period_end';
      nc := jsonb_build_object('running', false, 'anchor_at', stamp, 'elapsed_ms', el, 'period', per, 'interval', true);
    elsif not brk and per = regular and extra > 0 then
      per := per + 1; el := 0; ev_per := per; ev_el := 0; kind := 'period_start';
      nc := jsonb_build_object('running', true, 'anchor_at', stamp, 'elapsed_ms', 0, 'period', per, 'interval', false);
    else
      return jsonb_build_object('ok', false, 'code', 'clock_invalid', 'message', 'The clock can''t do that now.');
    end if;
  elsif p_op = 'set' then
    if per = 0 or p_ms is null or p_ms < 0 or p_ms > 21600000 then
      return jsonb_build_object('ok', false, 'code', 'clock_invalid', 'message', 'The clock can''t do that now.');
    end if;
    ev_el := p_ms; kind := 'clock_set';
    nc := jsonb_build_object('running', run, 'anchor_at', stamp, 'elapsed_ms', p_ms, 'period', per, 'interval', brk);
  else
    if per = 0 then return jsonb_build_object('ok', false, 'code', 'clock_invalid', 'message', 'The clock can''t do that now.'); end if;
    st := 'finished'; kind := 'match_end';
  end if;
  -- Pause keeps the elapsed time at the moment of the change; so does ending the match.
  if p_op in ('pause', 'end') then
    nc := jsonb_build_object('running', false, 'anchor_at', stamp, 'elapsed_ms', el, 'period', per, 'interval', brk);
  end if;

  select * into sc from app.match_score(m.id);
  update app.match x set clock = nc, status = st, version = x.version + 1,
    hg = case when p_op = 'end' then sc.hg else x.hg end, ag = case when p_op = 'end' then sc.ag else x.ag end
  where x.id = m.id;
  if kind is not null then
    insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at, score_home, score_away)
    values (p_command_id, m.tournament_id, m.season_id, m.id, kind, ev_per, (ev_el / 60000)::int, stamp, sc.hg, sc.ag);
  end if;
  return jsonb_build_object('ok', true, 'code', null, 'message', 'Clock updated.', 'version', m.version + 1);
end $$;

create or replace function app.end_match(command_id uuid, season_id uuid, match_id uuid, expected_version int, at timestamptz default null,
  home_pens int default null, away_pens int default null, mom_player_id uuid default null, fair_player_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'end_match', jsonb_build_object('season_id', season_id));
  r jsonb;
  m app.match;
  sc record;
  swap boolean;
  hp int;
  ap int;
  sn app.season;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  select * into m from app.match x where x.id = match_id and x.season_id = season_id for update;
  -- Check the shootout and the Awards only for the holder of a live Match at its version; clock_step answers the rest.
  if m.id is not null and app.holds_scoring(m, actor, at) and m.status = 'live' and m.version = expected_version then
    select * into sc from app.match_score(m.id);
    swap := exists (select 1 from app.match_lineup l join app.match_resolve(m.season_id) q on q.match_id = m.id
      where l.match_id = m.id and l.side = 'home' and l.team_id = q.away_team_id);
    hp := case when swap then away_pens else home_pens end;
    ap := case when swap then home_pens else away_pens end;
    select * into sn from app.season x where x.id = m.season_id;
    if m.stage = 'knockout' and sc.hg = sc.ag and coalesce(sn.extra_time, false) and coalesce(sn.extra_time_periods, 2) > 0
        and coalesce((m.clock ->> 'period')::int, 0) <= coalesce(sn.periods, 2) then
      r := jsonb_build_object('ok', false, 'code', 'extra_time_needed', 'message', 'Play extra time first.');
    else
      r := app.result_check(m.stage, sc.hg, sc.ag, hp, ap);
    end if;
    if r is null and exists (select 1 from unnest(array[mom_player_id, fair_player_id]) p where p is not null and not exists (
        select 1 from app.match_lineup l where l.match_id = m.id and p = any (coalesce(l.starters, '{}') || coalesce(l.bench, '{}')))) then
      r := jsonb_build_object('ok', false, 'code', 'player_invalid', 'message', 'That Player is not in either line-up.');
    end if;
  end if;
  if r is null then
    begin
      r := app.clock_step(actor, 'end', command_id, season_id, match_id, expected_version, at, null);
      if (r ->> 'ok')::boolean then
        update app.match x set home_pens = hp, away_pens = ap, mom_player_id = mom_player_id, fair_player_id = fair_player_id where x.id = m.id;
      end if;
    exception when raise_exception then
      if sqlerrm <> 'downstream_started' then raise; end if;
      r := jsonb_build_object('ok', false, 'code', 'downstream_started', 'message', 'This can''t change: the next round has already started.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.holds_scoring(app.match, uuid, timestamptz) from public, anon, authenticated;
