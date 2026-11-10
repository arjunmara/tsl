-- 0013_players_staff.sql: a Team manager adds Players and Staff within the Line-up rules (Story 2.3). The first personal
-- data in `app`: so every log_change trigger now declares its table's personal fields (logged by field name only), and a
-- trigger without that declaration refuses to log. Adds the Players (per Tournament), Squad entries, Staff and Photo
-- consent, readable by the Tournament's Organisers and, for its own Team, the Registration link grant; the commands to add,
-- change and remove them and to send the Team for review; and a minimum Squad size in app.lineup_violations.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- Tables -----------------------------------------------------------------------------------------

-- A Player belongs to the Tournament, so a later Season can find them again. date_of_birth is personal (logged by name
-- only) and may be erased later (2.10); the commands require it.
create table if not exists app.player (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  name text not null check (char_length(name) between 1 and 80 and name !~ '[\u0001-\u001f\u007f-\u009f  ]'),
  date_of_birth date check (date_of_birth >= '1940-01-01'),
  created_at timestamptz not null default now(),
  version int not null default 1
);

-- A Player in a Team's Squad, with their shirt number (1–99, unique in the Team). Changed only under the Player's
-- version (edit_player), so it has none of its own.
create table if not exists app.squad_entry (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references app.tournament (id),
  team_id uuid not null references app.team (id),
  player_id uuid not null references app.player (id),
  shirt_number int not null check (shirt_number between 1 and 99),
  created_at timestamptz not null default now(),
  unique (team_id, player_id)
);
create unique index if not exists squad_entry_shirt_idx on app.squad_entry (team_id, shirt_number);
create index if not exists squad_entry_player_idx on app.squad_entry (player_id);

-- A Team's Staff member; role is one of the Line-up rules' Staff role keys.
create table if not exists app.staff (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  team_id uuid not null references app.team (id),
  name text not null check (char_length(name) between 1 and 80 and name !~ '[\u0001-\u001f\u007f-\u009f  ]'),
  role text not null check (role in ('manager', 'coach', 'assistant_coach', 'physio', 'doctor', 'kit_manager')),
  created_at timestamptz not null default now(),
  version int not null default 1
);
create index if not exists staff_team_idx on app.staff (team_id);

-- A Player's Photo consent for one Season. given_by (personal, logged by name only): who gave it; a parent or guardian
-- for a minor. Changed only under the Player's version (edit_player).
create table if not exists app.photo_consent (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references app.tournament (id),
  player_id uuid not null references app.player (id),
  season_id uuid not null references app.season (id),
  consent_given boolean not null,
  given_by text check (char_length(given_by) between 1 and 80 and given_by !~ '[\u0001-\u001f\u007f-\u009f  ]'),
  recorded_at timestamptz not null default now(),
  constraint photo_consent_player_season_key unique (player_id, season_id),
  check (not consent_given or given_by is not null)
);

-- Activity log: every tenant table's trigger names its personal fields (second argument, '{}' for none) -------------
-- The triggers are (re)made before log_change itself, so the old function keeps logging until the new one is in place.

create or replace trigger log_change after insert or update or delete on app.tournament
  for each row execute function app.log_change('id', '{}');
create or replace trigger log_change after insert or update or delete on app.organiser_membership
  for each row execute function app.log_change('tournament_id', '{}');
create or replace trigger log_change after insert or update or delete on app.season
  for each row execute function app.log_change('tournament_id', '{}');
create or replace trigger log_change after insert or update or delete on app.discarded_command
  for each row execute function app.log_change('tournament_id', '{}');
create or replace trigger log_change after insert or update or delete on app.sponsor
  for each row execute function app.log_change('tournament_id', '{}');
create or replace trigger log_change after insert or update or delete on app.organiser_invite
  for each row execute function app.log_change('tournament_id', '{email,token}');
create or replace trigger log_change after insert or update or delete on app.team
  for each row execute function app.log_change('tournament_id', '{}');
