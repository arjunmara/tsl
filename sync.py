#!/usr/bin/env python3
"""Copy the database (Supabase) down to the laptop. Read-only: all editing happens in the phone maker / control page.

  ./sync.py           write the latest season into matchday/*.txt, goals.json, events.json, teamlist/squads.txt
                      (what make.py renders from) and every public table into seasons/db.json (the nightly backup)
  ./sync.py N         the same for season N
"""
import json, pathlib, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
URL = 'https://bicxaypaaawrvzfeptjp.supabase.co/rest/v1'
KEY = 'sb_publishable_1uLQL2J9c3_eVAnplpvslg_yGWPZvBR'  # public read key (same as db.js)
TABLES = ['seasons', 'teams', 'players', 'season_teams', 'squad', 'matches', 'goals', 'events', 'sponsors', 'live']


def get(table):
    req = urllib.request.Request(f'{URL}/{table}?select=*&order={"id" if table not in ("season_teams", "squad") else "season"}',
                                 headers={'apikey': KEY, 'Authorization': f'Bearer {KEY}'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def to12(t):
    if not t: return ''
    h, m = map(int, t.split(':')[:2])
    return f'{h % 12 or 12}:{m:02d} {"AM" if h < 12 else "PM"}'


def texts(db, season=None):
    """The season in the text/JSON shapes the templates read. Same rules as loadSeason() in db.js."""
    sid = season or db['seasons'][-1]['id']
    st = [x for x in db['season_teams'] if x['season'] == sid]
    T = {t['id']: t for t in db['teams']}
    grp = {x['team']: x['grp'] for x in st}
    teams = [T[i] for i in sorted(grp)]
    names = {p['id']: p['name'] for p in db['players']}
    squad = sorted((x for x in db['squad'] if x['season'] == sid), key=lambda x: x['sort'])
    ms = sorted((m for m in db['matches'] if m['season'] == sid), key=lambda m: m['n'])
    pos = {m['id']: str(i + 1) for i, m in enumerate(ms)}
    name = lambda i: T[i]['name']
    pre = lambda m: '' if m['round'] == 'Group' else m['round'] + ': '
    minute = lambda x: '' if x['minute'] is None else str(x['minute'])
    results = []
    for m in ms:
        if m['status'] != 'done': continue
        results.append(f"{pre(m)}{name(m['home'])} {m['hg']}-{m['ag']} {name(m['away'])}")
        if m['hp'] is not None: results.append(f"{pre(m)}{name(m['home'])} {m['hp']}-{m['ap']} {name(m['away'])} (pens)")
    return {
        'matchday/fixtures.txt': '# Group, Home v Away, time\n' + ''.join(
            f"{grp.get(m['home']) or '' if m['round'] == 'Group' else m['round']}, {name(m['home'])} v {name(m['away'])}"
            f"{', ' + to12(m['kickoff']) if m['kickoff'] else ''}\n" for m in ms),
        'matchday/results.txt': '\n'.join(results) + '\n',
        'matchday/groups.txt': '\n\n'.join(f'Group {g}\n' + '\n'.join(name(x['team']) for x in sorted(st, key=lambda x: (x.get('sort', 0), x['team'])) if x['grp'] == g)
                                           for g in sorted({x['grp'] for x in st if x['grp']})) + '\n',
        'teamlist/squads.txt': ''.join(f"{t['name']}: " + '|'.join(names[x['player']] + (' (C)' if x['captain'] else '') + (f" ({x['role']})" if x['role'] else '')
                                                               for x in squad if x['team'] == t['id']) + '\n' for t in teams),
        'matchday/goals.json': json.dumps([{'id': g['id'], 'n': pos[g['match']], 'team': name(g['team']),
                                            'name': 'Own Goal' if g['og'] else names.get(g['player'], ''), 'min': minute(g)}
                                           for g in db['goals'] if g['match'] in pos], separators=(',', ':')),
        'matchday/events.json': json.dumps([{'id': e['id'], 'n': pos[e['match']], 'type': e['kind'], 'team': name(e['team']),
                                             'name': names[e['player']], 'min': minute(e)} for e in db['events'] if e['match'] in pos], separators=(',', ':')),
    }


def pull(season=None):
    db = {t: get(t) for t in TABLES}
    (ROOT / 'seasons/db.json').write_text(json.dumps(db, indent=1, ensure_ascii=False) + '\n')
    for f, text in texts(db, season).items():
        if (ROOT / f).exists() and (ROOT / f).read_text() == text: continue
        (ROOT / f).write_text(text)
        print('  ←', f)


if __name__ == '__main__':
    if len(sys.argv) > 1 and not sys.argv[1].isdigit(): sys.exit(__doc__)
    pull(int(sys.argv[1]) if len(sys.argv) > 1 else None)
