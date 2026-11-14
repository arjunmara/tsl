-- 0022_arrange_publish_fixtures.sql: arrange, schedule and publish Fixtures (Story 3.3). Adds app.season.fixtures_published_at and
-- three Organiser commands, all under the Season action edit_fixtures (registration only): swap_fixtures (two Matches exchange
-- their order, both versions bump), set_kick_off (one Match's kick-off, inside the Season's dates, in Asia/Kathmandu days) and
-- publish_fixtures (every Match needs a kick-off). suggest_fixtures is redefined to refuse once published.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.season add column if not exists fixtures_published_at timestamptz;

-- A swap needs both Matches to hold each other's place for a moment: the order is unique per Season, so the check moves to commit.
drop index if exists app.match_ord_idx;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'match_ord_key' and conrelid = 'app.match'::regclass) then
    alter table app.match add constraint match_ord_key unique (season_id, ord) deferrable initially immediate;
  end if;
end $$;

-- Exchanges the order of two Matches of the Season. version_a / version_b are the versions the phone saw; either one stale
-- returns version_conflict, with resend = the current versions of both for "Send my version".
create or replace function app.swap_fixtures(command_id uuid, season_id uuid, match_a uuid, version_a int, match_b uuid, version_b int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_fixtures', jsonb_build_object('season_id', season_id));
  r jsonb;
  a app.match;
  b app.match;
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  perform 1 from app.match m where m.season_id = season_id and m.id in (match_a, match_b) order by m.id for update;
  select * into a from app.match m where m.id = match_a and m.season_id = season_id;
  select * into b from app.match m where m.id = match_b and m.season_id = season_id;
  if a.id is null or b.id is null or match_a = match_b then
    r := jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match is not in this Season.');
  elsif a.version is distinct from version_a or b.version is distinct from version_b then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = a.tournament_id and l.table_name = 'match' and l.row_id in (a.id, b.id) order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', case when a.version is distinct from version_a then a.version else b.version end,
        'current', jsonb_build_object('ord_a', a.ord, 'ord_b', b.ord),
        'resend', jsonb_build_object('version_a', a.version, 'version_b', b.version),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  else
    set constraints app.match_ord_key deferred;
    update app.match m set ord = case m.id when a.id then b.ord else a.ord end, version = m.version + 1 where m.id in (a.id, b.id);
    set constraints app.match_ord_key immediate;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Fixtures swapped.', 'version', a.version + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Sets one Match's kick-off. The Kathmandu day must fall in the Season's dates (kickoff_outside_season).
create or replace function app.set_kick_off(command_id uuid, season_id uuid, match_id uuid, expected_version int, kick_off timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_fixtures', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.match;
  sn app.season;
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.match m where m.id = match_id and m.season_id = season_id for update;
  select * into sn from app.season x where x.id = season_id;
  if cur.id is null then
    r := jsonb_build_object('ok', false, 'code', 'match_missing', 'message', 'That Match is not in this Season.');
  elsif kick_off is null or (sn.starts_on is not null and (kick_off at time zone 'Asia/Kathmandu')::date < sn.starts_on)
    or (sn.ends_on is not null and (kick_off at time zone 'Asia/Kathmandu')::date > sn.ends_on) then
    r := jsonb_build_object('ok', false, 'code', 'kickoff_outside_season', 'message', 'Pick a date inside the Season.');
  elsif cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.tournament_id and l.table_name = 'match' and l.row_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version, 'current', jsonb_build_object('kick_off', cur.kick_off),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  else
    update app.match m set kick_off = set_kick_off.kick_off, version = m.version + 1 where m.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Kick-off saved.', 'version', cur.version + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Publishes the Season's Fixtures. Every Match needs a kick-off (kickoff_missing). Publishing twice is fine.
create or replace function app.publish_fixtures(command_id uuid, season_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_fixtures', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  perform 1 from app.season x where x.id = season_id for update;
  if not exists (select 1 from app.match m where m.season_id = season_id) then
    r := jsonb_build_object('ok', false, 'code', 'no_fixtures', 'message', 'Suggest the Fixtures first.');
  elsif exists (select 1 from app.match m where m.season_id = season_id and m.kick_off is null) then
    r := jsonb_build_object('ok', false, 'code', 'kickoff_missing', 'message', 'Every Match needs a kick-off time.');
  else
    update app.season x set fixtures_published_at = coalesce(x.fixtures_published_at, now()) where x.id = season_id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Fixtures published.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.swap_fixtures(uuid, uuid, uuid, int, uuid, int), app.set_kick_off(uuid, uuid, uuid, int, timestamptz),
  app.publish_fixtures(uuid, uuid) from public, anon, authenticated;
grant execute on function app.swap_fixtures(uuid, uuid, uuid, int, uuid, int), app.set_kick_off(uuid, uuid, uuid, int, timestamptz),
  app.publish_fixtures(uuid, uuid) to authenticated;

-- Redefined from 0021: once the Fixtures are published, a new suggestion is refused (fixtures_published).
-- Inserts the suggested Fixtures (fixtures = a JSON array of {id, stage, round, label, ord, home_team, away_team,
-- home_src, away_src}). Existing Fixtures make it refuse (fixtures_exist) unless replace is true, which deletes them first.
create or replace function app.suggest_fixtures(command_id uuid, season_id uuid, fixtures jsonb, replace boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_fixtures', jsonb_build_object('season_id', season_id));
  r jsonb;
  sn app.season;
  n int;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into sn from app.season x where x.id = season_id for update;
  if sn.fixtures_published_at is not null then
    r := jsonb_build_object('ok', false, 'code', 'fixtures_published', 'message', 'The Fixtures are published, so they can not be suggested again.');
  elsif sn.structure is null then
    r := jsonb_build_object('ok', false, 'code', 'no_structure', 'message', 'Choose a Structure first.');
  elsif fixtures is null or jsonb_typeof(fixtures) <> 'array' or jsonb_array_length(fixtures) not between 1 and 300
    or exists (select 1 from jsonb_array_elements(fixtures) e
      where jsonb_typeof(e) <> 'object' or e->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or e->>'ord' !~ '^[1-9][0-9]{0,3}$'
        or coalesce(e->>'stage', '') not in ('group', 'knockout', 'league') or coalesce(length(e->>'round'), 0) not between 1 and 40
        or (e->>'home_team' is not null and e->>'home_team' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        or (e->>'away_team' is not null and e->>'away_team' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        or length(e->>'label') > 12 or length(e->>'home_src') > 20 or length(e->>'away_src') > 20) then
    r := jsonb_build_object('ok', false, 'code', 'fixtures_invalid', 'message', 'The Fixtures are not valid.');
  elsif (select count(*) <> count(distinct e->>'id') or count(*) <> count(distinct e->>'ord') from jsonb_array_elements(fixtures) e) then
    r := jsonb_build_object('ok', false, 'code', 'fixtures_invalid', 'message', 'The Fixtures are not valid.');
  elsif exists (select 1 from jsonb_array_elements(fixtures) e, unnest(array[e->>'home_team', e->>'away_team']) t(id)
    where t.id is not null and not exists (select 1 from app.team m where m.id = t.id::uuid and m.season_id = sn.id and m.status = 'approved')) then
    r := jsonb_build_object('ok', false, 'code', 'team_not_approved', 'message', 'Only approved Teams can have Fixtures.');
  elsif sn.structure <> 'league' and exists (select 1 from app.team t where t.season_id = sn.id and t.status = 'approved'
    and not exists (select 1 from app.draw_slot d where d.team_id = t.id)) then
    r := jsonb_build_object('ok', false, 'code', 'draw_incomplete', 'message', 'Record the whole Draw first.');
  elsif exists (select 1 from app.match m where m.id in (select (e->>'id')::uuid from jsonb_array_elements(fixtures) e)) then
    r := jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'Those Fixtures already exist.');
  elsif exists (select 1 from app.match m where m.season_id = sn.id) and not replace then
    r := jsonb_build_object('ok', false, 'code', 'fixtures_exist', 'message', 'Fixtures were already suggested.');
  else
    delete from app.match m where m.season_id = sn.id;
    insert into app.match (id, tournament_id, season_id, stage, round, label, ord, home_team_id, away_team_id, home_src, away_src)
    select (e->>'id')::uuid, sn.tournament_id, sn.id, e->>'stage', e->>'round', e->>'label', (e->>'ord')::int,
      (e->>'home_team')::uuid, (e->>'away_team')::uuid, e->>'home_src', e->>'away_src'
    from jsonb_array_elements(fixtures) e;
    get diagnostics n = row_count;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Fixtures suggested.', 'count', n);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.suggest_fixtures(uuid, uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function app.suggest_fixtures(uuid, uuid, jsonb, boolean) to authenticated;
