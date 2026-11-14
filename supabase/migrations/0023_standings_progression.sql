-- 0023_standings_progression.sql: standings and knockout progression (Story 3.4). Match results state (status scheduled, live,
-- finished; home_pens / away_pens for a knockout Match level after play), the tie-break shootout table and its command
-- record_tiebreak_shootout, the read functions app.standings(season) and app.match_sides(season), and the freezing of knockout
-- slots: when a Match turns live its resolved Teams are written into home_team_id / away_team_id, and after that a change that would
-- make a frozen side resolve differently fails with downstream_started. No command here writes a score: goals and finishing a Match
-- come in Epic 4. The rules are those of matchday/league.js. The founder applies this in the Supabase SQL Editor as `postgres`:
-- test first, then live. Safe to run twice.

-- Match results state ----------------------------------------------------------------------------
alter table app.match drop constraint if exists match_status_check;
alter table app.match add constraint match_status_check check (status in ('scheduled', 'live', 'finished'));
alter table app.match add column if not exists home_pens int, add column if not exists away_pens int;
alter table app.match drop constraint if exists match_pens_check;
alter table app.match add constraint match_pens_check check (
  (home_pens is null) = (away_pens is null) and home_pens >= 0 and away_pens >= 0 and home_pens <> away_pens);

-- Tie-break shootouts: who won a shootout between two Teams level in a group table. Adds no goals or points.
create table if not exists app.tiebreak_shootout (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  season_id uuid not null references app.season (id),
  winner_team_id uuid not null references app.team (id),
  loser_team_id uuid not null references app.team (id),
  created_at timestamptz not null default now(),
  version int not null default 1,
  check (winner_team_id <> loser_team_id)
);
create unique index if not exists tiebreak_shootout_pair_idx on app.tiebreak_shootout
  (season_id, least(winner_team_id::text, loser_team_id::text), greatest(winner_team_id::text, loser_team_id::text));

-- No personal fields here.
create or replace trigger log_change after insert or update or delete on app.tiebreak_shootout
  for each row execute function app.log_change('tournament_id', '{}');
alter table app.tiebreak_shootout enable row level security;
drop policy if exists member_read on app.tiebreak_shootout;
create policy member_read on app.tiebreak_shootout for select to authenticated using (app.is_member(tournament_id));
revoke all on app.tiebreak_shootout from public, anon, authenticated;
grant select on app.tiebreak_shootout to authenticated;

insert into app.season_action values ('record_shootout', 'started') on conflict do nothing;

-- Standings --------------------------------------------------------------------------------------
-- One row per Team: grp (1 = Group A; 0 for a League), pos, P W D L GF GA GD Pts. Only finished Matches count: group Matches
-- between Teams of the same group (league Matches for a League); knockout Matches and shootouts add no goals or points. Teams level
-- on points are ordered by the Season's tiebreaks, each used as matchday/league.js uses it: head-to-head points and goal difference
-- in a mini-table of the Teams level on points, shootout wins among them, overall goal difference, goals scored; then Team name.
-- group_done: every Match of the group is finished. provisional + shootout_with: the group is done, the Teams are still level
-- after the criteria up to and including h2h_shootout, and no shootout between the two exists: a shootout is needed.
-- ponytail: 3+ Team ties use one mini-table among all of them, as league.js does.
create or replace function app.standings_calc(p_season_id uuid)
returns table (grp int, pos int, team_id uuid, p int, w int, d int, l int, gf int, ga int, gd int, pts int,
  group_done boolean, provisional boolean, shootout_with uuid)
