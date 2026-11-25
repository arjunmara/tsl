-- 0045_copy_tsl_season_1.sql: copy TSL Season 1 from the legacy public tables into the new app (Story 6.5). Run as `postgres` in the Supabase SQL Editor, test first, then live.
--
-- BEFORE RUN: replace PUT-YOUR-EMAIL-HERE below with the email you sign in to the new app with (do not commit it). The Tournament is created under that account.
-- On tsl-test, first paste the legacy files in this order: supabase/schema.sql, season1.sql, 002_console.sql, 003_group_order.sql. Without public.matches the copy is skipped with a notice.
-- The two schema changes below (optional shirt number, actor_name) always apply; they are safe to repeat. Only the copy itself is skipped or refused
-- (no legacy tables, placeholder email, or email not found in auth.users: it raises and inserts nothing).
--
-- The legacy tables are only read. Every id is a UUID v5 of the legacy id and every insert is `on conflict do nothing`, so running it again adds nothing.
-- The score comes only from the goal events (the existing trigger). Sponsors, dates, Season awards and Man of the Match are not copied; Players get no shirt numbers,
-- photos, consent or Eligibility rows. Activity log rows all carry the actor "Season 1 copy" and one command id.
select set_config('tsl.owner_email', 'PUT-YOUR-EMAIL-HERE', false);

create extension if not exists "uuid-ossp" schema extensions;

-- Copied Squads have no shirt numbers. Commands still require one for a new Player.
alter table app.squad_entry alter column shirt_number drop not null;

