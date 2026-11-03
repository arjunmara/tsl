-- TSL database (Supabase / Postgres). Paste into Dashboard → SQL Editor → Run, once.
-- Anyone can read; only emails in `editors` can write. Every write is logged in `audit`.

create table teams (
  id    smallserial primary key,
  code  text not null unique check (code ~ '^[A-Z0-9]{2,6}$'),
  name  text not null unique check (btrim(name) <> ''),
  kit   text check (kit ~ '^#[0-9a-f]{6}$')
);

create table seasons (
  id       smallint primary key,
  name     text not null unique,
  champion smallint references teams
);

-- A person. Same name on two teams = two players (there are two Arjun KCs and two Sagar Thapas).
create table players (
  id   serial primary key,
  name text not null check (btrim(name) <> '')
);

create table season_teams (
  season smallint references seasons,
  team   smallint references teams,
  grp    text check (grp ~ '^[A-H]$'),
  primary key (season, team)
);

create table squad (
  season smallint,
  team   smallint,
  player int not null references players,
  role   text check (role in ('C', 'GK', 'Coach', 'Manager')),   -- null = player
  primary key (season, player),                                   -- one team per season
  foreign key (season, team) references season_teams
);

create table matches (
  id      serial primary key,
  season  smallint not null references seasons,
  n       smallint not null check (n > 0),                        -- match number, as on the graphics
  round   text not null check (round in ('Group', 'QF', 'SF', 'Final')),
  home    smallint not null,
  away    smallint not null check (away <> home),
  day     date,
  kickoff time,
  status  text not null default 'scheduled' check (status in ('scheduled', 'live', 'done')),
  hg smallint check (hg >= 0), ag smallint check (ag >= 0),       -- score; null until kick-off
  hp smallint check (hp >= 0), ap smallint check (ap >= 0),       -- shootout, only to break a tie
  unique (season, n),
  foreign key (season, home) references season_teams,
  foreign key (season, away) references season_teams,
  check ((hg is null) = (ag is null)),
  check ((hp is null) = (ap is null)),
  check (hp is null or (hp <> ap and hg = ag)),
  check (status <> 'done' or hg is not null)
);

-- player null = unknown scorer or own goal (credited to `team`).
create table goals (
  id     serial primary key,
  match  int not null references matches on delete cascade,
  team   smallint not null references teams,
  player int references players,
  minute smallint check (minute between 0 and 60)
);

create table cards (
  id     serial primary key,
  match  int not null references matches on delete cascade,
  team   smallint not null references teams,
  player int not null references players,
  kind   text not null check (kind in ('yellow', 'red')),
  minute smallint check (minute between 0 and 60)
);

create table sponsors (
  id     serial primary key,
  season smallint not null references seasons,
  name   text not null,                 -- '-' = promo image, not on the ticker
  logo   text, ad text, line text,      -- image paths under Sponsors/
  sort   smallint not null default 0
);

-- Live stream state (score bug, scene, ticker, ad...). One row, changes every second, not audited.
create table live (
  id    smallint primary key default 1 check (id = 1),
  state jsonb not null default '{}'
);
insert into live default values;

create table editors (email text primary key check (email = lower(email)));

create table audit (
  id    bigserial primary key,
  at    timestamptz not null default now(),
  who   text default auth.jwt() ->> 'email',
  tbl   text not null,
  op    text not null,
  old   jsonb,
  new   jsonb
);

-- A goal/card must be for a team in that match, by a player in that team's squad this season.
create function check_event() returns trigger language plpgsql as $$
declare m matches;
begin
  select * into m from matches where id = new.match;
  if new.team not in (m.home, m.away) then
    raise exception 'Team % did not play match %', new.team, m.n;
  end if;
  if new.player is not null and not exists (
      select 1 from squad where season = m.season and team = new.team and player = new.player) then
    raise exception 'Player % is not in that team''s squad', new.player;
  end if;
  return new;
end $$;
create trigger goals_check before insert or update on goals for each row execute function check_event();
create trigger cards_check before insert or update on cards for each row execute function check_event();

create function log_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into audit (tbl, op, old, new)
  values (tg_table_name, tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;

create function is_editor() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from editors where email = lower(auth.jwt() ->> 'email'))
$$;

do $$
declare t text;
begin
  foreach t in array array['teams','seasons','players','season_teams','squad','matches','goals','cards','sponsors','live'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "anyone reads" on %I for select using (true)', t);
    execute format('create policy "editors write" on %I for all to authenticated using (is_editor()) with check (is_editor())', t);
    if t <> 'live' then
      execute format('create trigger %I after insert or update or delete on %I for each row execute function log_change()', t || '_audit', t);
    end if;
  end loop;
end $$;

alter table editors enable row level security;
create policy "editors see editors" on editors for select to authenticated using (is_editor());
alter table audit enable row level security;
create policy "editors read audit" on audit for select to authenticated using (is_editor());

-- Push these to the overlay / phones the moment they change.
alter publication supabase_realtime add table live, matches, goals, cards;