language sql stable security definer set search_path = '' as $$
  with sn as (
    select s.*, case when s.structure = 'league' then 'league' else 'group' end as st from app.season s where s.id = p_season_id),
  mem as (
    select ds.grp, ds.team_id from app.draw_slot ds, sn where ds.season_id = sn.id and sn.structure = 'groups_knockout' and ds.grp >= 1
    union all
    select 0, t.id from app.team t, sn where t.season_id = sn.id and t.status = 'approved' and sn.structure = 'league'),
  g as (
    select hm.grp, m.home_team_id as h, m.away_team_id as a, m.hg, m.ag
    from app.match m, sn, mem hm, mem am
    where m.season_id = sn.id and m.stage = sn.st and m.status = 'finished' and m.hg is not null and m.ag is not null
      and hm.team_id = m.home_team_id and am.team_id = m.away_team_id and am.grp = hm.grp),
  done as (
    select distinct gg.grp from g gg where not exists (
      select 1 from app.match m2, sn, mem a2, mem b2 where m2.season_id = sn.id and m2.stage = sn.st and m2.status <> 'finished'
        and a2.team_id = m2.home_team_id and b2.team_id = m2.away_team_id and a2.grp = gg.grp and b2.grp = gg.grp)),
  side as (
    select grp, h as team_id, a as opp, hg as f, ag as c from g union all select grp, a, h, ag, hg from g),
  tt as (
    select mm.grp, mm.team_id, count(s.opp)::int as p,
      (count(*) filter (where s.f > s.c))::int as w, (count(*) filter (where s.f = s.c))::int as d,
      (count(*) filter (where s.f < s.c))::int as l,
      coalesce(sum(s.f), 0)::int as gf, coalesce(sum(s.c), 0)::int as ga
    from mem mm left join side s on s.team_id = mm.team_id and s.grp = mm.grp group by mm.grp, mm.team_id),
  tp as (
    select t.*, t.gf - t.ga as gd, t.w * sn.points_win + t.d * sn.points_draw + t.l * sn.points_loss as pts from tt t, sn),
  h2h as (
    select a.team_id,
      coalesce(sum(case when s.f > s.c then sn.points_win when s.f = s.c then sn.points_draw else sn.points_loss end), 0)::int as hp,
      coalesce(sum(s.f - s.c), 0)::int as hd
    from tp a cross join sn
      left join side s on s.team_id = a.team_id and s.grp = a.grp
        and s.opp in (select o.team_id from tp o where o.grp = a.grp and o.pts = a.pts)
    group by a.team_id),
  so as (
    select a.team_id, count(x.id)::int as n
    from tp a left join app.tiebreak_shootout x on x.season_id = p_season_id and x.winner_team_id = a.team_id
      and x.loser_team_id in (select o.team_id from tp o where o.grp = a.grp and o.pts = a.pts)
    group by a.team_id),
  k as (
    select a.*, nm.name, h.hp, h.hd, so.n,
      (select coalesce(array_agg(case u.c when 'h2h_points' then h.hp when 'h2h_goal_difference' then h.hd when 'h2h_shootout' then so.n
          when 'goal_difference' then a.gd when 'goals_scored' then a.gf else 0 end order by u.o), '{}'::int[])
        from sn, unnest(sn.tiebreaks) with ordinality u (c, o)) as keys,
      (select coalesce(array_agg(case u.c when 'h2h_points' then h.hp when 'h2h_goal_difference' then h.hd when 'h2h_shootout' then so.n
          when 'goal_difference' then a.gd when 'goals_scored' then a.gf else 0 end order by u.o), '{}'::int[])
        from sn, unnest(sn.tiebreaks) with ordinality u (c, o)
        where u.o <= (select z.o from sn s2, unnest(s2.tiebreaks) with ordinality z (c, o) where z.c = 'h2h_shootout' order by z.o limit 1)) as pkeys,
      (select 'h2h_shootout' = any (sn.tiebreaks) from sn) as hs
    from tp a join h2h h on h.team_id = a.team_id join so on so.team_id = a.team_id join app.team nm on nm.id = a.team_id),
  r as (
    select k.*, row_number() over (partition by k.grp order by k.pts desc, k.keys desc, lower(k.name), k.name)::int as rk from k)
  select r.grp, r.rk, r.team_id, r.p, r.w, r.d, r.l, r.gf, r.ga, r.gd, r.pts,
    r.grp in (select dn.grp from done dn), x.t is not null, x.t
  from r left join lateral (
    select o.team_id as t from r o
    where r.hs and r.grp in (select dn.grp from done dn) and o.grp = r.grp and o.team_id <> r.team_id and o.pts = r.pts and o.pkeys = r.pkeys
      and not exists (select 1 from app.tiebreak_shootout z where z.season_id = p_season_id
        and ((z.winner_team_id = r.team_id and z.loser_team_id = o.team_id) or (z.winner_team_id = o.team_id and z.loser_team_id = r.team_id)))
    order by (o.rk < r.rk), abs(o.rk - r.rk) limit 1) x on true
  order by r.grp, r.rk
