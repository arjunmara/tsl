-- 0006_match_settings.sql: setup wizard step 4 (Story 1.10). The Format presets, the Season's Match settings and
-- one edit command. The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live.
-- Safe to run twice.

-- Format presets ---------------------------------------------------------------------------------

-- The one place preset defaults live; the wizard and the Match console read it. confirmed = false: the values are
-- assumptions the founder confirms before release. futsal_rules: the preset uses accumulated fouls, timeouts and
-- the power play (the other presets leave those settings null).
create table if not exists app.format_preset (
  key text primary key,
  label text not null,
  sort int not null,
  confirmed boolean not null,
  futsal_rules boolean not null,
  periods int not null,
  period_minutes int not null,
  clock text not null,
  half_time_minutes int not null,
  extra_time boolean not null,
  extra_time_periods int not null,
  extra_time_minutes int not null,
  shootout boolean not null,
  substitutions text not null,
  max_substitutions int,
  foul_warning int,
  timeouts_per_period int,
  power_play_minutes int
);

-- Futsal follows the FIFA Futsal Laws of the Game 2025-26 (Laws 3, 6, 7, 12): 2 x 20 min stopped clock, half-time at
-- most 15 min, extra time 2 x 5, one timeout per team per period (unused ones don't carry over, none in extra time),
-- rolling substitutions, the 5th accumulated foul signalled (fouls reset at half-time, the 2nd-half count carries
-- into extra time), a 2-minute numerical reduction after a sending-off that ends early if the opponent scores.
-- Custom starts from the futsal values. 5-, 7- and 11-a-side: for founder confirmation before release.
insert into app.format_preset values
  ('futsal',    'Futsal',    1, true,  true,  2, 20, 'stopped', 15, true,  2, 5,  true, 'rolling', null, 5, 1, 2),
  ('5-a-side',  '5-a-side',  2, false, false, 2, 20, 'running', 5,  false, 2, 5,  true, 'rolling', null, null, null, null),
  ('7-a-side',  '7-a-side',  3, false, false, 2, 30, 'running', 10, false, 2, 10, true, 'rolling', null, null, null, null),
  ('11-a-side', '11-a-side', 4, false, false, 2, 45, 'running', 15, true,  2, 15, true, 'limited', 5, null, null, null),
  ('custom',    'Custom',    5, true,  true,  2, 20, 'stopped', 15, true,  2, 5,  true, 'rolling', null, 5, 1, 2)
on conflict (key) do update set label = excluded.label, sort = excluded.sort, confirmed = excluded.confirmed,
  futsal_rules = excluded.futsal_rules, periods = excluded.periods, period_minutes = excluded.period_minutes,
  clock = excluded.clock, half_time_minutes = excluded.half_time_minutes, extra_time = excluded.extra_time,
  extra_time_periods = excluded.extra_time_periods, extra_time_minutes = excluded.extra_time_minutes,
  shootout = excluded.shootout, substitutions = excluded.substitutions, max_substitutions = excluded.max_substitutions,
  foul_warning = excluded.foul_warning, timeouts_per_period = excluded.timeouts_per_period,
  power_play_minutes = excluded.power_play_minutes;

alter table app.format_preset enable row level security;
drop policy if exists read_all on app.format_preset;
create policy read_all on app.format_preset for select to authenticated using (true);
revoke all on app.format_preset from public, anon, authenticated;
grant select on app.format_preset to authenticated;

-- Match settings on the Season -------------------------------------------------------------------

-- null until a preset is picked. Times in minutes.
alter table app.season
  add column if not exists format_preset text references app.format_preset (key),
  add column if not exists periods int,
  add column if not exists period_minutes int,
  add column if not exists clock text,
  add column if not exists half_time_minutes int,
  add column if not exists extra_time boolean,
  add column if not exists extra_time_periods int,
  add column if not exists extra_time_minutes int,
  add column if not exists shootout boolean,
  add column if not exists substitutions text,
  add column if not exists max_substitutions int,
  add column if not exists foul_warning int,
  add column if not exists timeouts_per_period int,
  add column if not exists power_play_minutes int;

-- The ranges the app allows (a null passes). set_match_settings reports a breach by constraint name.
alter table app.season drop constraint if exists season_match_settings;
alter table app.season add constraint season_match_settings check (
  periods between 1 and 4 and period_minutes between 1 and 60 and clock in ('stopped', 'running')
  and half_time_minutes between 0 and 30 and extra_time_periods between 1 and 2 and extra_time_minutes between 1 and 30
  and substitutions in ('rolling', 'limited') and max_substitutions between 1 and 50 and foul_warning between 1 and 20
  and timeouts_per_period between 0 and 3 and power_play_minutes between 1 and 5);
alter table app.season drop constraint if exists season_substitutions_max;
alter table app.season add constraint season_substitutions_max
  check (substitutions is distinct from 'limited' or max_substitutions is not null);

-- Command ----------------------------------------------------------------------------------------

-- Changes the Season's Match settings. A format_preset replaces every setting with that preset's row first; the
-- other arguments then change single settings (null = unchanged). Editing a setting needs a preset picked first.
-- A stale expected_version writes nothing and returns the conflict envelope (app/README.md).
create or replace function app.set_match_settings(
  command_id uuid, season_id uuid, expected_version int, format_preset text default null,
  periods int default null, period_minutes int default null, clock text default null, half_time_minutes int default null,
  extra_time boolean default null, extra_time_periods int default null, extra_time_minutes int default null,
  shootout boolean default null, substitutions text default null, max_substitutions int default null,
  foul_warning int default null, timeouts_per_period int default null, power_play_minutes int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_setup', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.season;
  n app.season;
  p jsonb;
  bad text;
  who text;
  who_at timestamptz;
  setting_keys text[] := array['format_preset', 'periods', 'period_minutes', 'clock', 'half_time_minutes', 'extra_time',
    'extra_time_periods', 'extra_time_minutes', 'shootout', 'substitutions', 'max_substitutions', 'foul_warning',
    'timeouts_per_period', 'power_play_minutes'];
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.season x where x.id = season_id for update;
  if format_preset is not null then
    select (to_jsonb(f) - array['key', 'label', 'sort', 'confirmed', 'futsal_rules']) || jsonb_build_object('format_preset', f.key)
    into p from app.format_preset f where f.key = format_preset;
  end if;
  if cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.tournament_id and l.table_name = 'season' and l.row_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version,
        'current', (select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(cur)) e where e.key = any(setting_keys)),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  elsif (format_preset is not null and p is null) or (format_preset is null and cur.format_preset is null) then
    r := jsonb_build_object('ok', false, 'code', 'preset_invalid', 'message', 'Pick a format preset first.');
  else
    n := jsonb_populate_record(cur, coalesce(p, '{}'));
    n := jsonb_populate_record(n, jsonb_strip_nulls(jsonb_build_object('periods', periods, 'period_minutes', period_minutes,
      'clock', clock, 'half_time_minutes', half_time_minutes, 'extra_time', extra_time, 'extra_time_periods', extra_time_periods,
      'extra_time_minutes', extra_time_minutes, 'shootout', shootout, 'substitutions', substitutions,
      'max_substitutions', max_substitutions, 'foul_warning', foul_warning, 'timeouts_per_period', timeouts_per_period,
      'power_play_minutes', power_play_minutes)));
    begin
      update app.season x set format_preset = n.format_preset, periods = n.periods, period_minutes = n.period_minutes,
        clock = n.clock, half_time_minutes = n.half_time_minutes, extra_time = n.extra_time,
        extra_time_periods = n.extra_time_periods, extra_time_minutes = n.extra_time_minutes, shootout = n.shootout,
        substitutions = n.substitutions, max_substitutions = n.max_substitutions, foul_warning = n.foul_warning,
        timeouts_per_period = n.timeouts_per_period, power_play_minutes = n.power_play_minutes, version = x.version + 1
      where x.id = cur.id;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Match settings updated.', 'version', cur.version + 1);
    exception when check_violation then
      get stacked diagnostics bad = constraint_name;
      r := case when bad = 'season_substitutions_max'
        then jsonb_build_object('ok', false, 'code', 'substitutions_max_needed', 'message', 'Set the maximum substitutions.')
        else jsonb_build_object('ok', false, 'code', 'settings_invalid', 'message', 'A setting is out of range.') end;
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.set_match_settings(uuid, uuid, int, text, int, int, text, int, boolean, int, int, boolean, text,
  int, int, int, int) from public, anon, authenticated;
grant execute on function app.set_match_settings(uuid, uuid, int, text, int, int, text, int, boolean, int, int, boolean, text,
  int, int, int, int) to authenticated;
