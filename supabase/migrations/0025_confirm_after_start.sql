-- 0025_confirm_after_start.sql: confirm before changes after start (Story 3.6, FR-16, AD-21). Once a Season has started, an
-- Organiser may still fix a Squad or a Fixture, but only when the command says it was confirmed: app.season_action gains a
-- `confirm` flag, and app.season_allows (the one "allowed now?" decision) answers confirmation_required for a flagged action in
-- a started Season unless the caller passes confirmed = true. app.authorize passes the target's `confirmed` on to it. The 11
-- FR-16 commands (add/edit/remove Player, add/edit/remove Staff, add/edit Eligibility, set_photo, swap_fixtures, set_kick_off)
-- each gain `confirmed boolean default false`; in setup and registration it changes nothing. A Registration link still can't
-- change a started Season (season_started). The Activity log needs nothing new: its triggers already record before, after and
-- actor. After start the Season's description (only) can still change, through set_season_rules under the new action
-- edit_description; rules and the photo-consent statement stay locked. Draw, Teams, tie-breaks and the rest stay locked.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.season_action add column if not exists confirm boolean not null default false;
insert into app.season_action (action, status, confirm) values ('edit_squad', 'started', true), ('edit_fixtures', 'started', true)
on conflict (action, status) do update set confirm = true;
insert into app.season_action (action, status) values ('edit_description', 'setup'), ('edit_description', 'registration'),
  ('edit_description', 'started')
on conflict do nothing;

-- The only "allowed now?" decision. p_team_id: the Team whose Registration link is acting (a grant); its deadline applies, and
-- a grant never passes a confirm-only action (season_started). p_confirmed: the Organiser confirmed this change.
-- null = allowed, else not_found, season_<status>, confirmation_required or registration_closed.
create or replace function app.season_allows(p_season_id uuid, p_action text, p_team_id uuid, p_confirmed boolean) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  s text;
  need boolean;
  closes timestamptz;
  entered timestamptz;
begin
  select status into s from app.season where id = p_season_id;
  if s is null then return 'not_found'; end if;
  select a.confirm into need from app.season_action a where a.action = p_action and a.status = s;
  if not found then return 'season_' || s; end if;
  if need then
    if p_team_id is not null then return 'season_' || s; end if;
    if not coalesce(p_confirmed, false) then return 'confirmation_required'; end if;
  end if;
  if p_team_id is null then return null; end if;
  closes := app.link_closes_at(p_team_id);
  if closes is null then return null; end if;
  begin
    entered := (nullif(current_setting('request.headers', true), '')::json ->> 'x-entered-at')::timestamptz;
  exception when others then
    entered := null;
  end;
  entered := least(coalesce(entered, now()), now());
  if entered < closes and now() < closes + app.grace_window() then return null; end if;
  return 'registration_closed';
end $$;

create or replace function app.season_allows(p_season_id uuid, p_action text, p_team_id uuid) returns text
language sql stable security definer set search_path = '' as $$ select app.season_allows(p_season_id, p_action, p_team_id, false) $$;

create or replace function app.season_allows(p_season_id uuid, p_action text) returns text
language sql stable security definer set search_path = '' as $$ select app.season_allows(p_season_id, p_action, null, false) $$;

revoke all on function app.season_allows(uuid, text, uuid, boolean) from public, anon, authenticated;

-- authorize: as in 0018; an Organiser's change also passes the target's `confirmed` to season_allows.
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
    if p_action = 'redeem_registration_link' then return null; end if;
    if p_action = 'discard_command' and t is null and s is null then return null; end if;
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
  if st = 'withdrawn' and p_action <> 'review_team' then return 'team_withdrawn'; end if;
  if s is not null then return app.season_allows(s, p_action, null, coalesce((p_target ->> 'confirmed')::boolean, false)); end if;
  return null;
end $$;

-- set_season_rules: as in 0005; a change of the description alone is allowed after start too (edit_description).
create or replace function app.set_season_rules(
  command_id uuid, season_id uuid, expected_version int, description text default null,
  rules text default null, photo_consent text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, case when rules is null and photo_consent is null then 'edit_description' else 'edit_setup' end,
    jsonb_build_object('season_id', season_id));
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

drop function if exists app.add_player(uuid, uuid, uuid, text, int, date, boolean, text);
drop function if exists app.edit_player(uuid, uuid, uuid, int, text, int, date, boolean, text);
drop function if exists app.add_staff(uuid, uuid, uuid, text, text);
drop function if exists app.edit_staff(uuid, uuid, uuid, int, text, text);
drop function if exists app.remove_staff(uuid, uuid, uuid, int);
drop function if exists app.add_eligibility(uuid, uuid, uuid, uuid, text, text, text, text);
drop function if exists app.edit_eligibility(uuid, uuid, uuid, int, text, text, text, text);
drop function if exists app.remove_player(uuid, uuid, uuid, int);
drop function if exists app.set_photo(uuid, uuid, uuid, int, text, boolean);
drop function if exists app.swap_fixtures(uuid, uuid, uuid, int, uuid, int);
drop function if exists app.set_kick_off(uuid, uuid, uuid, int, timestamptz);

