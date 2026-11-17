-- 0030_match_clock.sql: One Match clock and periods for the scoring console (Story 4.3, FR-5, FR-23, AD-14). app.match.clock jsonb
-- {running, anchor_at, elapsed_ms, period, interval}: the clock reads elapsed_ms plus, while running, the time since anchor_at (every
-- phone computes it from the server's time); period 0 = not started, interval true = between periods. app.match_event is the
-- append-only list of what happened in a Match (a client id, kind, period, minute, entered_at, the score then, version); this story
-- writes only the kinds period_start, period_end, match_end and clock_set (Story 4.4 adds goals). app.match_score(match) is the score
-- from those events (0-0 until 4.4). Commands, each only for the holder of scoring (an approved Scorer phone or an Organiser), each
-- with the Match's expected version and the time the change was made (at, clamped to between the last change and now()):
-- start_clock (first start: line-ups confirmed, Match goes live, period 1; later: resume), pause_clock, next_period (ends a regular
-- period into an interval, starts the next period, or starts extra time), set_clock (a logged correction) and end_match (finished,
-- with the score from match_score; the score is never typed). console_match gains version, periods, clock, score and events.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.match add column if not exists clock jsonb;

create table if not exists app.match_event (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  season_id uuid not null references app.season (id),
  match_id uuid not null references app.match (id) on delete cascade,
  kind text not null check (kind in ('period_start', 'period_end', 'match_end', 'clock_set')),
  period int not null check (period >= 0),
  minute int not null check (minute >= 0),
  entered_at timestamptz not null,
  score_home int,
  score_away int,
  version int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists match_event_match_idx on app.match_event (match_id, entered_at desc);

create or replace trigger log_change after insert or update or delete on app.match_event
  for each row execute function app.log_change('tournament_id', '{}');

-- Organisers read their Tournament's events; a Scorer phone reads through app.console_match only. Append-only: no client can write.
alter table app.match_event enable row level security;
drop policy if exists member_read on app.match_event;
create policy member_read on app.match_event for select to authenticated using (app.is_member(tournament_id));
revoke all on app.match_event from public, anon, authenticated;
grant select on app.match_event to authenticated;

insert into app.season_action (action, status) values ('start_clock', 'started'), ('pause_clock', 'started'), ('next_period', 'started'),
  ('set_clock', 'started'), ('end_match', 'started')
on conflict do nothing;

-- authorize: as in 0029, plus the five clock commands for an approved Scorer phone.
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
    if p_action in ('take_scoring', 'confirm_lineups', 'show_on_stream', 'start_clock', 'pause_clock', 'next_period', 'set_clock', 'end_match') then
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

-- The Match's score from its events: home and away, in the Match's own sides. 0-0 until Story 4.4 adds goals.
create or replace function app.match_score(p_match_id uuid) returns table (hg int, ag int)
language sql stable security definer set search_path = '' as $$ select 0, 0 $$;

-- Reads ------------------------------------------------------------------------------------------

-- True for an Organiser of the Match's Tournament or an approved (not revoked) Scorer phone of its Season, as the caller.
create or replace function app.console_reads(p_tournament_id uuid, p_season_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_member(p_tournament_id) or exists (select 1 from app.scorer_device d
    where d.user_id = auth.uid() and d.season_id = p_season_id and d.status = 'approved')
$$;

-- The console's whole read for one Match, or null for anyone else (a pending phone, another Season's phone, a Registration link).
-- teams: home first, then away, each with its Squad (id, name, shirt number: no personal fields) and its saved lineup or null.
-- holder: this caller holds scoring; held: someone does; on_air: this is the Tournament's On-air Match.
create or replace function app.console_match(p_match_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  m app.match;
  sn app.season;
  r record;
  res jsonb;
begin
  select * into m from app.match x where x.id = p_match_id;
  if not found or not app.console_reads(m.tournament_id, m.season_id) then return null; end if;
  select * into sn from app.season x where x.id = m.season_id;
  select x.home_team_id as h, x.away_team_id as a into r from app.match_resolve(m.season_id) x where x.match_id = m.id;
  select jsonb_build_object(
    'match', jsonb_build_object('id', m.id, 'season_id', m.season_id, 'tournament_id', m.tournament_id, 'stage', m.stage, 'round', m.round,
      'label', m.label, 'kick_off', m.kick_off, 'status', m.status, 'season_status', sn.status, 'version', m.version),
    'rules', jsonb_build_object('starters', coalesce(sn.starters, 5), 'max_bench', coalesce(sn.max_bench, 9),
      'periods', coalesce(sn.periods, 2),
      'extra_time_periods', case when coalesce(sn.extra_time, false) and m.stage = 'knockout' then coalesce(sn.extra_time_periods, 2) else 0 end),
    'clock', coalesce(m.clock, '{"running": false, "anchor_at": null, "elapsed_ms": 0, "period": 0, "interval": false}'),
    'score', (select jsonb_build_object('home', s.hg, 'away', s.ag) from app.match_score(m.id) s),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'period', e.period, 'minute', e.minute,
        'entered_at', e.entered_at, 'home', e.score_home, 'away', e.score_away) order by e.entered_at desc, e.created_at desc)
      from app.match_event e where e.match_id = m.id), '[]'),
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

