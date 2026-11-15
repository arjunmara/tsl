-- 0027_finish_season.sql: finish the season (Story 3.8). app.finish_check(season) is the one readiness decision, read by the app
-- (Organisers only) and by the command finish_season, which moves started -> finished through the existing app.season_transition
-- table. Ready: the Season is started, has at least one Match and every Match is finished. A finished Season has no season_action
-- rows, so season_allows already answers season_finished for every Squad, Fixture, shootout and setup command, confirmed or not.
-- The existing deletion job (scans_to_delete, 0019) already lists a finished Season's unverified scans. Nothing unfinishes.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

insert into app.season_action values ('finish_season', 'started') on conflict do nothing;

-- {ready, reason}; null for a caller who is not an Organiser of the Season's Tournament (or no such Season).
create or replace function app.finish_check(p_season_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  sn app.season;
  n_all int;
  n_open int;
begin
  select * into sn from app.season x where x.id = p_season_id;
  if sn.id is null or not app.is_member(sn.tournament_id) then return null; end if;
  select count(*), count(*) filter (where m.status <> 'finished') into n_all, n_open from app.match m where m.season_id = sn.id;
  if sn.status <> 'started' then
    return jsonb_build_object('ready', false, 'reason', 'Can''t finish yet: the season hasn''t started.');
  elsif n_all = 0 then
    return jsonb_build_object('ready', false, 'reason', 'Can''t finish yet: there are no Matches.');
  elsif n_open = 1 then
    return jsonb_build_object('ready', false, 'reason', 'Can''t finish yet: 1 Match isn''t finished.');
  elsif n_open > 1 then
    return jsonb_build_object('ready', false, 'reason', format('Can''t finish yet: %s Matches aren''t finished.', n_open));
  end if;
  return jsonb_build_object('ready', true, 'reason', 'Ready to finish: every Match is finished.');
end $$;

-- Finishes the Season. Locks the row, re-runs finish_check and refuses finish_blocked with its reason as the message.
create or replace function app.finish_season(command_id uuid, season_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'finish_season', jsonb_build_object('season_id', season_id));
  r jsonb;
  c jsonb;
begin
  if denied is not null then
    -- A repeat of the command that finished the Season finds it finished: answer it as the first time did.
    if denied = 'season_finished' then
      select c.result into r from app.command_result c where c.actor = actor and c.command_id = command_id and c.result is not null;
      if r is not null then return r; end if;
    end if;
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  perform 1 from app.season x where x.id = season_id for update;
  c := app.finish_check(season_id);
  if not (c->>'ready')::boolean then
    r := jsonb_build_object('ok', false, 'code', 'finish_blocked', 'message', c->>'reason');
  else
    update app.season x set status = 'finished' where x.id = season_id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'The season has finished.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.finish_check(uuid), app.finish_season(uuid, uuid) from public, anon, authenticated;
grant execute on function app.finish_check(uuid), app.finish_season(uuid, uuid) to authenticated;