-- The fixed actor of the copy is named in the Activity log. Same body as 0028 plus one branch.
create or replace function app.actor_name(p_tournament_id uuid, p_actor uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when not app.is_member(p_tournament_id) then null
    when p_actor is null then 'System'
    when p_actor = '5ea50001-0000-4000-8000-000000000001' then 'Season 1 copy'
    when u.is_anonymous then coalesce(
      (select d.label from app.scorer_device d where d.user_id = p_actor and d.tournament_id = p_tournament_id order by d.created_at desc limit 1),
      'Team manager' || coalesce((select ' (' || t.code || ')' from app.registration_grant g
        join app.team t on t.id = g.team_id where g.id = p_actor), ''))
    else coalesce(u.email, 'Unknown')
  end
  from (select 1) x left join auth.users u on u.id = p_actor
$$;

do $copy$
declare
  ns constant uuid := '7a5f1c3e-91d4-4b6a-8e2f-5c0d7b1a9e34';
  actor constant uuid := '5ea50001-0000-4000-8000-000000000001';
  cmd constant uuid := extensions.uuid_generate_v5(ns, 'tsl-s1:command');
  tid constant uuid := extensions.uuid_generate_v5(ns, 'tsl-s1:tournament');
  sid constant uuid := extensions.uuid_generate_v5(ns, 'tsl-s1:season:1');
  owner_mail text := lower(btrim(current_setting('tsl.owner_email', true)));
  owner uuid;
  missing text;
begin
  select string_agg(t, ', ') into missing
  from unnest(array['matches', 'goals', 'events', 'teams', 'players', 'season_teams', 'squad']) t
  where to_regclass('public.' || t) is null;
  if missing is not null then
    raise notice 'No legacy tables (missing: %): nothing copied.', missing;
    return;
  end if;
  if not exists (select 1 from public.matches where season = 1) then
    raise notice 'Legacy Season 1 has no matches: nothing copied.';
    return;
  end if;

  if owner_mail is null or owner_mail in ('', 'put-your-email-here') then
    raise exception 'Set tsl.owner_email: replace PUT-YOUR-EMAIL-HERE on the first line with your sign-in email, then run again.';
  end if;
  select u.id into owner from auth.users u where lower(u.email) = owner_mail limit 1;
  if owner is null then
    raise exception 'No account with that email in auth.users: sign in to the new app once with it, then run again.';
  end if;

  perform set_config('app.actor', actor::text, true), set_config('app.command_id', cmd::text, true);

  insert into app.tournament (id, name) values (tid, 'Tamghas Super League') on conflict do nothing;
  insert into app.organiser_membership (tournament_id, user_id) values (tid, owner) on conflict do nothing;

  insert into app.season (id, tournament_id, number, status, setup_step, fixtures_published_at, format_preset, periods, period_minutes, clock,
    half_time_minutes, extra_time, extra_time_periods, extra_time_minutes, shootout, substitutions, max_substitutions, foul_warning,
    timeouts_per_period, power_play_minutes, starters, max_bench, structure, group_count, teams_per_group, qualifiers_per_group,
    points_win, points_draw, points_loss)
  select sid, tid, 1, 'finished', 7, now(), p.key, p.periods, p.period_minutes, p.clock, p.half_time_minutes, p.extra_time, p.extra_time_periods,
    p.extra_time_minutes, p.shootout, p.substitutions, p.max_substitutions, p.foul_warning, p.timeouts_per_period, p.power_play_minutes,
    p.starters, p.max_bench, 'groups_knockout', 4, 4, 2, 3, 1, 0
  from app.format_preset p where p.key = 'futsal'
  on conflict do nothing;

  -- Teams, and their draw slots (group letter -> number, draw order -> position).
  insert into app.team (id, tournament_id, season_id, name, code, kit_colour, status)
  select extensions.uuid_generate_v5(ns, 'tsl-s1:team:' || t.id), tid, sid, t.name, t.code, t.kit, 'approved'
  from public.teams t where t.id in (select team from public.season_teams where season = 1)
  on conflict do nothing;

  insert into app.draw_slot (id, tournament_id, season_id, grp, pos, team_id)
  select extensions.uuid_generate_v5(ns, 'tsl-s1:draw_slot:' || s.team), tid, sid, ascii(s.grp) - 64,
    row_number() over (partition by s.grp order by s.sort, s.team), extensions.uuid_generate_v5(ns, 'tsl-s1:team:' || s.team)
  from public.season_teams s where s.season = 1 and s.grp is not null
  on conflict do nothing;

  -- Squads: Coach and Manager become Staff, everyone else a Player with a Squad entry (name only, no shirt number).
  insert into app.player (id, tournament_id, name)
  select extensions.uuid_generate_v5(ns, 'tsl-s1:player:' || q.player), tid, btrim(p.name)
  from public.squad q join public.players p on p.id = q.player
  where q.season = 1 and coalesce(q.role, '') not in ('Coach', 'Manager')
  on conflict do nothing;

  insert into app.squad_entry (id, tournament_id, team_id, player_id)
  select extensions.uuid_generate_v5(ns, 'tsl-s1:squad:' || q.player), tid, extensions.uuid_generate_v5(ns, 'tsl-s1:team:' || q.team),
    extensions.uuid_generate_v5(ns, 'tsl-s1:player:' || q.player)
  from public.squad q where q.season = 1 and coalesce(q.role, '') not in ('Coach', 'Manager')
  on conflict do nothing;

  insert into app.staff (id, tournament_id, team_id, name, role)
  select extensions.uuid_generate_v5(ns, 'tsl-s1:staff:' || q.player), tid, extensions.uuid_generate_v5(ns, 'tsl-s1:team:' || q.team),
    btrim(p.name), lower(q.role)
  from public.squad q join public.players p on p.id = q.player
  where q.season = 1 and q.role in ('Coach', 'Manager')
  on conflict do nothing;

  -- Matches: finished, stored Team ids, no source labels, score left at 0 until the goal events arrive.
  insert into app.match (id, tournament_id, season_id, stage, round, label, ord, home_team_id, away_team_id, status, hg, ag, home_pens, away_pens)
  select extensions.uuid_generate_v5(ns, 'tsl-s1:match:' || m.id), tid, sid,
    case when m.round = 'Group' then 'group' else 'knockout' end,
    case when m.round = 'Group' then 'Group ' || (select s.grp from public.season_teams s where s.season = m.season and s.team = m.home)
         else m.round end,
    case when m.round = 'Group' then null when m.round = 'Final' then 'Final'
         else m.round || row_number() over (partition by m.round order by m.n) end,
    m.n, extensions.uuid_generate_v5(ns, 'tsl-s1:team:' || m.home), extensions.uuid_generate_v5(ns, 'tsl-s1:team:' || m.away),
    'finished', 0, 0, m.hp, m.ap
  from public.matches m where m.season = 1
  on conflict (id) do nothing;

  -- Goals: every legacy goal (no player = own goal when og, else unknown scorer), then unknown scorers up to each side's legacy score.
  insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at, team_id, player_id, own_goal)
  select extensions.uuid_generate_v5(ns, 'tsl-s1:goal:' || g.id), tid, sid, extensions.uuid_generate_v5(ns, 'tsl-s1:match:' || g.match), 'goal', 1,
    coalesce(g.minute, 0), now(), extensions.uuid_generate_v5(ns, 'tsl-s1:team:' || g.team),
    extensions.uuid_generate_v5(ns, 'tsl-s1:player:' || g.player), g.player is null and g.og
  from public.goals g join public.matches m on m.id = g.match and m.season = 1
  on conflict do nothing;

  insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at, team_id, own_goal)
  select extensions.uuid_generate_v5(ns, 'tsl-s1:topup:' || m.id || ':' || w.team || ':' || i), tid, sid,
    extensions.uuid_generate_v5(ns, 'tsl-s1:match:' || m.id), 'goal', 1, 0, now(), extensions.uuid_generate_v5(ns, 'tsl-s1:team:' || w.team), false
  from public.matches m
  cross join lateral (values (m.home, m.hg), (m.away, m.ag)) w(team, want)
  cross join lateral generate_series((select count(*) from public.goals g where g.match = m.id and g.team = w.team) + 1, w.want) i
  where m.season = 1
  on conflict do nothing;

  -- Cards and missed penalties. Penalty Saved and Injury are not copied.
  insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at, team_id, player_id, card)
  select extensions.uuid_generate_v5(ns, 'tsl-s1:event:' || e.id), tid, sid, extensions.uuid_generate_v5(ns, 'tsl-s1:match:' || e.match),
    case when e.kind = 'Penalty Missed' then 'missed_penalty' else 'card' end, 1, coalesce(e.minute, 0), now(),
    extensions.uuid_generate_v5(ns, 'tsl-s1:team:' || e.team), extensions.uuid_generate_v5(ns, 'tsl-s1:player:' || e.player),
    case e.kind when 'Yellow Card' then 'yellow' when 'Red Card' then 'red' when 'Second Yellow' then 'red' end
  from public.events e join public.matches m on m.id = e.match and m.season = 1
  where e.kind in ('Yellow Card', 'Red Card', 'Second Yellow', 'Penalty Missed')
  on conflict do nothing;
end
$copy$;