create or replace trigger log_change after insert or update or delete on app.registration_link
  for each row execute function app.log_change('tournament_id', '{}');
create or replace trigger log_change after insert or update or delete on app.registration_grant
  for each row execute function app.log_change('tournament_id', '{}');
create or replace trigger log_change after insert or update or delete on app.player
  for each row execute function app.log_change('tournament_id', '{date_of_birth}');
create or replace trigger log_change after insert or update or delete on app.squad_entry
  for each row execute function app.log_change('tournament_id', '{}');
create or replace trigger log_change after insert or update or delete on app.staff
  for each row execute function app.log_change('tournament_id', '{}');
create or replace trigger log_change after insert or update or delete on app.photo_consent
  for each row execute function app.log_change('tournament_id', '{given_by}');

-- Generic Activity log row trigger. TG_ARGV[0]: the column holding the Tournament id. TG_ARGV[1]: the table's personal
-- fields as a text[] literal ('{}' for none); a value there is logged as the field's name, a null stays null. A trigger
-- without the declaration raises, so a new table can't log personal data by forgetting it (check.sh checks it too).
create or replace function app.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  a jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  k text;
begin
  if tg_nargs < 2 then
    raise exception 'log_change on app.%: declare the personal fields as the second trigger argument', tg_table_name;
  end if;
  foreach k in array tg_argv[1]::text[] loop
    if jsonb_typeof(b -> k) <> 'null' then b := jsonb_set(b, array[k], to_jsonb(k)); end if;
    if jsonb_typeof(a -> k) <> 'null' then a := jsonb_set(a, array[k], to_jsonb(k)); end if;
  end loop;
  insert into app.activity_log (tournament_id, actor, command_id, table_name, row_id, op, before, after, reason)
  values (
    (coalesce(a, b) ->> tg_argv[0])::uuid,
    nullif(current_setting('app.actor', true), '')::uuid,
    nullif(current_setting('app.command_id', true), '')::uuid,
    tg_table_name,
    (coalesce(a, b) ->> 'id')::uuid,
    lower(tg_op), b, a,
    nullif(current_setting('app.reason', true), ''));
  return null;
end $$;

-- RLS: the Tournament's Organisers read everything; a grant holder reads its own Team's Squad, Staff, those Players and
-- their consent for the Team's Season. No client writes.
alter table app.player enable row level security;
alter table app.squad_entry enable row level security;
alter table app.staff enable row level security;
alter table app.photo_consent enable row level security;
drop policy if exists member_read on app.player;
create policy member_read on app.player for select to authenticated using (app.is_member(tournament_id));
drop policy if exists member_read on app.squad_entry;
create policy member_read on app.squad_entry for select to authenticated using (app.is_member(tournament_id));
drop policy if exists member_read on app.staff;
create policy member_read on app.staff for select to authenticated using (app.is_member(tournament_id));
drop policy if exists member_read on app.photo_consent;
create policy member_read on app.photo_consent for select to authenticated using (app.is_member(tournament_id));
drop policy if exists grant_read on app.squad_entry;
create policy grant_read on app.squad_entry for select to authenticated using (team_id = (select app.granted_team()));
drop policy if exists grant_read on app.staff;
create policy grant_read on app.staff for select to authenticated using (team_id = (select app.granted_team()));
drop policy if exists grant_read on app.player;
create policy grant_read on app.player for select to authenticated using (exists (
  select 1 from app.squad_entry e where e.player_id = player.id and e.team_id = (select app.granted_team())));
drop policy if exists grant_read on app.photo_consent;
create policy grant_read on app.photo_consent for select to authenticated using (exists (
  select 1 from app.squad_entry e join app.team x on x.id = e.team_id
  where e.player_id = photo_consent.player_id and e.team_id = (select app.granted_team()) and x.season_id = photo_consent.season_id));
revoke all on app.player, app.squad_entry, app.staff, app.photo_consent from public, anon, authenticated;
grant select on app.player, app.squad_entry, app.staff, app.photo_consent to authenticated;

