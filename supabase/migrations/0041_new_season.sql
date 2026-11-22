-- 0041_new_season.sql: start the next Season copied from the last one (Story 6.1, FR-48). One command, new_season. When the Tournament's latest Season is finished
-- it inserts the next-numbered Season in setup with every setup answer copied except the dates, and copies the Sponsors as new rows (files are reused).
-- Teams, Squads, Fixtures, draw slots, scorer tokens and awards are never copied; the source Season is not touched. The founder applies this in the
-- Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- Authorized against the Tournament (any Organiser), so it is not a season_action row. A repeated command_id returns the first result.
create or replace function app.new_season(command_id uuid, tournament_id uuid, season_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'new_season', jsonb_build_object('tournament_id', tournament_id));
  r jsonb;
  src app.season;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  -- The lock on the Tournament row serialises two Seasons being started at once.
  perform 1 from app.tournament t where t.id = tournament_id for update;
  select * into src from app.season s where s.tournament_id = tournament_id order by s.number desc limit 1;

  if exists (select 1 from app.season s where s.id = season_id) then
    r := jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That Season already exists.');
  elsif src.id is null or src.status <> 'finished' then
    r := jsonb_build_object('ok', false, 'code', 'season_running',
      'message', 'Season ' || coalesce(src.number, 0) || ' is still running. Finish it before starting Season ' || (coalesce(src.number, 0) + 1) || '.');
  else
    insert into app.season (id, tournament_id, number, setup_step,
      description, rules, photo_consent, venue, format_preset, periods, period_minutes, clock, half_time_minutes, extra_time, extra_time_periods,
      extra_time_minutes, shootout, substitutions, max_substitutions, foul_warning, timeouts_per_period, power_play_minutes,
      starters, max_bench, staff_roles, structure, group_count, teams_per_group, qualifiers_per_group, points_win, points_draw, points_loss, tiebreaks)
    select season_id, tournament_id, src.number + 1, 2,
      src.description, src.rules, src.photo_consent, src.venue, src.format_preset, src.periods, src.period_minutes, src.clock, src.half_time_minutes,
      src.extra_time, src.extra_time_periods, src.extra_time_minutes, src.shootout, src.substitutions, src.max_substitutions, src.foul_warning,
      src.timeouts_per_period, src.power_play_minutes, src.starters, src.max_bench, src.staff_roles, src.structure, src.group_count,
      src.teams_per_group, src.qualifiers_per_group, src.points_win, src.points_draw, src.points_loss, src.tiebreaks;
    insert into app.sponsor (id, tournament_id, season_id, logo_path, ad_paths, caption, sort)
    select gen_random_uuid(), x.tournament_id, season_id, x.logo_path, x.ad_paths, x.caption, x.sort
    from app.sponsor x where x.season_id = src.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Season ' || (src.number + 1) || ' started.', 'version', 1,
      'season_id', season_id, 'number', src.number + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.new_season(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function app.new_season(uuid, uuid, uuid) to authenticated;
