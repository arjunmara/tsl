-- 0029_prematch.sql: pre-match for the scoring console (Story 4.2, FR-22, AD-14, AD-20). app.match_lineup (per Match and Team: starters,
-- bench, kit colour for the day, home or away), app.live_state (one row per Tournament: the On-air Match, scene override and Sponsor
-- pop-up) and app.match.scoring_device (the phone or Organiser that holds scoring). Commands: take_scoring (the caller becomes the
-- holder of a Match with none; a Match held by someone else answers scoring_elsewhere), confirm_lineups (the holder only, Season
-- started, Match not yet live: stores both lineups and which Team is home) and show_on_stream (the holder or an Organiser makes the
-- Match the Tournament's On-air Match). Reads: app.console_match(match) for an Organiser or an approved Scorer phone of the Season
-- (Match, both Teams, Squads without personal fields, lineups, holder, on-air flag) and app.scorer_matches(season) (the next
-- scheduled and the live Matches, for the Scorer phone). Nothing here writes a score or a Match status. The founder applies this in
-- the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.match add column if not exists scoring_device uuid references auth.users (id) on delete set null;

-- A Team's line-up for one Match. starters and bench are Player ids from the Team's Squad. version rises each time the holder
-- confirms again before kick-off. (match_id, side) is unique, checked at the end of the statement so a swap can exchange sides.
create table if not exists app.match_lineup (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references app.tournament (id),
  season_id uuid not null references app.season (id),
  match_id uuid not null references app.match (id) on delete cascade,
  team_id uuid not null references app.team (id),
  side text not null check (side in ('home', 'away')),
  starters uuid[] not null,
  bench uuid[] not null default '{}',
  kit_colour text not null check (kit_colour ~ '^#[0-9a-f]{6}$'),
  confirmed_at timestamptz not null default now(),
  version int not null default 1,
  constraint match_lineup_team_key unique (match_id, team_id),
  constraint match_lineup_side_key unique (match_id, side) deferrable initially deferred
);

-- One row per Tournament, made the first time a Match goes on the stream.
create table if not exists app.live_state (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null unique references app.tournament (id),
  on_air_match_id uuid references app.match (id) on delete set null,
  scene_override text,
  popup_sponsor_id uuid references app.sponsor (id) on delete set null,
  updated_at timestamptz not null default now(),
  version int not null default 1
);

-- No personal fields (Player ids only).
create or replace trigger log_change after insert or update or delete on app.match_lineup
  for each row execute function app.log_change('tournament_id', '{}');
create or replace trigger log_change after insert or update or delete on app.live_state
  for each row execute function app.log_change('tournament_id', '{}');

-- Organisers read their Tournament's rows; a Scorer phone reads through app.console_match and app.scorer_matches only.
alter table app.match_lineup enable row level security;
alter table app.live_state enable row level security;
drop policy if exists member_read on app.match_lineup;
create policy member_read on app.match_lineup for select to authenticated using (app.is_member(tournament_id));
drop policy if exists member_read on app.live_state;
create policy member_read on app.live_state for select to authenticated using (app.is_member(tournament_id));
revoke all on app.match_lineup, app.live_state from public, anon, authenticated;
grant select on app.match_lineup, app.live_state to authenticated;

insert into app.season_action values ('take_scoring', 'started'), ('confirm_lineups', 'started'), ('show_on_stream', 'started')
on conflict do nothing;

-- authorize: as in 0028, plus the three scoring commands: an anonymous user passes only as an approved Scorer phone of the Season
-- (a revoked one for changes entered before the revoke plus the grace window; x-entered-at as for the Registration deadline).
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
    if p_action in ('take_scoring', 'confirm_lineups', 'show_on_stream') then
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
      'label', m.label, 'kick_off', m.kick_off, 'status', m.status, 'season_status', sn.status),
    'rules', jsonb_build_object('starters', coalesce(sn.starters, 5), 'max_bench', coalesce(sn.max_bench, 9)),
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

-- The Matches a Scorer phone can score: every live Match and the next scheduled one (lowest order) of the Season, with the Teams'
-- codes; held: someone holds scoring; mine: this phone does. Empty for anyone but an approved phone of the Season.
create or replace function app.scorer_matches(p_season_id uuid)
returns table (match_id uuid, ord int, round text, label text, kick_off timestamptz, status text, home_code text, away_code text, held boolean, mine boolean)
language sql stable security definer set search_path = '' as $$
  select m.id, m.ord, m.round, m.label, m.kick_off, m.status, h.code, a.code, m.scoring_device is not null,
    m.scoring_device is not null and m.scoring_device = auth.uid()
  from app.match m
  join app.season sn on sn.id = m.season_id and sn.status = 'started'
  join app.match_resolve(p_season_id) r on r.match_id = m.id
  left join app.team h on h.id = r.home_team_id
  left join app.team a on a.id = r.away_team_id
  where m.season_id = p_season_id and app.console_reads(m.tournament_id, m.season_id) and m.status <> 'finished'
    and (m.status = 'live' or m.ord = (select min(x.ord) from app.match x join app.match_resolve(p_season_id) y on y.match_id = x.id
      where x.season_id = p_season_id and x.status = 'scheduled' and y.home_team_id is not null and y.away_team_id is not null))
  order by m.ord
$$;

-- Commands ---------------------------------------------------------------------------------------