-- A Squad is changed and sent for review while setup or registration is open (deadline enforcement is 2.9).
insert into app.season_action values
  ('edit_squad', 'setup'), ('edit_squad', 'registration'), ('submit_team', 'setup'), ('submit_team', 'registration')
on conflict do nothing;

-- Helpers ----------------------------------------------------------------------------------------

-- authorize: as in 0012, with the Squad actions (edit_squad, submit_team) among the grant actions.
create or replace function app.authorize(p_actor uuid, p_action text, p_target jsonb) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  confirmed timestamptz;
  anonymous boolean;
  t uuid := (p_target ->> 'tournament_id')::uuid;
  s uuid := (p_target ->> 'season_id')::uuid;
  tm uuid := (p_target ->> 'team_id')::uuid;
  ts uuid;
begin
  if p_actor is null then return 'not_signed_in'; end if;
  select u.email_confirmed_at, coalesce(u.is_anonymous, false) into confirmed, anonymous from auth.users u where u.id = p_actor;
  if not found then return 'not_signed_in'; end if;
  if tm is not null then
    select x.season_id into ts from app.team x where x.id = tm;
    if ts is null or ts <> coalesce(s, ts) then return 'not_authorized'; end if;
    s := ts;
  end if;
  if anonymous then
    if p_action = 'redeem_registration_link' then return null; end if;
    if p_action = 'discard_command' and t is null and s is null then return null; end if;
    if p_action <> all (array['edit_team', 'edit_squad', 'submit_team']) or tm is null or not exists (
        select 1 from app.registration_grant g join app.registration_link l on l.id = g.link_id and l.revoked_at is null
        where g.id = p_actor and g.team_id = tm) then
      return 'not_authorized';
    end if;
    return app.season_allows(s, p_action);
  end if;
  if confirmed is null then return 'email_not_verified'; end if;
  if p_action = 'redeem_registration_link' then return 'not_authorized'; end if;
  if p_action = 'create_tournament' then return null; end if;
  if p_action in ('discard_command', 'accept_invite') and t is null and s is null then return null; end if;
  if s is not null then
    select tournament_id into t from app.season where id = s;
  end if;
  if t is null or not exists (select 1 from app.organiser_membership m
                              where m.tournament_id = t and m.user_id = p_actor) then
    return 'not_authorized';
  end if;
  if s is not null then return app.season_allows(s, p_action); end if;
  return null;
end $$;

-- The one Line-up rules check, as in 0007, plus a minimum: with "complete": true (the whole Squad, sent for review) the
-- players must number at least the starters. Input contract (callers build it from rows): starters, bench, players and
-- staff are arrays (anything else raises); a null staff role is skipped; one Player in both starters and bench is the
-- line-up caller's check (Epic 4).
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
  if squad ? 'players' and squad -> 'complete' = 'true'::jsonb and s.starters is not null then
    n := jsonb_array_length(squad -> 'players');
    if n < s.starters then
      r := r || format('Squad needs at least %s Player%s. You have %s.', s.starters, case when s.starters = 1 then '' else 's' end, n);
    end if;
  end if;
  for role in select distinct x from jsonb_array_elements_text(coalesce(squad -> 'staff', '[]')) x where x is not null order by 1 loop
    if not role = any (s.staff_roles) then
      r := r || format('%s isn''t an allowed Staff role.', upper(left(role, 1)) || replace(substr(role, 2), '_', ' '));
    end if;
  end loop;
  return r;
end $$;

