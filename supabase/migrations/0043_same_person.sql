-- 0043_same_person.sql: "Same person as last year?" for a Player who changed Team (Story 6.3, FR-50). app.player gets merged_into (this row is an
-- alias of an earlier Player of the Tournament) and same_as (a manager's pending suggestion). Nothing is deleted or repointed: a merged row stays
-- a valid id, so queued commands that use it keep working, and reads that count per person group by app.player_root(id) = coalesce(merged_into, id).
-- Merge targets are always roots (single level). Adds app.same_person_candidates (a read for the Team's manager or the Tournament's Organisers: name,
-- last Team code and Season only), suggest_same_person (a manager, with edit_squad rights) and answer_same_person (an Organiser at review).
-- season_top_scorers counts per root; add_returning_teams copies root ids into the new Squad. The founder applies this in the Supabase SQL Editor
-- as `postgres`: test first, then live. Safe to run twice.

alter table app.player add column if not exists merged_into uuid references app.player (id), add column if not exists same_as uuid references app.player (id);
alter table app.player drop constraint if exists player_same_as_fkey,
  add constraint player_same_as_fkey foreign key (same_as) references app.player (id) on delete set null;
alter table app.player drop constraint if exists player_merge_check,
  add constraint player_merge_check check (merged_into is distinct from id and same_as is distinct from id);
create index if not exists player_merged_into_idx on app.player (merged_into);

-- The person a Player id stands for. Not callable by clients (the definer functions below call it as the owner).
create or replace function app.player_root(p uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce((select x.merged_into from app.player x where x.id = p), p)
$$;

-- Up to 5 earlier Players of this Tournament with exactly this name (case and outer spaces ignored) who played in an earlier Season for a Team with
-- another code, and are not already in this Team's Squad. Their latest such appearance. Nothing else about them. No rows for anyone else.
create or replace function app.same_person_candidates(p_team_id uuid, p_name text)
returns table (player_id uuid, name text, team_code text, season_number int)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, a.code, a.number
  from app.team t
  join app.season ts on ts.id = t.season_id
  join app.player p on p.tournament_id = t.tournament_id and p.merged_into is null and lower(btrim(p.name)) = lower(btrim(p_name))
  cross join lateral (
    select m.code, se.number from app.squad_entry e join app.team m on m.id = e.team_id join app.season se on se.id = m.season_id
    where e.player_id = p.id and se.tournament_id = t.tournament_id and se.number < ts.number and m.code <> t.code
    order by se.number desc limit 1) a
  where t.id = p_team_id and (t.id = app.granted_team() or app.is_member(t.tournament_id))
    and not exists (select 1 from app.squad_entry c where c.team_id = t.id and app.player_root(c.player_id) = p.id)
  order by a.number desc, p.name, p.id
  limit 5
$$;

-- suggest_same_person: the manager says a Player of their Squad is a candidate from the lookup (or, with a null candidate, "No"). Only a pending suggestion.
create or replace function app.suggest_same_person(command_id uuid, team_id uuid, player_id uuid, candidate_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_squad', jsonb_build_object('team_id', team_id));
  r jsonb;
  cur app.player;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select p.* into cur from app.player p join app.squad_entry s on s.player_id = p.id and s.team_id = team_id where p.id = player_id for update of p;
  if cur.id is null then
    r := jsonb_build_object('ok', false, 'code', 'player_missing', 'message', 'That Player is not in this Squad.');
  elsif candidate_id is null then
    update app.player p set same_as = null where p.id = cur.id and p.same_as is not null;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Saved.');
  elsif cur.merged_into is not null or not exists (select 1 from app.same_person_candidates(team_id, cur.name) c where c.player_id = candidate_id) then
    r := jsonb_build_object('ok', false, 'code', 'candidate_invalid', 'message', 'That is not an earlier Player with this name.');
  else
    update app.player p set same_as = candidate_id where p.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Saved.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- answer_same_person: an Organiser confirms (merged_into = the suggested Player's root) or rejects (suggestion cleared). Bumps the Player's version.
create or replace function app.answer_same_person(command_id uuid, team_id uuid, player_id uuid, same boolean, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'review_team', jsonb_build_object('team_id', team_id));
  r jsonb;
  cur app.player;
  root uuid;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select p.* into cur from app.player p join app.squad_entry s on s.player_id = p.id and s.team_id = team_id where p.id = player_id for update of p;
  if cur.id is null then
    r := jsonb_build_object('ok', false, 'code', 'player_missing', 'message', 'That Player is not in this Squad.');
  elsif cur.same_as is null or cur.merged_into is not null or same is null then
    r := jsonb_build_object('ok', false, 'code', 'no_suggestion', 'message', 'There is no same-person question for this Player.');
  elsif cur.version is distinct from expected_version then
    r := app.conflict(cur.tournament_id, 'player', cur.id, cur.version, jsonb_build_object('name', cur.name, 'same_as', cur.same_as));
  elsif same and (app.player_root(cur.same_as) = cur.id
      or not exists (select 1 from app.same_person_candidates(team_id, cur.name) c where c.player_id = cur.same_as)
      or exists (select 1 from app.squad_entry s join app.team m on m.id = s.team_id
        where m.season_id = (select t.season_id from app.team t where t.id = team_id) and app.player_root(s.player_id) = cur.same_as)) then
    r := jsonb_build_object('ok', false, 'code', 'candidate_invalid', 'message', 'That Player can''t be linked any more. Answer Not the same person.');
  else
    if same then
      root := cur.same_as;
      update app.player p set merged_into = root, same_as = null, version = p.version + 1 where p.id = cur.id;
      -- Keep it single level: anything already merged into this Player now points at the root.
      update app.player p set merged_into = root where p.merged_into = cur.id;
    else
      update app.player p set same_as = null, version = p.version + 1 where p.id = cur.id;
    end if;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Saved.', 'version', cur.version + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- season_top_scorers: as in 0038_season_awards.sql, counted per person (root); player_id is the row in this Season's Squad (the alias), else the root.
create or replace function app.season_top_scorers(p_season_id uuid)
returns table (player_id uuid, team_id uuid, goals int)
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.player_id from app.squad_entry s join app.team m on m.id = s.team_id
      where m.season_id = p_season_id and app.player_root(s.player_id) = g.root order by s.created_at desc, s.player_id limit 1), g.root), g.team_id, g.goals
  from (
    select app.player_root(e.player_id) as root, (array_agg(e.team_id order by e.entered_at desc))[1] as team_id, count(*)::int as goals
    from app.match_event e
    where e.season_id = p_season_id and e.kind = 'goal' and e.deleted_at is null and e.player_id is not null and not e.own_goal
      and app.is_member((select x.tournament_id from app.season x where x.id = p_season_id))
    group by app.player_root(e.player_id)) g
$$;

revoke all on function app.player_root(uuid), app.same_person_candidates(uuid, text), app.suggest_same_person(uuid, uuid, uuid, uuid),
  app.answer_same_person(uuid, uuid, uuid, boolean, int), app.season_top_scorers(uuid) from public, anon, authenticated;
grant execute on function app.same_person_candidates(uuid, text), app.suggest_same_person(uuid, uuid, uuid, uuid),
  app.answer_same_person(uuid, uuid, uuid, boolean, int), app.season_top_scorers(uuid) to authenticated;

-- add_returning_teams: as in 0042_returning_teams.sql, but the new Squad (and the copied consent and Eligibility) use each Player's root, so the next Season uses the surviving Player.
create or replace function app.add_returning_teams(command_id uuid, season_id uuid, teams jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'add_returning_teams', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.season;
  src uuid;
  item jsonb;
  f app.team;
  tid uuid;
  lid uuid;
  h text;
  n int := 0;
  k text;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.season x where x.id = season_id for update;
  denied := app.season_allows(season_id, 'add_returning_teams');
  if denied is not null then
    r := jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
    perform app.finish_command(actor, command_id, r);
    return r;
  end if;
  select x.id into src from app.season x where x.tournament_id = cur.tournament_id and x.number = cur.number - 1;
  begin
    if jsonb_typeof(teams) is distinct from 'array' or jsonb_array_length(teams) not between 1 and 64 then
      raise exception using errcode = 'P0001', message = 'returning_team_invalid';
    end if;
    for item in select * from jsonb_array_elements(teams) loop
      begin
        tid := (item ->> 'team_id')::uuid; lid := (item ->> 'link_id')::uuid; h := item ->> 'token_hash';
        select * into f from app.team x where x.id = (item ->> 'from_team_id')::uuid and x.season_id = src;
      exception when invalid_text_representation then
        raise exception using errcode = 'P0001', message = 'returning_team_invalid';
      end;
      if f.id is null then
        raise exception using errcode = 'P0001', message = 'returning_team_invalid';
      elsif tid is null or lid is null or h is null or h !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = 'P0001', message = 'token_invalid';
      elsif exists (select 1 from app.team x where x.season_id = season_id and x.returning_from = f.id) then
        raise exception using errcode = 'P0001', message = 'already_returned';
      elsif exists (select 1 from app.team x where x.season_id = season_id and x.code = f.code) then
        raise exception using errcode = 'P0001', message = 'team_code_taken';
      end if;
      insert into app.team (id, tournament_id, season_id, name, code, kit_colour, returning_from)
      values (tid, cur.tournament_id, season_id, f.name, f.code, f.kit_colour, f.id);
      insert into app.registration_link (id, tournament_id, team_id, token_hash, created_by)
      values (lid, cur.tournament_id, tid, h, actor);
      insert into app.squad_entry (tournament_id, team_id, player_id, shirt_number)
      select distinct on (app.player_root(s.player_id)) s.tournament_id, tid, app.player_root(s.player_id), s.shirt_number from app.squad_entry s where s.team_id = f.id
      order by app.player_root(s.player_id), s.shirt_number;
      insert into app.staff (id, tournament_id, team_id, name, role, photo_path, is_cutout)
      select gen_random_uuid(), s.tournament_id, tid, s.name, s.role, s.photo_path, s.is_cutout from app.staff s where s.team_id = f.id;
      insert into app.photo_consent (tournament_id, player_id, season_id, consent_given, given_by)
      select c.tournament_id, app.player_root(c.player_id), season_id, c.consent_given, c.given_by from app.photo_consent c
      where c.season_id = src and cur.photo_consent = (select y.photo_consent from app.season y where y.id = src)
        and c.player_id in (select s.player_id from app.squad_entry s where s.team_id = f.id)
      on conflict do nothing;
      insert into app.eligibility_record (id, tournament_id, player_id, season_id, document_type, document_number, verified_by, verified_at)
      select gen_random_uuid(), e.tournament_id, app.player_root(e.player_id), season_id, e.document_type, e.document_number, e.verified_by, e.verified_at
      from app.eligibility_record e
      where e.season_id = src and e.player_id in (select s.player_id from app.squad_entry s where s.team_id = f.id)
      on conflict do nothing;
      n := n + 1;
    end loop;
    r := jsonb_build_object('ok', true, 'code', null, 'message', n || case when n = 1 then ' Team added.' else ' Teams added.' end);
  exception
    when raise_exception then
      get stacked diagnostics k = message_text;
      if k <> all (array['returning_team_invalid', 'already_returned', 'team_code_taken', 'token_invalid']) then raise; end if;
      r := jsonb_build_object('ok', false, 'code', k, 'message', case k
        when 'already_returned' then 'That Team was already added to this Season.'
        when 'team_code_taken' then 'That Team code is already used in this Season.'
        when 'token_invalid' then 'The link is not valid.'
        else 'That Team is not in the previous Season.' end);
    when unique_violation then
      get stacked diagnostics k = constraint_name;
      r := case when k = 'team_season_code_idx'
        then jsonb_build_object('ok', false, 'code', 'team_code_taken', 'message', 'That Team code is already used in this Season.')
        else jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.') end;
  end;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.add_returning_teams(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function app.add_returning_teams(uuid, uuid, jsonb) to authenticated;

-- approve_team: as in 0017_review_teams.sql, but refused with same_person_pending while a Player of the Team has a suggestion waiting.
create or replace function app.approve_team(command_id uuid, team_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'review_team', jsonb_build_object('team_id', team_id));
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
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Already approved.');
  elsif x.status = 'withdrawn' then
    r := jsonb_build_object('ok', false, 'code', 'team_withdrawn', 'message', 'This Team was withdrawn.');
  elsif x.status <> 'submitted' then
    r := jsonb_build_object('ok', false, 'code', 'team_not_submitted', 'message', 'This Team has not been sent for review.');
  elsif exists (select 1 from app.player p join app.squad_entry e on e.player_id = p.id
      where e.team_id = x.id and p.same_as is not null and p.merged_into is null) then
    r := jsonb_build_object('ok', false, 'code', 'same_person_pending', 'message', 'Answer each same-person question first.');
  elsif cardinality(why) > 0 then
    r := jsonb_build_object('ok', false, 'code', 'lineup_violation', 'message', array_to_string(why, ' '));
  else
    update app.team t set status = 'approved' where t.id = x.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Approved.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;


-- remove_player: as in 0025_confirm_after_start.sql, but the Player row stays while another Player is merged into it.
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
        delete from app.player p where p.id = cur.id and not exists (select 1 from app.player a where a.merged_into = cur.id);
      end if;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Player removed.');
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;


-- erase_player_personal_data: as in 0019_erase_personal_data.sql, but for the whole person: the root and every alias merged into it.
create or replace function app.erase_player_personal_data(command_id uuid, team_id uuid, player_id uuid, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  -- Authorised on the Tournament, not the Team: a withdrawn Team or a started Season doesn't stop an erase.
  denied text := app.authorize(actor, 'erase_personal_data',
    jsonb_build_object('tournament_id', (select t.tournament_id from app.team t where t.id = team_id)));
  r jsonb;
  e app.squad_entry;
  cur app.player;
  numbers text[];
  givers text[];
  grp uuid[];
  dobs text[];
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true),
          set_config('app.reason', 'Personal details deleted on request', true);

  select * into e from app.squad_entry s where s.team_id = team_id and s.player_id = player_id;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'player_missing', 'message', 'That Player is not in this Squad.');
  else
    select * into cur from app.player p where p.id = player_id for update;
    -- Everyone the same person: the root and every alias of it.
    select array_agg(p.id), array_agg(p.date_of_birth::text) filter (where p.date_of_birth is not null) into grp, dobs
      from app.player p where p.tournament_id = cur.tournament_id and app.player_root(p.id) = app.player_root(cur.id);
    select array_agg(er.document_number) filter (where er.document_number is not null) into numbers
      from app.eligibility_record er where er.player_id = any (grp);
    select array_agg(pc.given_by) filter (where pc.given_by is not null) into givers
      from app.photo_consent pc where pc.player_id = any (grp);
    if not exists (select 1 from app.player p where p.id = any (grp) and (p.date_of_birth is not null or p.photo_path is not null)) and numbers is null and givers is null
        and not exists (select 1 from app.eligibility_record er where er.player_id = any (grp) and er.scan_path is not null)
        and not exists (select 1 from storage.objects o where o.bucket_id in ('player-photos', 'eligibility-scans')
          and split_part(o.name, '/', 1) = cur.tournament_id::text and split_part(o.name, '/', 3) = any (grp::text[])
          and not app.file_queued(o.bucket_id, o.name)) then
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Nothing left to delete.', 'version', cur.version);
    elsif cur.version is distinct from expected_version then
      r := app.conflict(cur.tournament_id, 'player', cur.id, cur.version,
        jsonb_build_object('name', cur.name, 'shirt_number', e.shirt_number));
    else
      insert into app.file_to_delete (bucket_id, name)
        select o.bucket_id, o.name from storage.objects o
        where o.bucket_id in ('player-photos', 'eligibility-scans')
          and split_part(o.name, '/', 1) = cur.tournament_id::text and split_part(o.name, '/', 3) = any (grp::text[])
        on conflict do nothing;
      update app.eligibility_record er set document_number = null, scan_path = null, scan_name = null, scan_uploaded_at = null,
          version = er.version + 1
        where er.player_id = any (grp) and (er.document_number is not null or er.scan_path is not null);
      update app.photo_consent pc set consent_given = false, given_by = null where pc.player_id = any (grp) and pc.given_by is not null;
      update app.player p set date_of_birth = null, photo_path = null, is_cutout = null, version = p.version + 1 where p.id = any (grp);
      -- Stored answers whose conflict envelope carried one of the erased values (edit_player, remove_player,
      -- edit_eligibility, verify_eligibility) keep everything but that copy. The envelope names no row, so this matches
      -- by value: another Player's copy of the same value goes too, which only drops an old snapshot.
      update app.command_result c set result = c.result #- '{conflict,current}'
        where c.result -> 'conflict' -> 'current' is not null
          and (c.result -> 'conflict' -> 'current' ->> 'date_of_birth' = any (coalesce(dobs, '{}'))
            or c.result -> 'conflict' -> 'current' ->> 'given_by' = any (coalesce(givers, '{}'))
            or c.result -> 'conflict' -> 'current' ->> 'document_number' = any (coalesce(numbers, '{}')));
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Personal details deleted.', 'version', cur.version + 1);
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;


revoke all on function app.approve_team(uuid, uuid), app.remove_player(uuid, uuid, uuid, int, boolean), app.erase_player_personal_data(uuid, uuid, uuid, int)
  from public, anon, authenticated, service_role;
grant execute on function app.approve_team(uuid, uuid), app.remove_player(uuid, uuid, uuid, int, boolean), app.erase_player_personal_data(uuid, uuid, uuid, int) to authenticated;
