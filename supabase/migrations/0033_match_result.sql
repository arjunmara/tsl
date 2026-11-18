-- 0033_match_result.sql: end the match with Awards and a shootout, typed results and corrections to a finished Match (Story 4.6, FR-24, FR-25,
-- AD-7, AD-22). app.match gains mom_player_id and fair_player_id (the Man of the Match and Fair Player Awards; home_pens and away_pens exist
-- from 0023). end_match now also takes home_pens, away_pens, mom_player_id and fair_player_id and finishes in one step: pens only for a level
-- knockout Match (else event_invalid; none for a level knockout Match: shootout_needed; equal: shootout_tied), Awards only from the two line-ups
-- (player_invalid); the shootout adds no goals. console_match gains home_pens and away_pens (in the line-up's home and away order),
-- mom_player_id and fair_player_id on match. New Organiser-only commands: set_awards (a finished Match; match_not_finished) and type_result
-- (a scheduled Match with both sides known, or a finished one: it adds unknown-scorer goals or soft-deletes unknown-scorer goals, newest first,
-- until each Team's undeleted goals equal the typed number, refusing with goals_named when named goals exceed it; then it finishes the Match
-- with the same pens rule; a live Match: match_live; the score is still derived from goals, never typed into hg or ag). An Organiser may also
-- record, edit and delete goals and other events of a finished Match (a Scorer phone gets match_not_live). A change to a finished Match that
-- would change a frozen knockout slot answers downstream_started and changes nothing. The founder applies this in the Supabase SQL Editor as
-- `postgres`: test first, then live. Safe to run twice.

alter table app.match add column if not exists mom_player_id uuid references app.player (id),
  add column if not exists fair_player_id uuid references app.player (id);

insert into app.season_action (action, status) values ('set_awards', 'started'), ('type_result', 'started') on conflict do nothing;

-- The answer when a result's shootout is wrong, or null when it is fine: pens only for a level knockout Match, both or neither, and a winner.
create or replace function app.result_check(p_stage text, p_hg int, p_ag int, p_hp int, p_ap int) returns jsonb
language sql immutable security definer set search_path = '' as $$
  select case
    when (p_hp is null) <> (p_ap is null) or least(p_hp, p_ap) < 0 or (p_hp is not null and not (p_stage = 'knockout' and p_hg = p_ag))
      then jsonb_build_object('ok', false, 'code', 'event_invalid', 'message', 'A shootout only applies to a level knockout Match.')
    when p_stage = 'knockout' and p_hg = p_ag and p_hp is null
      then jsonb_build_object('ok', false, 'code', 'shootout_needed', 'message', 'Enter the shootout result.')
    when p_hp = p_ap then jsonb_build_object('ok', false, 'code', 'shootout_tied', 'message', 'A shootout needs a winner.')
  end
$$;


-- goal_step as in 0032, but an Organiser may also record, edit and delete on a finished Match (a Scorer phone may not: match_not_live), and a
-- change that would change a frozen knockout slot answers downstream_started and changes nothing.
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
  elsif not org and m.scoring_device is distinct from p_actor then
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

-- Reads: console_match as in 0032, plus the shootout (in the line-up's home and away order) and the Awards on match.
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
      'label', m.label, 'kick_off', m.kick_off, 'status', m.status, 'season_status', sn.status, 'version', m.version,
      'home_team_id', r.h, 'away_team_id', r.a,
      'home_pens', case when swap then m.away_pens else m.home_pens end, 'away_pens', case when swap then m.home_pens else m.away_pens end,
      'mom_player_id', m.mom_player_id, 'fair_player_id', m.fair_player_id),
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

-- Commands ---------------------------------------------------------------------------------------

-- end_match: finished, with hg and ag from app.match_score (never typed), the shootout and the Awards in the same step. A change that would
-- change a frozen knockout slot answers downstream_started and changes nothing. The pens are in the line-up's home and away order.
drop function if exists app.end_match(uuid, uuid, uuid, int, timestamptz);
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
  if m.id is not null and m.scoring_device is not distinct from actor and m.status = 'live' and m.version = expected_version then
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

-- set_awards: the Man of the Match and Fair Player of a finished Match (a null clears one), from the two line-ups.
create or replace function app.set_awards(command_id uuid, season_id uuid, match_id uuid, expected_version int, mom_player_id uuid, fair_player_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'set_awards', jsonb_build_object('season_id', season_id));
  r jsonb;
  m app.match;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  select * into m from app.match x where x.id = match_id and x.season_id = season_id for update;
  if m.id is null then
    r := jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match no longer exists.');
  elsif m.status <> 'finished' then
    r := jsonb_build_object('ok', false, 'code', 'match_not_finished', 'message', 'This Match is not finished.');
  elsif m.version is distinct from expected_version then
    r := app.conflict(m.tournament_id, 'match', m.id, m.version, jsonb_build_object('mom_player_id', m.mom_player_id, 'fair_player_id', m.fair_player_id));
  elsif exists (select 1 from unnest(array[mom_player_id, fair_player_id]) p where p is not null and not exists (
      select 1 from app.match_lineup l where l.match_id = m.id and p = any (coalesce(l.starters, '{}') || coalesce(l.bench, '{}')))) then
    r := jsonb_build_object('ok', false, 'code', 'player_invalid', 'message', 'That Player is not in either line-up.');
  else
    begin
      update app.match x set mom_player_id = mom_player_id, fair_player_id = fair_player_id, version = x.version + 1 where x.id = m.id;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Awards saved.', 'version', m.version + 1);
    exception when raise_exception then
      if sqlerrm <> 'downstream_started' then raise; end if;
      r := jsonb_build_object('ok', false, 'code', 'downstream_started', 'message', 'This can''t change: the next round has already started.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- type_result: a paper-scored Match. Makes each Team's undeleted goals equal the typed number (unknown-scorer goals are added at minute 0, or the
-- newest unknown-scorer goals are soft-deleted; named goals stay and may not exceed it), then finishes the Match with hg and ag from the goals.
-- home and away are in the Match's own sides (home_team_id first), as are the pens.
create or replace function app.type_result(command_id uuid, season_id uuid, match_id uuid, expected_version int, home int, away int,
  home_pens int default null, away_pens int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'type_result', jsonb_build_object('season_id', season_id));
  r jsonb;
  m app.match;
  rs record;
  sc record;
  t uuid;
  want int;
  have int;
  named int[];
  code text;
  n int;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  select * into m from app.match x where x.id = match_id and x.season_id = season_id for update;
  select x.home_team_id as h, x.away_team_id as a into rs from app.match_resolve(season_id) x where x.match_id = m.id;
  if m.id is null then
    r := jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match no longer exists.');
  elsif m.status = 'live' then
    r := jsonb_build_object('ok', false, 'code', 'match_live', 'message', 'This Match is live. Finish it from the console.');
  elsif m.version is distinct from expected_version then
    r := app.conflict(m.tournament_id, 'match', m.id, m.version, jsonb_build_object('hg', m.hg, 'ag', m.ag, 'home_pens', m.home_pens, 'away_pens', m.away_pens));
  elsif rs.h is null or rs.a is null then
    r := jsonb_build_object('ok', false, 'code', 'team_invalid', 'message', 'Both Teams must be known first.');
  elsif home is null or away is null or least(home, away) < 0 or greatest(home, away) > 99 then
    r := jsonb_build_object('ok', false, 'code', 'event_invalid', 'message', 'Enter a score from 0 to 99.');
  else
    r := app.result_check(m.stage, home, away, home_pens, away_pens);
  end if;
  if r is null then
    -- Named goals (a Player or an own goal) stay, so they may not exceed the typed number.
    select array[count(*) filter (where e.team_id = rs.h), count(*) filter (where e.team_id = rs.a)] into named from app.match_event e
    where e.match_id = m.id and e.kind = 'goal' and e.deleted_at is null and (e.player_id is not null or e.own_goal);
    if named[1] > home or named[2] > away then
      n := case when named[1] > home then named[1] else named[2] end;
      select tm.code into code from app.team tm where tm.id = case when named[1] > home then rs.h else rs.a end;
      r := jsonb_build_object('ok', false, 'code', 'goals_named', 'message', code || ' already has ' || n || ' named goal' || case when n = 1 then '' else 's' end || '.');
    end if;
  end if;
  if r is null then
    begin
      -- The freeze check runs once, on the final state, not on each intermediate goal.
      set constraints app.match_freeze deferred;
      for i in 1..2 loop
        t := case i when 1 then rs.h else rs.a end;
        want := case i when 1 then home else away end;
        select count(*) into have from app.match_event e where e.match_id = m.id and e.kind = 'goal' and e.deleted_at is null and e.team_id = t;
        if have < want then
          insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at, team_id)
          select gen_random_uuid(), m.tournament_id, m.season_id, m.id, 'goal', 1, 0, now(), t from generate_series(1, want - have);
        elsif have > want then
          update app.match_event x set deleted_at = now(), version = x.version + 1 where x.id in (
            select e.id from app.match_event e where e.match_id = m.id and e.kind = 'goal' and e.deleted_at is null and e.team_id = t
              and e.player_id is null and not e.own_goal order by e.entered_at desc, e.created_at desc limit have - want);
        end if;
      end loop;
      select * into sc from app.match_score(m.id);
      update app.match x set status = 'finished', hg = sc.hg, ag = sc.ag, home_pens = home_pens, away_pens = away_pens,
        version = x.version + 1 where x.id = m.id;
      set constraints app.match_freeze immediate;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Result saved.', 'version', m.version + 1);
    exception when raise_exception then
      if sqlerrm <> 'downstream_started' then raise; end if;
      r := jsonb_build_object('ok', false, 'code', 'downstream_started', 'message', 'This can''t change: the next round has already started.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.result_check(text, int, int, int, int), app.goal_step(uuid, text, uuid, uuid, uuid, uuid, int, uuid, uuid, boolean, int, int, timestamptz),
  app.console_match(uuid), app.end_match(uuid, uuid, uuid, int, timestamptz, int, int, uuid, uuid),
  app.set_awards(uuid, uuid, uuid, int, uuid, uuid), app.type_result(uuid, uuid, uuid, int, int, int, int, int) from public, anon, authenticated;
grant execute on function app.console_match(uuid), app.end_match(uuid, uuid, uuid, int, timestamptz, int, int, uuid, uuid),
  app.set_awards(uuid, uuid, uuid, int, uuid, uuid), app.type_result(uuid, uuid, uuid, int, int, int, int, int) to authenticated;
