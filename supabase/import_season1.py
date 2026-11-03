#!/usr/bin/env python3
"""One-off: seasons/season-1 archive → supabase/season1.sql (paste after schema.sql).
Refuses to write the file if a scorer isn't in their team's squad, so nothing is silently dropped."""
import json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
S1 = ROOT / 'seasons/season-1'
TEAMS = re.findall(r"\['(.+?)', '(\w+)'\]", (ROOT / 'matchday/league.js').read_text())
lines = lambda f: [l.strip() for l in (S1 / f).read_text().splitlines() if l.strip() and not l.startswith('#')]
q = lambda s: 'null' if s is None or s == '' else "'" + str(s).replace("'", "''") + "'"
tid = {name: i + 1 for i, (name, _) in enumerate(TEAMS)}
kits = json.loads((S1 / 'kits.json').read_text())

sql = ['begin;', "insert into seasons (id, name) values (1, 'Season 1');"]
sql += [f"insert into teams (id, code, name, kit) values ({tid[n]}, {q(c)}, {q(n)}, {q(kits.get(c))});" for n, c in TEAMS]

grp = {}
for l in lines('groups.txt'):
    if l.startswith('Group '): g = l[6:]
    else: grp[l] = g
sql += [f"insert into season_teams values (1, {tid[n]}, {q(grp[n])});" for n, _ in TEAMS]

pid, players = {}, 0                                   # (team, name) → player id
for l in lines('squads.txt'):
    team, names = l.split(': ', 1)
    for p in names.split('|'):
        name, role = re.match(r'(.+?)(?:\s*\((C|GK|Coach|Manager)\))?$', p.strip()).groups()
        players += 1
        pid[team, name] = players
        sql += [f"insert into players values ({players}, {q(name)});",
                f"insert into squad values (1, {tid[team]}, {players}, {q(role)});"]

RES = re.compile(r'^(?:(QF|SF|Final):\s*)?(.+?) (\d+)-(\d+) (.+)$')
results = [RES.match(l).groups() for l in lines('results.txt')]
fixtures = lines('fixtures.txt')
mid = {}
for n, l in enumerate(fixtures, 1):
    parts = [p.strip() for p in l.split(',')]
    rnd = parts[0] if parts[0] in ('QF', 'SF', 'Final') else 'Group'
    home, away = parts[1].split(' v ')
    t = re.match(r'(\d+):(\d+) (AM|PM)', parts[2]) if len(parts) > 2 else None
    kick = t and f"{int(t[1]) % 12 + (12 if t[3] == 'PM' else 0)}:{t[2]}"
    r = next(((r, r[1] == home) for r in results if (r[0] or 'Group') == rnd and {r[1], r[4]} == {home, away}), None)
    hg, ag = (None, None) if not r else (r[0][2], r[0][3]) if r[1] else (r[0][3], r[0][2])
    sql.append(f"insert into matches (id, season, n, round, home, away, kickoff, status, hg, ag) values "
               f"({n}, 1, {n}, {q(rnd)}, {tid[home]}, {tid[away]}, {q(kick)}, {q('done' if r else 'scheduled')}, {q(hg)}, {q(ag)});")
    mid[n] = (home, away)
assert sum("'done'" in l for l in sql if l.startswith('insert into matches')) == len(results), 'a result has no fixture'

missing = []
for kind, f in (('goal', 'goals.json'), ('card', 'events.json')):
    for e in json.loads((S1 / f).read_text()):
        n, team = int(e['n']), e['team']
        assert team in mid[n], f'{team} not in match {n}'
        p = pid.get((team, e['name']))
        if not p and e['name'] != 'Own Goal': missing.append(f"match {n}: {e['name']} ({team})")
        m = e.get('min') or None
        if kind == 'goal':
            sql.append(f"insert into goals (match, team, player, minute) values ({n}, {tid[team]}, {p or 'null'}, {q(m)});")
        else:
            sql.append(f"insert into cards (match, team, player, kind, minute) values ({n}, {tid[team]}, {p}, "
                       f"{q(e['type'].split()[0].lower())}, {q(m)});")
if missing: sys.exit('Not in squad:\n  ' + '\n  '.join(missing))

for i, l in enumerate(lines('sponsors.txt')):
    name, logo, ad, line = ([p.strip() for p in l.split('|')] + [''] * 4)[:4]
    sql.append(f"insert into sponsors (season, name, logo, ad, line, sort) values (1, {q(name)}, {q(logo)}, {q(ad)}, {q(line)}, {i});")

sql.append(f"update seasons set champion = {tid['Four Star Warriors']} where id = 1;")
for t in ('teams', 'players', 'matches'):   # explicit ids above → move the counters past them
    sql.append(f"select setval(pg_get_serial_sequence('{t}', 'id'), (select max(id) from {t}));")
sql.append('commit;')
(ROOT / 'supabase/season1.sql').write_text('\n'.join(sql) + '\n')
print(f'{len(TEAMS)} teams, {players} players, {len(fixtures)} matches, {len(results)} results → supabase/season1.sql')
