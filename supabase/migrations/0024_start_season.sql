-- 0024_start_season.sql: start the tournament (Story 3.5). app.start_check(season) is the one readiness decision, read by the
-- app (Organisers only) and by the command start_season, which moves registration -> started through the existing
-- app.season_transition table. Ready: at least two non-withdrawn Teams, every non-withdrawn Team approved, every approved Team in
-- the Draw (a League has none) and the Fixtures published. After start season_allows already refuses edit_draw, edit_setup,
-- edit_team, review_team and edit_fixtures (season_started). Nothing moves started back to registration.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

insert into app.season_action values ('start_season', 'registration') on conflict do nothing;

-- {ready, reason, teams:[{id, code}]}; reason is the first thing in the way, or the ready text; teams are the Teams it names.
-- null for a caller who is not an Organiser of the Season's Tournament (or no such Season).
create or replace function app.start_check(p_season_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  sn app.season;
  n_ok int;
  unapproved jsonb;
  unplaced jsonb;
  word text;
begin
  select * into sn from app.season x where x.id = p_season_id;
  if sn.id is null or not app.is_member(sn.tournament_id) then return null; end if;
  select count(*) into n_ok from app.team t where t.season_id = sn.id and t.status = 'approved';
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'code', t.code) order by t.code), '[]') into unapproved
  from app.team t where t.season_id = sn.id and t.status not in ('approved', 'withdrawn');
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'code', t.code) order by t.code), '[]') into unplaced
  from app.team t where t.season_id = sn.id and t.status = 'approved' and sn.structure is distinct from 'league'
    and not exists (select 1 from app.draw_slot d where d.team_id = t.id);

  if n_ok = 0 and jsonb_array_length(unapproved) = 0 then
    return jsonb_build_object('ready', false, 'reason', 'Can''t start yet: no Teams approved.', 'teams', '[]'::jsonb);
  elsif jsonb_array_length(unapproved) > 0 then
    select string_agg(e->>'code', ', ') into word from jsonb_array_elements(unapproved) e;
    return jsonb_build_object('ready', false, 'teams', unapproved, 'reason', case when jsonb_array_length(unapproved) = 1
      then format('Can''t start yet: 1 Team still needs approval (%s)', word)
      else format('Can''t start yet: %s Teams still need approval (%s)', jsonb_array_length(unapproved), word) end);
  elsif jsonb_array_length(unplaced) > 0 then
    select string_agg(e->>'code', ', ') into word from jsonb_array_elements(unplaced) e;
    return jsonb_build_object('ready', false, 'teams', unplaced, 'reason', case when jsonb_array_length(unplaced) = 1
      then format('Can''t start yet: 1 Team isn''t in the Draw (%s)', word)
      else format('Can''t start yet: %s Teams aren''t in the Draw (%s)', jsonb_array_length(unplaced), word) end);
  elsif n_ok < 2 then
    return jsonb_build_object('ready', false, 'reason', 'Can''t start yet: only 1 Team approved.', 'teams', '[]'::jsonb);
  elsif sn.fixtures_published_at is null then
    return jsonb_build_object('ready', false, 'reason', 'Can''t start yet: publish the Fixtures first.', 'teams', '[]'::jsonb);
  end if;
  return jsonb_build_object('ready', true, 'teams', '[]'::jsonb,
    'reason', format('Ready to start: %s Teams approved%s.', n_ok, case when sn.structure = 'league' then '' else ', Draw recorded' end));
end $$;

-- Starts the Season. Locks the row, re-runs start_check and refuses start_blocked with its reason as the message.
create or replace function app.start_season(command_id uuid, season_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'start_season', jsonb_build_object('season_id', season_id));
  r jsonb;
  c jsonb;
begin
  if denied is not null then
    -- A repeat of the command that started the Season finds the Season started: answer it as the first time did.
    if denied = 'season_started' then
      select c.result into r from app.command_result c where c.actor = actor and c.command_id = command_id and c.result is not null;
      if r is not null then return r; end if;
    end if;
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  perform 1 from app.season x where x.id = season_id for update;
  c := app.start_check(season_id);
  if not (c->>'ready')::boolean then
    r := jsonb_build_object('ok', false, 'code', 'start_blocked', 'message', c->>'reason');
  else
    update app.season x set status = 'started' where x.id = season_id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'The tournament has started.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.start_check(uuid), app.start_season(uuid, uuid) from public, anon, authenticated;
grant execute on function app.start_check(uuid), app.start_season(uuid, uuid) to authenticated;
