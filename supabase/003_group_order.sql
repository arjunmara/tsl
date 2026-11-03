-- 003: teams keep their draw order inside a group (tie sheet / Official Draw graphic). Paste into SQL Editor → Run.
alter table season_teams add sort smallint not null default 0;
update season_teams s set sort = v.sort from (values (13, 1), (11, 2), (12, 3), (7, 1), (10, 2), (5, 3), (4, 1), (2, 2), (8, 3), (1, 1), (3, 2), (9, 3), (6, 4)) v(team, sort) where s.season = 1 and s.team = v.team;
