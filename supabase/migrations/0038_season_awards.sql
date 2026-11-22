-- 0038_season_awards.sql: Season awards and the top-scorers read (Story 5.6, FR-31, FR-38, AR-21, AR-22). app.season_awards holds the two awards an
-- Organiser picks, Best Goalkeeper and Player of the Tournament (one row per Season and award). The Top Scorer is derived, never stored:
-- app.season_top_scorers counts each Player's undeleted goals (own goals and unknown scorers excluded). set_season_award sets or changes an
-- award (an Organiser, while the Season is started or finished; the Player must be in a Squad of that Season, else player_invalid; a stale
-- expected_version, or none for an award already set, is a version_conflict). The change shows in the Activity log. The founder applies this
-- in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

create table if not exists app.season_awards (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references app.tournament (id),
  season_id uuid not null references app.season (id),
  award text not null check (award in ('best_goalkeeper', 'player_of_tournament')),
  player_id uuid not null references app.player (id),
  version int not null default 1,
  unique (season_id, award)
);

create or replace trigger log_change after insert or update or delete on app.season_awards
  for each row execute function app.log_change('tournament_id', '{}');

alter table app.season_awards enable row level security;
drop policy if exists organiser_read on app.season_awards;
create policy organiser_read on app.season_awards for select to authenticated using (app.is_member(tournament_id));
revoke all on app.season_awards from public, anon, authenticated;
grant select on app.season_awards to authenticated;

insert into app.season_action (action, status) values ('set_season_award', 'started'), ('set_season_award', 'finished') on conflict do nothing;

-- The Season's scorers: player_id, the Team they scored for and their goals. Not ranked here (the Graphic ranks and breaks ties by name).
create or replace function app.season_top_scorers(p_season_id uuid)
returns table (player_id uuid, team_id uuid, goals int)
language sql stable security definer set search_path = '' as $$
  select e.player_id, (array_agg(e.team_id order by e.entered_at desc))[1], count(*)::int
  from app.match_event e
  where e.season_id = p_season_id and e.kind = 'goal' and e.deleted_at is null and e.player_id is not null and not e.own_goal
    and app.is_member((select x.tournament_id from app.season x where x.id = p_season_id))
  group by e.player_id
$$;

create or replace function app.set_season_award(command_id uuid, season_id uuid, award text, player_id uuid, expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'set_season_award', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.season_awards;
  t uuid;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);
  select x.tournament_id into t from app.season x where x.id = season_id for update;
  select * into cur from app.season_awards x where x.season_id = season_id and x.award = award for update;
  if award is null or award not in ('best_goalkeeper', 'player_of_tournament') then
    r := jsonb_build_object('ok', false, 'code', 'award_invalid', 'message', 'That award doesn''t exist.');
  elsif player_id is null or not exists (select 1 from app.squad_entry s join app.team m on m.id = s.team_id
      where m.season_id = season_id and m.status = 'approved' and s.player_id = player_id) then
    r := jsonb_build_object('ok', false, 'code', 'player_invalid', 'message', 'That Player is not in an approved Team''s Squad of this Season.');
  elsif cur.id is null then
    insert into app.season_awards (tournament_id, season_id, award, player_id) values (t, season_id, award, player_id);
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Award saved.', 'version', 1);
  elsif cur.version is distinct from expected_version then
    r := app.conflict(t, 'season_awards', cur.id, cur.version, jsonb_build_object('player_id', cur.player_id));
  else
    update app.season_awards x set player_id = player_id, version = x.version + 1 where x.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Award saved.', 'version', cur.version + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.season_top_scorers(uuid), app.set_season_award(uuid, uuid, text, uuid, int) from public, anon, authenticated;
grant execute on function app.season_top_scorers(uuid), app.set_season_award(uuid, uuid, text, uuid, int) to authenticated;