-- The conflict envelope for a versioned row: the row now and who changed it last, as a role (a Team manager sees it, so
-- never an email). Commands only; no client grant.
create or replace function app.conflict(p_tournament_id uuid, p_table text, p_row_id uuid, p_version int, p_current jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  who text;
  who_at timestamptz;
begin
  select case when u.id is null then '' when u.is_anonymous then 'Team manager' else 'Organiser' end, l.at into who, who_at
  from app.activity_log l left join auth.users u on u.id = l.actor
  where l.tournament_id = p_tournament_id and l.table_name = p_table and l.row_id = p_row_id order by l.id desc limit 1;
  return jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
    'conflict', jsonb_build_object('current_version', p_version, 'current', p_current,
      'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
end $$;

-- What the Registration link form needs to add Players and Staff: the Season's photo-consent statement and Line-up
-- rules. One row for a live grant, none otherwise.
create or replace function app.registration_rules()
returns table (consent_statement text, starters int, max_bench int, staff_roles text[])
language sql stable security definer set search_path = '' as $$
  select s.photo_consent, s.starters, s.max_bench, s.staff_roles
  from app.team x join app.season s on s.id = x.season_id
  where x.id = app.granted_team()
$$;

-- Commands ---------------------------------------------------------------------------------------
-- Every Player and Staff command takes the Team (authorize fences it, a grant holder only its own) and checks the
-- Player or Staff member is in that Team. Minor: under 18 on today's date in Asia/Kathmandu, by the server's clock.

-- Adds a Player to the Team's Squad with their Photo consent for the Team's Season, in one step. Insert-only (a reused
-- player_id is already_exists). Refused with the Line-up rules' reasons when the Squad would be too big; consent given
-- needs given_by (a parent or guardian for a minor). The answer carries no version (a new Player is version 1).
create or replace function app.add_player(
  command_id uuid, team_id uuid, player_id uuid, name text, shirt_number int, date_of_birth date, consent boolean,
  given_by text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  n text := regexp_replace(name, '^\s+|\s+$', '', 'g');
  g text := nullif(regexp_replace(given_by, '^\s+|\s+$', '', 'g'), '');
  today date := (now() at time zone 'Asia/Kathmandu')::date;
  why text[];
  k text;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  -- Locked, so two Players added at once can't both pass the Squad size check.
  select * into x from app.team t where t.id = team_id for update;
  if n is null or char_length(n) not between 1 and 80 or n ~ '[\u0001-\u001f\u007f-\u009f  ]' then
    r := jsonb_build_object('ok', false, 'code', 'name_invalid', 'message', 'Name must be 1 to 80 characters.');
  elsif shirt_number is null or shirt_number not between 1 and 99 then
    r := jsonb_build_object('ok', false, 'code', 'shirt_invalid', 'message', 'Shirt number must be 1 to 99.');
  elsif date_of_birth is null or date_of_birth < '1940-01-01' or date_of_birth > today then
    r := jsonb_build_object('ok', false, 'code', 'dob_invalid', 'message', 'Date of birth is not valid.');
  elsif g is not null and (char_length(g) > 80 or g ~ '[\u0001-\u001f\u007f-\u009f  ]') then
    r := jsonb_build_object('ok', false, 'code', 'given_by_invalid', 'message', 'Name must be 1 to 80 characters.');
  elsif consent and g is null then
    r := case when date_of_birth > (today - interval '18 years')::date
      then jsonb_build_object('ok', false, 'code', 'guardian_required', 'message', 'Add the parent or guardian''s name.')
      else jsonb_build_object('ok', false, 'code', 'consent_name_required', 'message', 'Add the name of the person giving consent.') end;
  else
    why := app.lineup_violations(x.season_id, jsonb_build_object('players',
      coalesce((select jsonb_agg(e.player_id) from app.squad_entry e where e.team_id = x.id), '[]'::jsonb) || to_jsonb(player_id)));
    if cardinality(why) > 0 then
      r := jsonb_build_object('ok', false, 'code', 'lineup_violation', 'message', array_to_string(why, ' '));
    else
      begin
        insert into app.player (id, tournament_id, name, date_of_birth) values (player_id, x.tournament_id, n, date_of_birth);
        insert into app.squad_entry (tournament_id, team_id, player_id, shirt_number) values (x.tournament_id, x.id, player_id, shirt_number);
        insert into app.photo_consent (tournament_id, player_id, season_id, consent_given, given_by)
        values (x.tournament_id, player_id, x.season_id, coalesce(consent, false), case when consent then g end);
        r := jsonb_build_object('ok', true, 'code', null, 'message', 'Player added.');
      exception when unique_violation then
        get stacked diagnostics k = constraint_name;
        r := case when k = 'squad_entry_shirt_idx'
          then jsonb_build_object('ok', false, 'code', 'shirt_taken', 'message', 'That shirt number is already used in this Team.')
          else jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.') end;
      end;
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Changes a Player's name, shirt number, date of birth or Photo consent. null = unchanged; given_by without consent
-- keeps the consent as it is. Versioned on the Player (its Squad entry and consent included) with the conflict envelope.
-- A consenting minor needs given_by; so does a change of date of birth that makes a consenting Player a minor, unless
-- the same command carries given_by.
create or replace function app.edit_player(
  command_id uuid, team_id uuid, player_id uuid, expected_version int, name text default null,
  shirt_number int default null, date_of_birth date default null, consent boolean default null, given_by text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  e app.squad_entry;
  cur app.player;
  c app.photo_consent;
  n text := regexp_replace(name, '^\s+|\s+$', '', 'g');
  g text := nullif(regexp_replace(given_by, '^\s+|\s+$', '', 'g'), '');
  today date := (now() at time zone 'Asia/Kathmandu')::date;
  adult_from date := (today - interval '18 years')::date;
  nd date;
  nc boolean;
  ng text;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id;
  select * into e from app.squad_entry s where s.team_id = team_id and s.player_id = player_id;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'player_missing', 'message', 'That Player is not in this Squad.');
  else
    select * into cur from app.player p where p.id = player_id for update;
    select * into c from app.photo_consent pc where pc.player_id = player_id and pc.season_id = x.season_id;
    nd := coalesce(date_of_birth, cur.date_of_birth);
    nc := coalesce(consent, c.consent_given, false);
    ng := case when nc then coalesce(g, c.given_by) end;
    if cur.version is distinct from expected_version then
      r := app.conflict(cur.tournament_id, 'player', cur.id, cur.version, jsonb_build_object('name', cur.name,
        'shirt_number', e.shirt_number, 'date_of_birth', cur.date_of_birth, 'consent', coalesce(c.consent_given, false),
        'given_by', c.given_by));
    elsif n is null and shirt_number is null and date_of_birth is null and consent is null and g is null then
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Nothing to change.', 'version', cur.version);
    elsif n is not null and (char_length(n) not between 1 and 80 or n ~ '[\u0001-\u001f\u007f-\u009f  ]') then
      r := jsonb_build_object('ok', false, 'code', 'name_invalid', 'message', 'Name must be 1 to 80 characters.');
    elsif shirt_number is not null and shirt_number not between 1 and 99 then
      r := jsonb_build_object('ok', false, 'code', 'shirt_invalid', 'message', 'Shirt number must be 1 to 99.');
    elsif date_of_birth is not null and (date_of_birth < '1940-01-01' or date_of_birth > today) then
      r := jsonb_build_object('ok', false, 'code', 'dob_invalid', 'message', 'Date of birth is not valid.');
    elsif g is not null and (char_length(g) > 80 or g ~ '[\u0001-\u001f\u007f-\u009f  ]') then
      r := jsonb_build_object('ok', false, 'code', 'given_by_invalid', 'message', 'Name must be 1 to 80 characters.');
    elsif nc and (ng is null or (nd > adult_from and coalesce(cur.date_of_birth <= adult_from, true) and g is null)) then
      r := case when nd > adult_from
        then jsonb_build_object('ok', false, 'code', 'guardian_required', 'message', 'Add the parent or guardian''s name.')
        else jsonb_build_object('ok', false, 'code', 'consent_name_required', 'message', 'Add the name of the person giving consent.') end;
    else
      begin
        update app.player p set name = coalesce(n, p.name), date_of_birth = nd, version = p.version + 1 where p.id = cur.id;
        if shirt_number is not null and shirt_number <> e.shirt_number then
          update app.squad_entry s set shirt_number = shirt_number where s.id = e.id;
        end if;
        if consent is not null or g is not null then
          insert into app.photo_consent as pc (tournament_id, player_id, season_id, consent_given, given_by)
          values (cur.tournament_id, cur.id, x.season_id, nc, ng)
          on conflict on constraint photo_consent_player_season_key do update set consent_given = excluded.consent_given,
            given_by = excluded.given_by, recorded_at = now()
          where pc.consent_given is distinct from excluded.consent_given or pc.given_by is distinct from excluded.given_by;
        end if;
        r := jsonb_build_object('ok', true, 'code', null, 'message', 'Player updated.', 'version', cur.version + 1);
      exception when unique_violation then
        r := jsonb_build_object('ok', false, 'code', 'shirt_taken', 'message', 'That shirt number is already used in this Team.');
      end;
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Removes a Player from the Team's Squad, with their consent for its Season. A Player in no other Squad is deleted with
-- their personal details. Versioned with the conflict envelope; a Player already gone (or never in this Squad) is ok.
create or replace function app.remove_player(command_id uuid, team_id uuid, player_id uuid, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  e app.squad_entry;
  cur app.player;
  c app.photo_consent;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id;
  select * into e from app.squad_entry s where s.team_id = team_id and s.player_id = player_id;
  if not found then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Player already removed.');
  else
    select * into cur from app.player p where p.id = player_id for update;
    if cur.version is distinct from expected_version then
      select * into c from app.photo_consent pc where pc.player_id = player_id and pc.season_id = x.season_id;
      r := app.conflict(cur.tournament_id, 'player', cur.id, cur.version, jsonb_build_object('name', cur.name,
        'shirt_number', e.shirt_number, 'date_of_birth', cur.date_of_birth, 'consent', coalesce(c.consent_given, false),
        'given_by', c.given_by));
    else
      delete from app.squad_entry s where s.id = e.id;
      delete from app.photo_consent pc where pc.player_id = cur.id and pc.season_id = x.season_id and not exists (
        select 1 from app.squad_entry s join app.team t on t.id = s.team_id where s.player_id = cur.id and t.season_id = x.season_id);
      if not exists (select 1 from app.squad_entry s where s.player_id = cur.id) then
        delete from app.photo_consent pc where pc.player_id = cur.id;
        delete from app.player p where p.id = cur.id;
      end if;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Player removed.');
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Adds a Staff member. Insert-only. The role must be one the Season's Line-up rules allow (reasons in words).
create or replace function app.add_staff(command_id uuid, team_id uuid, staff_id uuid, name text, role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  n text := regexp_replace(name, '^\s+|\s+$', '', 'g');
  why text[];
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id;
  if n is null or char_length(n) not between 1 and 80 or n ~ '[\u0001-\u001f\u007f-\u009f  ]' then
    r := jsonb_build_object('ok', false, 'code', 'name_invalid', 'message', 'Name must be 1 to 80 characters.');
  elsif role is null or role = '' then
    r := jsonb_build_object('ok', false, 'code', 'role_required', 'message', 'Pick a Staff role.');
  else
    why := app.lineup_violations(x.season_id, jsonb_build_object('staff', jsonb_build_array(role)));
    if cardinality(why) > 0 then
      r := jsonb_build_object('ok', false, 'code', 'lineup_violation', 'message', array_to_string(why, ' '));
    else
      begin
        insert into app.staff (id, tournament_id, team_id, name, role) values (staff_id, x.tournament_id, x.id, n, role);
        r := jsonb_build_object('ok', true, 'code', null, 'message', 'Staff member added.');
      exception when unique_violation then
        r := jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.');
      end;
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Changes a Staff member's name or role. null = unchanged. Versioned with the conflict envelope.
create or replace function app.edit_staff(
  command_id uuid, team_id uuid, staff_id uuid, expected_version int, name text default null, role text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  cur app.staff;
  n text := regexp_replace(name, '^\s+|\s+$', '', 'g');
  why text[];
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.staff s where s.id = staff_id and s.team_id = team_id for update;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'staff_missing', 'message', 'That Staff member is not in this Team.');
  elsif cur.version is distinct from expected_version then
    r := app.conflict(cur.tournament_id, 'staff', cur.id, cur.version, jsonb_build_object('name', cur.name, 'role', cur.role));
  elsif n is null and role is null then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Nothing to change.', 'version', cur.version);
  elsif n is not null and (char_length(n) not between 1 and 80 or n ~ '[\u0001-\u001f\u007f-\u009f  ]') then
    r := jsonb_build_object('ok', false, 'code', 'name_invalid', 'message', 'Name must be 1 to 80 characters.');
  else
    why := case when role is null then '{}'::text[] else app.lineup_violations(
      (select t.season_id from app.team t where t.id = team_id), jsonb_build_object('staff', jsonb_build_array(role))) end;
    if role = '' then
      r := jsonb_build_object('ok', false, 'code', 'role_required', 'message', 'Pick a Staff role.');
    elsif cardinality(why) > 0 then
      r := jsonb_build_object('ok', false, 'code', 'lineup_violation', 'message', array_to_string(why, ' '));
    else
      update app.staff s set name = coalesce(n, s.name), role = coalesce(role, s.role), version = s.version + 1 where s.id = cur.id;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Staff member updated.', 'version', cur.version + 1);
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Removes a Staff member. Versioned with the conflict envelope; one already gone (or not in this Team) is ok.
create or replace function app.remove_staff(command_id uuid, team_id uuid, staff_id uuid, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  cur app.staff;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.staff s where s.id = staff_id and s.team_id = team_id for update;
  if not found then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Staff member already removed.');
  elsif cur.version is distinct from expected_version then
    r := app.conflict(cur.tournament_id, 'staff', cur.id, cur.version, jsonb_build_object('name', cur.name, 'role', cur.role));
  else
    delete from app.staff s where s.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Staff member removed.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Sends the Team for review: its status becomes submitted when the whole Squad and Staff meet the Line-up rules (else
-- the reasons in words). Already submitted is ok; an approved Team is team_approved. Status is not versioned content, so
-- the Team's version stays.
create or replace function app.submit_team(command_id uuid, team_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'submit_team', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  why text[];
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id for update;
  why := app.lineup_violations(x.season_id, jsonb_build_object('complete', true,
    'players', coalesce((select jsonb_agg(e.player_id) from app.squad_entry e where e.team_id = x.id), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(s.role) from app.staff s where s.team_id = x.id), '[]'::jsonb)));
  if x.status = 'approved' then
    r := jsonb_build_object('ok', false, 'code', 'team_approved', 'message', 'This Team is already approved.');
  elsif cardinality(why) > 0 then
    r := jsonb_build_object('ok', false, 'code', 'lineup_violation', 'message', array_to_string(why, ' '));
  elsif x.status = 'submitted' then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Already sent for review.');
  else
    update app.team t set status = 'submitted' where t.id = x.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Sent for review.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.conflict(uuid, text, uuid, int, jsonb), app.registration_rules(),
  app.add_player(uuid, uuid, uuid, text, int, date, boolean, text),
  app.edit_player(uuid, uuid, uuid, int, text, int, date, boolean, text), app.remove_player(uuid, uuid, uuid, int),
  app.add_staff(uuid, uuid, uuid, text, text), app.edit_staff(uuid, uuid, uuid, int, text, text),
  app.remove_staff(uuid, uuid, uuid, int), app.submit_team(uuid, uuid) from public, anon, authenticated;
grant execute on function app.registration_rules(), app.add_player(uuid, uuid, uuid, text, int, date, boolean, text),
  app.edit_player(uuid, uuid, uuid, int, text, int, date, boolean, text), app.remove_player(uuid, uuid, uuid, int),
  app.add_staff(uuid, uuid, uuid, text, text), app.edit_staff(uuid, uuid, uuid, int, text, text),
  app.remove_staff(uuid, uuid, uuid, int), app.submit_team(uuid, uuid) to authenticated;