-- add_player: as in 0013_players_staff.sql, plus confirmed.
create or replace function app.add_player(
  command_id uuid, team_id uuid, player_id uuid, name text, shirt_number int, date_of_birth date, consent boolean,
  given_by text default null, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id, 'confirmed', confirmed));
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

-- edit_player: as in 0013_players_staff.sql, plus confirmed.
create or replace function app.edit_player(
  command_id uuid, team_id uuid, player_id uuid, expected_version int, name text default null,
  shirt_number int default null, date_of_birth date default null, consent boolean default null, given_by text default null, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id, 'confirmed', confirmed));
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

-- add_staff: as in 0013_players_staff.sql, plus confirmed.
create or replace function app.add_staff(command_id uuid, team_id uuid, staff_id uuid, name text, role text, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id, 'confirmed', confirmed));
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

-- edit_staff: as in 0013_players_staff.sql, plus confirmed.
create or replace function app.edit_staff(
  command_id uuid, team_id uuid, staff_id uuid, expected_version int, name text default null, role text default null, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id, 'confirmed', confirmed));
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

-- remove_staff: as in 0013_players_staff.sql, plus confirmed.
create or replace function app.remove_staff(command_id uuid, team_id uuid, staff_id uuid, expected_version int, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id, 'confirmed', confirmed));
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

