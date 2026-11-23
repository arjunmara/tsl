-- 0042_returning_teams.sql: returning Teams get pre-filled Registration links (Story 6.2, FR-49). Adds app.team.returning_from (the previous
-- Season's Team row) and one command, add_returning_teams: for each ticked Team of the previous Season it creates a new Team with the same
-- name, code and kit colour, its own new Registration link, the same Players in its Squad (same shirt numbers, never new Player rows),
-- copies of its Staff, and the previous Season's Photo consent and Eligibility records as recorded but without scans. The source Season is not
-- touched. Photo consent is copied only when both Seasons use the same consent statement. At most 64 Teams per command. All-or-nothing. The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.team add column if not exists returning_from uuid references app.team (id);
create index if not exists team_returning_from_idx on app.team (returning_from);

insert into app.season_action values ('add_returning_teams', 'setup'), ('add_returning_teams', 'registration') on conflict do nothing;

-- teams: [{from_team_id, team_id, link_id, token_hash}]. A refused row (returning_team_invalid, already_returned, team_code_taken, token_invalid)
-- refuses the whole command: everything is inside one sub-transaction that rolls back. The answer carries no version.
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
      select s.tournament_id, tid, s.player_id, s.shirt_number from app.squad_entry s where s.team_id = f.id;
      insert into app.staff (id, tournament_id, team_id, name, role, photo_path, is_cutout)
      select gen_random_uuid(), s.tournament_id, tid, s.name, s.role, s.photo_path, s.is_cutout from app.staff s where s.team_id = f.id;
      insert into app.photo_consent (tournament_id, player_id, season_id, consent_given, given_by)
      select c.tournament_id, c.player_id, season_id, c.consent_given, c.given_by from app.photo_consent c
      where c.season_id = src and cur.photo_consent = (select y.photo_consent from app.season y where y.id = src)
        and c.player_id in (select s.player_id from app.squad_entry s where s.team_id = f.id)
      on conflict do nothing;
      insert into app.eligibility_record (id, tournament_id, player_id, season_id, document_type, document_number, verified_by, verified_at)
      select gen_random_uuid(), e.tournament_id, e.player_id, season_id, e.document_type, e.document_number, e.verified_by, e.verified_at
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
