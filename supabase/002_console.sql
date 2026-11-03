-- 002: score comes from the goals; events beyond cards; captain flag + squad order; atomic live updates.
-- Paste into SQL Editor → Run, once (after schema.sql and season1.sql).
begin;

-- Score = goals. A goal with no player is an unknown scorer, unless it's an own goal.
alter table goals add og boolean not null default false;
update goals set og = true where player is null;   -- Season 1's only scorer-less goal was an own goal
alter table matches drop constraint matches_check1, drop constraint matches_check4;   -- "score null until kick-off" rules
update matches set hg = 0 where hg is null;
update matches set ag = 0 where ag is null;
alter table matches alter hg set default 0, alter hg set not null, alter ag set default 0, alter ag set not null;

-- Season 1 scores that have fewer goals logged than the score: the rest are unknown scorers (name them later).
insert into goals (match, team)
select m.id, t.team from matches m
cross join lateral (values (m.home, m.hg), (m.away, m.ag)) t(team, want)
cross join lateral generate_series(1, t.want - (select count(*) from goals g where g.match = m.id and g.team = t.team))
where m.season = 1;

create function score_from_goals() returns trigger language plpgsql as $$
begin
  update matches m set
    hg = (select count(*) from goals g where g.match = m.id and g.team = m.home),
    ag = (select count(*) from goals g where g.match = m.id and g.team = m.away)
  where m.id in (old.match, new.match);
  return null;
end $$;
-- `old`/`new` are null on insert/delete; `in (null, x)` still matches x.
create trigger goals_score after insert or update or delete on goals for each row execute function score_from_goals();

-- Score typed in by hand (no scorers): top up / trim the unknown-scorer goals. Named goals are never touched.
create function set_result(m int, h int, a int) returns void language plpgsql as $$
declare mt matches; side record; known int;
begin
  select * into mt from matches where id = m;
  for side in select * from (values (mt.home, h), (mt.away, a)) v(team, want) loop
    select count(*) into known from goals where match = m and team = side.team and (player is not null or og);
    if side.want < known then
      raise exception 'That team already has % named scorer(s) in this match: remove some first', known;
    end if;
    delete from goals where match = m and team = side.team and player is null and not og;
    insert into goals (match, team) select m, side.team from generate_series(1, side.want - known);
  end loop;
  update matches set status = 'done' where id = m;
end $$;

-- Cards → events (cards, missed/saved penalties, injuries), named as the maker shows them.
alter table cards rename to events;
alter table events drop constraint cards_kind_check;
update events set kind = case kind when 'yellow' then 'Yellow Card' else 'Red Card' end;
alter table events add constraint events_kind_check
  check (kind in ('Yellow Card', 'Red Card', 'Second Yellow', 'Penalty Missed', 'Penalty Saved', 'Injury'));

-- Captain is a flag (a captain can also be the keeper); squads keep their running order.
alter table squad add captain boolean not null default false, add sort smallint not null default 0;
update squad set captain = true, role = null where role = 'C';
update squad s set sort = o.rn from (select player, row_number() over (partition by season, team order by player) rn from squad) o
where s.player = o.player;
alter table squad drop constraint squad_role_check, add constraint squad_role_check check (role in ('GK', 'Coach', 'Manager'));

-- Match order: renumber in one statement (moving a fixture up, deleting one) without tripping unique (season, n).
alter table matches drop constraint matches_season_n_key, add constraint matches_season_n_key unique (season, n) deferrable;
create function set_order(ids int[]) returns void language sql as $$
  update matches m set n = o.i from unnest(ids) with ordinality o(id, i) where m.id = o.id
$$;

-- Live state: merge a patch atomically. "now" = server time in ms (the match clock).
create function live_patch(p jsonb) returns jsonb language sql as $$
  update live set state = state || (select coalesce(jsonb_object_agg(key,
      case when value = '"now"' then to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint) else value end), '{}')
    from jsonb_each(p))
  where id = 1 returning state
$$;
create function now_ms() returns bigint language sql stable as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

-- The match on air (live.state.match) carries its score to the stream the moment a goal is added or removed.
create function score_to_live() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.hg, new.ag) is distinct from (old.hg, old.ag) then
    update live set state = state || jsonb_build_object('hs', new.hg, 'as', new.ag) where state ->> 'match' = new.id::text;
  end if;
  return null;
end $$;
create trigger matches_live after update on matches for each row execute function score_to_live();

-- Bring the live board over from Firebase as it is.
update live set state = '{"home": "Four Star Warriors", "away": "Resunga Eight", "hs": 4, "as": 1, "match": 22, "period": "Full Time",
  "show": true, "elapsed": 0, "since": null, "scene": "auto", "ticker": true, "ad": null, "guide": false,
  "hc": "#ffffff", "ac": "#d71920", "lay": {"side": 180, "tb": 60, "x": 130, "y": 20, "zoom": 1.05}}';

alter publication supabase_realtime add table squad, players, season_teams, teams;
commit;