-- The caller takes scoring of a Match nobody holds (also true again for its own holder). Held by another: scoring_elsewhere, and the
-- caller reads the console without changing anything. Hand-over and take-over are Story 4.8.
create or replace function app.take_scoring(command_id uuid, season_id uuid, match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'take_scoring', jsonb_build_object('season_id', season_id));
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
  elsif m.scoring_device is not null and m.scoring_device <> actor then
    r := jsonb_build_object('ok', false, 'code', 'scoring_elsewhere', 'message', 'Another phone is scoring this match.');
  else
    if m.scoring_device is null then
      update app.match x set scoring_device = actor where x.id = m.id;
    end if;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'You are scoring this match.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Stores both Teams' lineups and which one is home. home and away: {team_id, starters: [player ids], bench: [player ids], kit_colour}.
-- Only the holder, before kick-off; the Teams must be the Match's two Teams and every Player in their Squad. Confirming again
-- before kick-off replaces the lineups (version up by one). lineup_invalid answers in words.
create or replace function app.confirm_lineups(command_id uuid, season_id uuid, match_id uuid, home jsonb, away jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'confirm_lineups', jsonb_build_object('season_id', season_id));
  r jsonb;
  m app.match;
  sn app.season;
  sides record;
  j jsonb;
  tid uuid; st uuid[]; bn uuid[]; kit text; every uuid[];
  want int; most int;
  bad text;
  ids uuid[] := '{}';
  i int;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into m from app.match x where x.id = match_id and x.season_id = season_id for update;
  select * into sn from app.season x where x.id = season_id;
  select x.home_team_id as h, x.away_team_id as a into sides from app.match_resolve(season_id) x where x.match_id = match_id;
  want := coalesce(sn.starters, 5);
  most := coalesce(sn.max_bench, 9);
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match no longer exists.');
  elsif m.scoring_device is distinct from actor then
    r := jsonb_build_object('ok', false, 'code', 'not_scoring_device', 'message', 'Another phone is scoring this match.');
  elsif m.status <> 'scheduled' then
    r := jsonb_build_object('ok', false, 'code', 'match_started', 'message', 'The Match has kicked off, so the line-ups are fixed.');
  else
    begin
      for i in 1..2 loop
        j := case i when 1 then home else away end;
        tid := (j ->> 'team_id')::uuid;
        kit := j ->> 'kit_colour';
        st := array(select e::uuid from jsonb_array_elements_text(j -> 'starters') e);
        bn := array(select e::uuid from jsonb_array_elements_text(j -> 'bench') e);
        every := st || bn;
        if tid is null or kit is null or sides.h is null or sides.a is null or tid = any (ids) or tid <> all (array[sides.h, sides.a]) or kit !~ '^#[0-9a-f]{6}$' then
          bad := 'The line-ups must name this Match''s two Teams, each with a kit colour.';
        elsif cardinality(st) <> want then
          bad := format('Line-up needs %s %s. You''ve picked %s.', want, case when want = 1 then 'starter' else 'starters' end, cardinality(st));
        elsif cardinality(bn) > most then
          bad := format('Bench can hold up to %s. You''ve picked %s.', most, cardinality(bn));
        elsif (select count(distinct p) from unnest(every) p) <> cardinality(every)
          or (select count(*) from app.squad_entry e where e.team_id = tid and e.player_id = any (every)) <> cardinality(every) then
          bad := 'Pick each Player once, from the Team''s Squad.';
        end if;
        exit when bad is not null;
        ids := ids || tid;
      end loop;
    exception when others then
      bad := 'The line-ups are not valid.';
    end;
    if bad is not null then
      r := jsonb_build_object('ok', false, 'code', 'lineup_invalid', 'message', bad);
    else
      for i in 1..2 loop
        j := case i when 1 then home else away end;
        insert into app.match_lineup (tournament_id, season_id, match_id, team_id, side, starters, bench, kit_colour)
        values (m.tournament_id, season_id, match_id, (j ->> 'team_id')::uuid, case i when 1 then 'home' else 'away' end,
          array(select e::uuid from jsonb_array_elements_text(j -> 'starters') e),
          array(select e::uuid from jsonb_array_elements_text(j -> 'bench') e), j ->> 'kit_colour')
        on conflict on constraint match_lineup_team_key do update set side = excluded.side, starters = excluded.starters, bench = excluded.bench,
          kit_colour = excluded.kit_colour, confirmed_at = now(), version = app.match_lineup.version + 1;
      end loop;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Line-ups confirmed.');
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Makes the Match the Tournament's On-air Match, replacing any other. The holder or an Organiser of the Tournament.
create or replace function app.show_on_stream(command_id uuid, season_id uuid, match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'show_on_stream', jsonb_build_object('season_id', season_id));
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
  elsif m.scoring_device is distinct from actor and not app.is_member(m.tournament_id) then
    r := jsonb_build_object('ok', false, 'code', 'not_scoring_device', 'message', 'Another phone is scoring this match.');
  else
    insert into app.live_state (tournament_id, on_air_match_id) values (m.tournament_id, m.id)
    on conflict (tournament_id) do update set on_air_match_id = excluded.on_air_match_id, updated_at = now(),
      version = app.live_state.version + 1
    where app.live_state.on_air_match_id is distinct from excluded.on_air_match_id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'This Match is on the stream.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.console_reads(uuid, uuid), app.console_match(uuid), app.scorer_matches(uuid), app.take_scoring(uuid, uuid, uuid),
  app.confirm_lineups(uuid, uuid, uuid, jsonb, jsonb), app.show_on_stream(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function app.console_match(uuid), app.scorer_matches(uuid), app.take_scoring(uuid, uuid, uuid),
  app.confirm_lineups(uuid, uuid, uuid, jsonb, jsonb), app.show_on_stream(uuid, uuid, uuid) to authenticated;