-- add_eligibility: as in 0014_eligibility.sql, plus confirmed.
create or replace function app.add_eligibility(
  command_id uuid, team_id uuid, player_id uuid, record_id uuid, document_type text default null,
  document_number text default null, scan_path text default null, scan_name text default null, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id, 'confirmed', confirmed));
  r jsonb;
  x app.team;
  num text := regexp_replace(document_number, '^\s+|\s+$', '', 'g');
  nm text := regexp_replace(scan_name, '^\s+|\s+$', '', 'g');
  k text;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id;
  if not exists (select 1 from app.squad_entry s where s.team_id = team_id and s.player_id = player_id) then
    r := jsonb_build_object('ok', false, 'code', 'player_missing', 'message', 'That Player is not in this Squad.');
  else
    r := app.eligibility_invalid(x, player_id, document_type, num, scan_path, nm);
    if r is null then
      begin
        insert into app.eligibility_record (id, tournament_id, player_id, season_id, document_type, document_number, scan_path,
          scan_name, scan_uploaded_at)
        values (record_id, x.tournament_id, player_id, x.season_id, document_type, num, scan_path, nm,
          case when scan_path is not null then now() end);
        r := jsonb_build_object('ok', true, 'code', null, 'message', 'Document added.');
      exception when unique_violation then
        get stacked diagnostics k = constraint_name;
        r := case when k = 'eligibility_record_player_season_key'
          then jsonb_build_object('ok', false, 'code', 'eligibility_exists', 'message', 'This Player already has a document.')
          else jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.') end;
      end;
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- edit_eligibility: as in 0014_eligibility.sql, plus confirmed.
create or replace function app.edit_eligibility(
  command_id uuid, team_id uuid, player_id uuid, expected_version int, document_type text default null,
  document_number text default null, scan_path text default null, scan_name text default null, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id, 'confirmed', confirmed));
  r jsonb;
  x app.team;
  cur app.eligibility_record;
  num text := regexp_replace(document_number, '^\s+|\s+$', '', 'g');
  nm text := regexp_replace(scan_name, '^\s+|\s+$', '', 'g');
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id;
  if not exists (select 1 from app.squad_entry s where s.team_id = team_id and s.player_id = player_id) then
    r := jsonb_build_object('ok', false, 'code', 'player_missing', 'message', 'That Player is not in this Squad.');
  else
    select * into cur from app.eligibility_record e where e.player_id = player_id and e.season_id = x.season_id for update;
    if not found then
      r := jsonb_build_object('ok', false, 'code', 'eligibility_missing', 'message', 'That document was removed.');
    elsif cur.version is distinct from expected_version then
      r := app.conflict(cur.tournament_id, 'eligibility_record', cur.id, cur.version, jsonb_build_object(
        'document_type', cur.document_type, 'document_number', cur.document_number, 'scan_name', cur.scan_name));
    elsif document_type is null and num is null and scan_path is null and nm is null then
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Nothing to change.', 'version', cur.version);
    elsif cur.verified_at is not null then
      r := jsonb_build_object('ok', false, 'code', 'eligibility_verified', 'message', 'This document is already verified.');
    else
      r := app.eligibility_invalid(x, player_id, document_type, num, scan_path, nm);
      if r is null then
        update app.eligibility_record e set document_type = coalesce(document_type, e.document_type),
          document_number = coalesce(num, e.document_number), scan_path = coalesce(scan_path, e.scan_path),
          scan_name = coalesce(nm, e.scan_name),
          scan_uploaded_at = case when scan_path is not null then now() else e.scan_uploaded_at end, version = e.version + 1
        where e.id = cur.id;
        r := jsonb_build_object('ok', true, 'code', null, 'message', 'Document updated.', 'version', cur.version + 1);
      end if;
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- remove_player: as in 0014_eligibility.sql, plus confirmed.
create or replace function app.remove_player(command_id uuid, team_id uuid, player_id uuid, expected_version int, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id, 'confirmed', confirmed));
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
      if not exists (select 1 from app.squad_entry s join app.team t on t.id = s.team_id
                     where s.player_id = cur.id and t.season_id = x.season_id) then
        delete from app.photo_consent pc where pc.player_id = cur.id and pc.season_id = x.season_id;
        delete from app.eligibility_record er where er.player_id = cur.id and er.season_id = x.season_id;
      end if;
      if not exists (select 1 from app.squad_entry s where s.player_id = cur.id) then
        delete from app.photo_consent pc where pc.player_id = cur.id;
        delete from app.eligibility_record er where er.player_id = cur.id;
        delete from app.player p where p.id = cur.id;
      end if;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Player removed.');
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- set_photo: as in 0015_player_photos.sql, plus confirmed.
create or replace function app.set_photo(
  command_id uuid, team_id uuid, person_id uuid, expected_version int, photo_path text, is_cutout boolean, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id, 'confirmed', confirmed));
  r jsonb;
  x app.team;
  kind text;
  v int;
  cut boolean;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id;
  if exists (select 1 from app.squad_entry s where s.team_id = team_id and s.player_id = person_id) then
    kind := 'player';
    select p.version, p.is_cutout into v, cut from app.player p where p.id = person_id for update;
  else
    select s.version, s.is_cutout into v, cut from app.staff s where s.id = person_id and s.team_id = team_id for update;
    if found then kind := 'staff'; end if;
  end if;
  if kind is null then
    r := jsonb_build_object('ok', false, 'code', 'person_missing', 'message', 'That person is not in this Team.');
  elsif v is distinct from expected_version then
    r := app.conflict(x.tournament_id, kind, person_id, v, jsonb_build_object('is_cutout', cut));
  elsif is_cutout is null or photo_path is null or photo_path !~ ('^' || x.tournament_id || '/' || x.id || '/' || person_id
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$') then
    r := jsonb_build_object('ok', false, 'code', 'photo_invalid', 'message', 'Photo didn''t upload. Try again.');
  else
    if kind = 'player' then
      update app.player p set photo_path = photo_path, is_cutout = is_cutout, version = p.version + 1 where p.id = person_id;
    else
      update app.staff s set photo_path = photo_path, is_cutout = is_cutout, version = s.version + 1 where s.id = person_id;
    end if;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Photo saved.', 'version', v + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- swap_fixtures: as in 0022_arrange_publish_fixtures.sql, plus confirmed.
create or replace function app.swap_fixtures(command_id uuid, season_id uuid, match_a uuid, version_a int, match_b uuid, version_b int, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_fixtures', jsonb_build_object('season_id', season_id, 'confirmed', confirmed));
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

-- set_kick_off: as in 0022_arrange_publish_fixtures.sql, plus confirmed.
create or replace function app.set_kick_off(command_id uuid, season_id uuid, match_id uuid, expected_version int, kick_off timestamptz, confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_fixtures', jsonb_build_object('season_id', season_id, 'confirmed', confirmed));
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

revoke all on function app.add_player(uuid, uuid, uuid, text, int, date, boolean, text, boolean),
  app.edit_player(uuid, uuid, uuid, int, text, int, date, boolean, text, boolean),
  app.add_staff(uuid, uuid, uuid, text, text, boolean),
  app.edit_staff(uuid, uuid, uuid, int, text, text, boolean),
  app.remove_staff(uuid, uuid, uuid, int, boolean),
  app.add_eligibility(uuid, uuid, uuid, uuid, text, text, text, text, boolean),
  app.edit_eligibility(uuid, uuid, uuid, int, text, text, text, text, boolean),
  app.remove_player(uuid, uuid, uuid, int, boolean),
  app.set_photo(uuid, uuid, uuid, int, text, boolean, boolean),
  app.swap_fixtures(uuid, uuid, uuid, int, uuid, int, boolean),
  app.set_kick_off(uuid, uuid, uuid, int, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function app.add_player(uuid, uuid, uuid, text, int, date, boolean, text, boolean),
  app.edit_player(uuid, uuid, uuid, int, text, int, date, boolean, text, boolean),
  app.add_staff(uuid, uuid, uuid, text, text, boolean),
  app.edit_staff(uuid, uuid, uuid, int, text, text, boolean),
  app.remove_staff(uuid, uuid, uuid, int, boolean),
  app.add_eligibility(uuid, uuid, uuid, uuid, text, text, text, text, boolean),
  app.edit_eligibility(uuid, uuid, uuid, int, text, text, text, text, boolean),
  app.remove_player(uuid, uuid, uuid, int, boolean),
  app.set_photo(uuid, uuid, uuid, int, text, boolean, boolean),
  app.swap_fixtures(uuid, uuid, uuid, int, uuid, int, boolean),
  app.set_kick_off(uuid, uuid, uuid, int, timestamptz, boolean)
  to authenticated;
