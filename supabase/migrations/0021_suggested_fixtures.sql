-- 0021_suggested_fixtures.sql: suggested Fixtures and the knockout path (Story 3.2). One table, app.match (a Fixture is a
-- Match that has not been played), and one command, suggest_fixtures, which inserts the whole suggested list with ids made
-- on the client. The order and pairings are worked out on the phone (app/src/domain/fixtures.ts); the server checks that
-- every Team named is an approved Team of the Season and, with a Draw, that the Draw is complete. Fixtures are suggested
-- and replaced while the Season is in registration. Score columns are left empty: the goal trigger fills them (Story 3.4).
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

create table if not exists app.match (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  season_id uuid not null references app.season (id),
  stage text not null check (stage in ('group', 'knockout', 'league')),
  round text not null check (length(round) between 1 and 40),
  label text check (length(label) <= 12),
  ord int not null check (ord >= 1),
  -- A side is a Team, or while unknown a source label: "A1", "Winner SF1". A Team that skips round 1 has src 'Bye'.
  home_team_id uuid references app.team (id),
  away_team_id uuid references app.team (id),
  home_src text check (length(home_src) <= 20),
  away_src text check (length(away_src) <= 20),
  kick_off timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled')),
  hg int,
  ag int,
  created_at timestamptz not null default now(),
  version int not null default 1
);
create unique index if not exists match_ord_idx on app.match (season_id, ord);

-- No personal fields here.
create or replace trigger log_change after insert or update or delete on app.match
  for each row execute function app.log_change('tournament_id', '{}');

alter table app.match enable row level security;
drop policy if exists member_read on app.match;
create policy member_read on app.match for select to authenticated using (app.is_member(tournament_id));
revoke all on app.match from public, anon, authenticated;
grant select on app.match to authenticated;

insert into app.season_action values ('edit_fixtures', 'registration') on conflict do nothing;

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
  if sn.structure is null then
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
