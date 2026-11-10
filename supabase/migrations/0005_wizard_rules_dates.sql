-- 0005_wizard_rules_dates.sql: setup wizard steps 2 and 3 (Story 1.9). The Season's description, rules and
-- photo-consent statement, its start and end dates and the Registration deadline, and two edit commands.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- Columns ----------------------------------------------------------------------------------------

-- Dates are AD calendar days in the Tournament's time zone (Asia/Kathmandu); the app shows them in BS and AD.
-- registration_deadline is the last day registration is open.
alter table app.season
  add column if not exists description text not null default '' check (char_length(description) <= 1000),
  add column if not exists rules text not null default '' check (char_length(rules) <= 10000),
  add column if not exists photo_consent text not null default '' check (char_length(photo_consent) <= 2000),
  add column if not exists starts_on date,
  add column if not exists ends_on date,
  add column if not exists registration_deadline date;

-- Backstop for the commands' own checks (a null date passes).
alter table app.season drop constraint if exists season_dates_order;
alter table app.season add constraint season_dates_order
  check (ends_on >= starts_on and registration_deadline <= starts_on);

-- Commands ---------------------------------------------------------------------------------------

-- Changes the Season's description, rules or photo-consent statement. null = unchanged; '' empties it.
-- A stale expected_version writes nothing and returns the conflict envelope (app/README.md).
create or replace function app.set_season_rules(
  command_id uuid, season_id uuid, expected_version int, description text default null,
  rules text default null, photo_consent text default null)
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
  if char_length(description) > 1000 or char_length(rules) > 10000 or char_length(photo_consent) > 2000 then
    r := jsonb_build_object('ok', false, 'code', 'text_too_long', 'message', 'Text is too long.');
  elsif cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.tournament_id and l.table_name = 'season' and l.row_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version,
        'current', jsonb_build_object('description', cur.description, 'rules', cur.rules, 'photo_consent', cur.photo_consent),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  else
    update app.season x set
      description = coalesce(description, x.description),
      rules = coalesce(rules, x.rules),
      photo_consent = coalesce(photo_consent, x.photo_consent),
      version = x.version + 1
    where x.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Season updated.', 'version', cur.version + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Changes the Season's start and end dates and the Registration deadline. null = unchanged.
-- The values after the change must keep end >= start and deadline <= start.
create or replace function app.set_season_dates(
  command_id uuid, season_id uuid, expected_version int, starts_on date default null,
  ends_on date default null, registration_deadline date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_setup', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.season;
  s date;
  e date;
  d date;
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
  s := coalesce(starts_on, cur.starts_on);
  e := coalesce(ends_on, cur.ends_on);
  d := coalesce(registration_deadline, cur.registration_deadline);
  if cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.tournament_id and l.table_name = 'season' and l.row_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version,
        'current', jsonb_build_object('starts_on', cur.starts_on, 'ends_on', cur.ends_on,
                                      'registration_deadline', cur.registration_deadline),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  elsif d > s then
    r := jsonb_build_object('ok', false, 'code', 'deadline_after_start', 'message', 'The deadline is after the start date.');
  elsif e < s then
    r := jsonb_build_object('ok', false, 'code', 'end_before_start', 'message', 'The end date is before the start date.');
  else
    update app.season x set starts_on = s, ends_on = e, registration_deadline = d, version = x.version + 1
    where x.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Season updated.', 'version', cur.version + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.set_season_rules(uuid, uuid, int, text, text, text),
  app.set_season_dates(uuid, uuid, int, date, date, date) from public, anon, authenticated;
grant execute on function app.set_season_rules(uuid, uuid, int, text, text, text),
  app.set_season_dates(uuid, uuid, int, date, date, date) to authenticated;