-- The one step every clock command takes, after the caller's checks: p_op is start, pause, next, set or end; p_ms is set's new clock
-- time in milliseconds. at is clamped to between the last change (the clock's anchor_at) and now(). Answers the command's envelope;
-- the Match changes only on ok. clock_invalid: the clock can't do that now (already running, in an interval, no period left).
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
  elsif m.scoring_device is distinct from p_actor then
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

-- start_clock: the first start puts the Match live (period 1, line-ups confirmed); later it resumes the clock.
create or replace function app.start_clock(command_id uuid, season_id uuid, match_id uuid, expected_version int, at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'start_clock', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  r := app.clock_step(actor, 'start', command_id, season_id, match_id, expected_version, at, null);
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

create or replace function app.pause_clock(command_id uuid, season_id uuid, match_id uuid, expected_version int, at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'pause_clock', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  r := app.clock_step(actor, 'pause', command_id, season_id, match_id, expected_version, at, null);
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- next_period: in a regular period before the last: ends it into an interval (clock paused); in an interval: starts the next period
-- (clock running); in the last regular period of a knockout Match with extra time: starts extra time. Each appends a divider event.
create or replace function app.next_period(command_id uuid, season_id uuid, match_id uuid, expected_version int, at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'next_period', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  r := app.clock_step(actor, 'next', command_id, season_id, match_id, expected_version, at, null);
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- set_clock: the corrected clock time in milliseconds; the change is in the Activity log (the Match row and the clock_set event).
create or replace function app.set_clock(command_id uuid, season_id uuid, match_id uuid, expected_version int, elapsed_ms int, at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'set_clock', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  r := app.clock_step(actor, 'set', command_id, season_id, match_id, expected_version, at, elapsed_ms);
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- end_match: finished, with hg and ag from app.match_score (never typed). The clock stops.
create or replace function app.end_match(command_id uuid, season_id uuid, match_id uuid, expected_version int, at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'end_match', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  r := app.clock_step(actor, 'end', command_id, season_id, match_id, expected_version, at, null);
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.match_score(uuid), app.console_reads(uuid, uuid), app.console_match(uuid),
  app.clock_step(uuid, text, uuid, uuid, uuid, int, timestamptz, bigint),
  app.start_clock(uuid, uuid, uuid, int, timestamptz), app.pause_clock(uuid, uuid, uuid, int, timestamptz),
  app.next_period(uuid, uuid, uuid, int, timestamptz), app.set_clock(uuid, uuid, uuid, int, int, timestamptz),
  app.end_match(uuid, uuid, uuid, int, timestamptz) from public, anon, authenticated;
grant execute on function app.console_match(uuid), app.start_clock(uuid, uuid, uuid, int, timestamptz),
  app.pause_clock(uuid, uuid, uuid, int, timestamptz), app.next_period(uuid, uuid, uuid, int, timestamptz),
  app.set_clock(uuid, uuid, uuid, int, int, timestamptz), app.end_match(uuid, uuid, uuid, int, timestamptz) to authenticated;
