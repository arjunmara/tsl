-- 0007_lineup_structure.sql: setup wizard steps 5 and 6 (Story 1.11). The Season's Line-up rules and Structure (points
-- and tie-break order), line-up defaults on the Format presets, two edit commands and the shared line-up rule check.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- Line-up defaults on the Format presets ---------------------------------------------------------

-- Futsal: 5 starters and up to 9 substitutes (FIFA Futsal Laws 2025-26, Law 3). Others: for founder confirmation.
alter table app.format_preset
  add column if not exists starters int,
  add column if not exists max_bench int;
update app.format_preset p set starters = v.starters, max_bench = v.max_bench
from (values ('futsal', 5, 9), ('5-a-side', 5, 5), ('7-a-side', 7, 5), ('11-a-side', 11, 7), ('custom', 5, 9))
  as v (key, starters, max_bench)
where p.key = v.key;

-- Line-up rules and Structure on the Season ------------------------------------------------------

-- starters, max_bench and structure are null until set. tiebreaks: the order for Teams level on points.
alter table app.season
  add column if not exists starters int,
  add column if not exists max_bench int,
  add column if not exists staff_roles text[] not null default '{manager,coach}',
  add column if not exists structure text,
  add column if not exists group_count int,
  add column if not exists teams_per_group int,
  add column if not exists qualifiers_per_group int,
  add column if not exists points_win int not null default 3,
  add column if not exists points_draw int not null default 1,
  add column if not exists points_loss int not null default 0,
  add column if not exists tiebreaks text[] not null
    default '{h2h_points,h2h_goal_difference,h2h_shootout,goal_difference,goals_scored}';

-- The ranges the app allows (a null passes). The commands report a breach by constraint name.
alter table app.season drop constraint if exists season_lineup_rules;
alter table app.season add constraint season_lineup_rules check (
  starters between 1 and 11 and max_bench between 0 and 20
  and staff_roles <@ array['manager', 'coach', 'assistant_coach', 'physio', 'doctor', 'kit_manager']);
alter table app.season drop constraint if exists season_structure;
alter table app.season add constraint season_structure check (
  structure in ('groups_knockout', 'knockout', 'league') and group_count between 2 and 16
  and teams_per_group between 2 and 16 and points_win between 0 and 9 and points_draw between 0 and 9
  and points_loss between 0 and 9);
alter table app.season drop constraint if exists season_qualifiers;
alter table app.season add constraint season_qualifiers check (
  qualifiers_per_group between 1 and 15 and qualifiers_per_group < teams_per_group);
alter table app.season drop constraint if exists season_tiebreaks;
alter table app.season add constraint season_tiebreaks check (
  tiebreaks <@ array['h2h_points', 'h2h_goal_difference', 'h2h_shootout', 'goal_difference', 'goals_scored']);

-- Commands ---------------------------------------------------------------------------------------

