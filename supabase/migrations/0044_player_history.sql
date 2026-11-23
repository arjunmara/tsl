-- 0044_player_history.sql: Player history across Seasons (Story 6.4, FR-50). app.player_history(p_player_id) is a read: one row per Season for the whole person
-- (every app.player row with the same app.player_root), newest Season first: Team code and name, goals, assists, yellow and red cards, Man of the Match and
-- Fair Player counts, and the Season's awards. Own goals, unknown-scorer goals and deleted events count for nobody. Nothing is stored. Allowed for an Organiser
-- of the Player's Tournament, or a live Registration grant whose Team is in the Tournament's latest Season and has a Squad entry for the person; anyone else gets no rows. No personal columns.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

create index if not exists match_event_player_idx on app.match_event (player_id) where deleted_at is null;
create index if not exists match_event_assist_idx on app.match_event (assist_id) where deleted_at is null;
create index if not exists match_mom_idx on app.match (mom_player_id);
create index if not exists match_fair_idx on app.match (fair_player_id);

create or replace function app.player_history(p_player_id uuid)
returns table (season_number int, team_code text, team_name text, goals int, assists int, yellow_cards int, red_cards int, mom int, fair_player int, awards text[])
language sql stable security definer set search_path = '' as $$
  with me as (
    select p.tournament_id, app.player_root(p.id) as root from app.player p where p.id = p_player_id
  ), grp as (
    select p.id from app.player p, me where p.tournament_id = me.tournament_id and (p.id = me.root or p.merged_into = me.root)
  ), ok as (
    select 1 from me where app.is_member(me.tournament_id)
      or exists (select 1 from app.squad_entry s join app.team t on t.id = s.team_id
        join app.season x on x.id = t.season_id and x.number = (select max(y.number) from app.season y where y.tournament_id = me.tournament_id)
        where s.team_id = app.granted_team() and s.player_id in (select id from grp))
  ), sq as (
    select distinct on (t.season_id) t.season_id, t.code, t.name
    from app.squad_entry s join app.team t on t.id = s.team_id
    where s.player_id in (select id from grp)
    order by t.season_id, s.created_at desc, s.player_id
  ), ev as (
    select e.season_id,
      count(*) filter (where e.kind = 'goal' and not e.own_goal and e.player_id in (select id from grp))::int as goals,
      count(*) filter (where e.kind = 'goal' and not e.own_goal and e.assist_id in (select id from grp))::int as assists,
      count(*) filter (where e.kind = 'card' and e.card = 'yellow' and e.player_id in (select id from grp))::int as yc,
      count(*) filter (where e.kind = 'card' and e.card = 'red' and e.player_id in (select id from grp))::int as rc
    from app.match_event e
    where e.deleted_at is null and e.kind in ('goal', 'card') and (e.player_id in (select id from grp) or e.assist_id in (select id from grp))
    group by e.season_id
  ), aw as (
    select m.season_id,
      count(*) filter (where m.mom_player_id in (select id from grp))::int as mom,
      count(*) filter (where m.fair_player_id in (select id from grp))::int as fair
    from app.match m
    where m.mom_player_id in (select id from grp) or m.fair_player_id in (select id from grp)
    group by m.season_id
  ), sa as (
    select a.season_id, array_agg(a.award order by a.award) as awards
    from app.season_awards a where a.player_id in (select id from grp) group by a.season_id
  )
  select s.number, sq.code, sq.name, coalesce(ev.goals, 0), coalesce(ev.assists, 0), coalesce(ev.yc, 0), coalesce(ev.rc, 0),
    coalesce(aw.mom, 0), coalesce(aw.fair, 0), coalesce(sa.awards, '{}')
  from app.season s
  left join sq on sq.season_id = s.id
  left join ev on ev.season_id = s.id
  left join aw on aw.season_id = s.id
  left join sa on sa.season_id = s.id
  where exists (select 1 from ok) and s.tournament_id = (select tournament_id from me)
    and (sq.season_id is not null or ev.season_id is not null or aw.season_id is not null or sa.season_id is not null)
  order by s.number desc
$$;

revoke all on function app.player_history(uuid) from public, anon, authenticated;
grant execute on function app.player_history(uuid) to authenticated;