$$;

-- The read for clients: the same rows, only for a member of the Season's Tournament.
create or replace function app.standings(p_season_id uuid)
returns table (grp int, pos int, team_id uuid, p int, w int, d int, l int, gf int, ga int, gd int, pts int,
  group_done boolean, provisional boolean, shootout_with uuid)
language sql stable security definer set search_path = '' as $$
  select s.* from app.standings_calc(p_season_id) s
  where app.is_member((select x.tournament_id from app.season x where x.id = p_season_id))
$$;

-- Match sides ------------------------------------------------------------------------------------
-- Every Match of the Season with each side resolved: home_team_id / away_team_id are the Team that plays (a frozen Team once the
-- Match is live or finished, else the resolved one), null while unknown, and home_src / away_src keep the label ("A1", "Winner QF1").
-- home_resolved / away_resolved are what the label resolves to now, whatever is frozen. A side is a Team id (a Team named when the
-- Fixtures were made), a group position "A1" (once every Match of the group is finished), or "Winner QF1" (a finished knockout Match,
-- a shootout after a draw; level with no shootout resolves to nothing).
create or replace function app.match_resolve(p_season_id uuid)
returns table (match_id uuid, home_team_id uuid, away_team_id uuid, home_src text, away_src text, home_resolved uuid, away_resolved uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  gmap jsonb;
  eff jsonb := '{}';
  prev jsonb;
  m app.match;
  w app.match;
  sides jsonb;
  fh uuid; fa uuid; eh uuid; ea uuid;
begin
  select coalesce(jsonb_object_agg(chr(64 + s.grp) || s.pos, s.team_id), '{}') into gmap
  from app.standings_calc(p_season_id) s where s.group_done and s.grp >= 1;
  for pass in 1..12 loop
    prev := eff;
    for m in select x.* from app.match x where x.season_id = p_season_id order by x.ord loop
      fh := m.home_team_id; fa := m.away_team_id;
      for i in 1..2 loop
        declare
          src text := case i when 1 then m.home_src else m.away_src end;
          got uuid;
          isrc boolean := false;
        begin
          if src ~ '^[A-Z][0-9]{1,2}$' then
            isrc := true; got := (gmap ->> src)::uuid;
          elsif src ~ '^Winner .' then
            isrc := true;
            select x.* into w from app.match x where x.season_id = p_season_id and x.stage = 'knockout'
              and x.label = substr(src, 8) and x.status = 'finished' limit 1;
            if found then
              sides := eff -> w.id::text;
              got := (sides ->> case when w.hg > w.ag then 'h' when w.ag > w.hg then 'a'
                when w.home_pens is not null then case when w.home_pens > w.away_pens then 'h' else 'a' end end)::uuid;
            end if;
          end if;
          if isrc then
            if i = 1 then fh := got; else fa := got; end if;
          end if;
        end;
      end loop;
      -- A frozen side (Match live or finished) is the stored Team; before that, the resolved one.
      eh := case when m.status <> 'scheduled' and m.home_team_id is not null then m.home_team_id else coalesce(fh, m.home_team_id) end;
      ea := case when m.status <> 'scheduled' and m.away_team_id is not null then m.away_team_id else coalesce(fa, m.away_team_id) end;
      eff := eff || jsonb_build_object(m.id::text, jsonb_build_object('h', eh, 'a', ea, 'fh', fh, 'fa', fa));
    end loop;
    exit when eff = prev;
  end loop;
  for m in select x.* from app.match x where x.season_id = p_season_id order by x.ord loop
    match_id := m.id; home_src := m.home_src; away_src := m.away_src;
    home_team_id := (eff -> m.id::text ->> 'h')::uuid; away_team_id := (eff -> m.id::text ->> 'a')::uuid;
    home_resolved := (eff -> m.id::text ->> 'fh')::uuid; away_resolved := (eff -> m.id::text ->> 'fa')::uuid;
    return next;
  end loop;
end $$;

-- The read for clients, for a member of the Season's Tournament.
create or replace function app.match_sides(p_season_id uuid)
returns table (match_id uuid, home_team_id uuid, away_team_id uuid, home_src text, away_src text, home_resolved uuid, away_resolved uuid)
language sql stable security definer set search_path = '' as $$
  select r.* from app.match_resolve(p_season_id) r
  where app.is_member((select x.tournament_id from app.season x where x.id = p_season_id))
$$;

-- Freezing ---------------------------------------------------------------------------------------
-- When a Match turns live (or is finished at once), its resolved Teams are written into its sides.
create or replace function app.match_going_live() returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  select * into r from app.match_resolve(new.season_id) x where x.match_id = new.id;
  new.home_team_id := coalesce(r.home_team_id, new.home_team_id);
  new.away_team_id := coalesce(r.away_team_id, new.away_team_id);
  return new;
end $$;
create or replace trigger match_going_live before update of status on app.match
  for each row when (old.status = 'scheduled' and new.status <> 'scheduled') execute function app.match_going_live();

-- After any change to a Match or a shootout: a frozen Team that its label would now resolve differently fails the change.
create or replace function app.match_freeze_check() returns trigger language plpgsql security definer set search_path = '' as $$
declare sid uuid := case when tg_op = 'DELETE' then old.season_id else new.season_id end;
begin
  if not exists (select 1 from app.match x where x.season_id = sid and x.status <> 'scheduled') then return null; end if;
  if exists (select 1 from app.match m join app.match_resolve(sid) r on r.match_id = m.id
    where m.season_id = sid and m.status <> 'scheduled'
      and ((m.home_team_id is not null and m.home_team_id is distinct from r.home_resolved)
        or (m.away_team_id is not null and m.away_team_id is distinct from r.away_resolved))) then
    raise exception 'downstream_started';
  end if;
  return null;
end $$;
drop trigger if exists match_freeze on app.match;
create constraint trigger match_freeze after insert or update on app.match deferrable initially immediate
  for each row execute function app.match_freeze_check();
drop trigger if exists shootout_freeze on app.tiebreak_shootout;
create constraint trigger shootout_freeze after insert or delete on app.tiebreak_shootout deferrable initially immediate
  for each row execute function app.match_freeze_check();

-- Command ----------------------------------------------------------------------------------------
-- Records who won the shootout between two Teams that the standings show level (shootout_needed). A pair that is not level, or a
-- Team of another Season, gives shootout_not_needed. A shootout that would change a frozen Team gives downstream_started.
create or replace function app.record_tiebreak_shootout(command_id uuid, season_id uuid, shootout_id uuid, winner_team_id uuid, loser_team_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'record_shootout', jsonb_build_object('season_id', season_id));
  r jsonb;
  sn app.season;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into sn from app.season x where x.id = season_id for update;
  if not exists (select 1 from app.standings_calc(season_id) s
    where (s.team_id = winner_team_id and s.shootout_with = loser_team_id) or (s.team_id = loser_team_id and s.shootout_with = winner_team_id)) then
    r := jsonb_build_object('ok', false, 'code', 'shootout_not_needed', 'message', 'These Teams are not level, so no shootout is needed.');
  else
    begin
      insert into app.tiebreak_shootout (id, tournament_id, season_id, winner_team_id, loser_team_id)
      values (shootout_id, sn.tournament_id, season_id, winner_team_id, loser_team_id);
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Shootout recorded.');
    exception when raise_exception then
      if sqlerrm <> 'downstream_started' then raise; end if;
      r := jsonb_build_object('ok', false, 'code', 'downstream_started',
        'message', 'The next Match has started, so this result can''t change who plays in it.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.standings_calc(uuid), app.match_resolve(uuid), app.match_going_live(), app.match_freeze_check(),
  app.standings(uuid), app.match_sides(uuid), app.record_tiebreak_shootout(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function app.standings(uuid), app.match_sides(uuid), app.record_tiebreak_shootout(uuid, uuid, uuid, uuid, uuid) to authenticated;