-- Changes the Season's Line-up rules. null = unchanged. A stale expected_version writes nothing and returns the
-- conflict envelope (app/README.md).
create or replace function app.set_lineup_rules(
  command_id uuid, season_id uuid, expected_version int, starters int default null, max_bench int default null,
  staff_roles text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_setup', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.season;
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.season x where x.id = season_id for update;
  if cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.tournament_id and l.table_name = 'season' and l.row_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version,
        'current', jsonb_build_object('starters', cur.starters, 'max_bench', cur.max_bench, 'staff_roles', cur.staff_roles),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  elsif array_position(staff_roles, null) is not null
     or cardinality(staff_roles) <> (select count(distinct x) from unnest(staff_roles) x) then
    r := jsonb_build_object('ok', false, 'code', 'lineup_rules_invalid', 'message', 'A Line-up rule is out of range.');
  else
    begin
      update app.season x set starters = coalesce(starters, x.starters), max_bench = coalesce(max_bench, x.max_bench),
        staff_roles = coalesce(staff_roles, x.staff_roles), version = x.version + 1
      where x.id = cur.id;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Line-up rules updated.', 'version', cur.version + 1);
    exception when check_violation then
      r := jsonb_build_object('ok', false, 'code', 'lineup_rules_invalid', 'message', 'A Line-up rule is out of range.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Changes the Season's Structure, points and tie-break order. null = unchanged; tiebreaks replaces the whole order.
-- Allowed while setup can be edited (not after the Season starts: season_started).
create or replace function app.set_structure(
  command_id uuid, season_id uuid, expected_version int, structure text default null, group_count int default null,
  teams_per_group int default null, qualifiers_per_group int default null, points_win int default null,
  points_draw int default null, points_loss int default null, tiebreaks text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_setup', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.season;
  bad text;
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.season x where x.id = season_id for update;
  if cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.tournament_id and l.table_name = 'season' and l.row_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version,
        'current', jsonb_build_object('structure', cur.structure, 'group_count', cur.group_count,
          'teams_per_group', cur.teams_per_group, 'qualifiers_per_group', cur.qualifiers_per_group,
          'points_win', cur.points_win, 'points_draw', cur.points_draw, 'points_loss', cur.points_loss,
          'tiebreaks', cur.tiebreaks),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  elsif array_position(tiebreaks, null) is not null
     or cardinality(tiebreaks) <> (select count(distinct x) from unnest(tiebreaks) x) then
    r := jsonb_build_object('ok', false, 'code', 'tiebreaks_invalid', 'message', 'The tie-break order is not valid.');
  else
    begin
      update app.season x set structure = coalesce(structure, x.structure),
        group_count = coalesce(group_count, x.group_count), teams_per_group = coalesce(teams_per_group, x.teams_per_group),
        qualifiers_per_group = coalesce(qualifiers_per_group, x.qualifiers_per_group),
        points_win = coalesce(points_win, x.points_win), points_draw = coalesce(points_draw, x.points_draw),
        points_loss = coalesce(points_loss, x.points_loss), tiebreaks = coalesce(tiebreaks, x.tiebreaks),
        version = x.version + 1
      where x.id = cur.id;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Structure updated.', 'version', cur.version + 1);
    exception when check_violation then
      get stacked diagnostics bad = constraint_name;
      r := jsonb_build_object('ok', false, 'code', case bad when 'season_qualifiers' then 'qualifiers_invalid'
        when 'season_tiebreaks' then 'tiebreaks_invalid' else 'structure_invalid' end, 'message', 'A setting is out of range.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Shared rule check -------------------------------------------------------------------------------

-- The one Line-up rules check, for registration (Epic 2) and line-ups (Epic 4): the reasons a squad or line-up breaks
-- the Season's Line-up rules, in words; empty when it meets them. squad keys, each optional: starters, bench, players
-- (arrays, counted) and staff (array of role keys). A rule not set yet is skipped. Read-only; commands call it, so
-- clients get no grant.
create or replace function app.lineup_violations(season_id uuid, squad jsonb) returns text[]
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  s app.season;
  r text[] := '{}';
  n int;
  role text;
begin
  select * into s from app.season x where x.id = season_id;
  if not found then raise exception 'season % not found', season_id; end if;
  if squad ? 'starters' and s.starters is not null then
    n := jsonb_array_length(squad -> 'starters');
    if n <> s.starters then
      r := r || format('Line-up needs %s starter%s. You''ve picked %s.', s.starters, case when s.starters = 1 then '' else 's' end, n);
    end if;
  end if;
  if squad ? 'bench' and s.max_bench is not null then
    n := jsonb_array_length(squad -> 'bench');
    if n > s.max_bench then
      r := r || format('Bench can have at most %s Player%s. You''ve picked %s.', s.max_bench, case when s.max_bench = 1 then '' else 's' end, n);
    end if;
  end if;
  if squad ? 'players' and s.starters is not null and s.max_bench is not null then
    n := jsonb_array_length(squad -> 'players');
    if n > s.starters + s.max_bench then
      r := r || format('Squad can have at most %s Players. You have %s.', s.starters + s.max_bench, n);
    end if;
  end if;
  for role in select distinct x from jsonb_array_elements_text(coalesce(squad -> 'staff', '[]')) x order by 1 loop
    if not role = any (s.staff_roles) then
      r := r || format('%s isn''t an allowed Staff role.', upper(left(role, 1)) || replace(substr(role, 2), '_', ' '));
    end if;
  end loop;
  return r;
end $$;

revoke all on function app.set_lineup_rules(uuid, uuid, int, int, int, text[]),
  app.set_structure(uuid, uuid, int, text, int, int, int, int, int, int, text[]),
  app.lineup_violations(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.set_lineup_rules(uuid, uuid, int, int, int, text[]),
  app.set_structure(uuid, uuid, int, text, int, int, int, int, int, int, text[]) to authenticated;
