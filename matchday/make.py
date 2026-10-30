#!/usr/bin/env python3
"""Render a matchday graphic to out/<name>.png.

  ./make.py fixture   home="Da Boys" away="Real Tamghas" match="Match 1" date="Fri 14 Nov" time="4:00 PM" venue="Tamghas Futsal"
  ./make.py goal      scorer="Mishan KC" team=DAB home=DAB away=RTM score=1-0 minute=12
  ./make.py score     home=DAB away=RTM score=2-1 label="Full Time" homeScorers="Mishan KC 12'|Viju Pun 30'" awayScorers="Arjun KC 25'"
  ./make.py results   title=Results subtitle="Matchday 1" matches="DAB,RTM,2-1|KPT,KYC,4:00 PM"
  ./make.py table     (reads results.txt, and groups.txt for group tables; qualify=2 next="Semi-Finals")
  ./make.py motm      name="Mishan KC" team=DAB stat="2 Goals" match="Da Boys 2-1 Real Tamghas"
  ./make.py scorers   players="Mishan KC,DAB,5|Arjun KC,RTM,3"
  ./make.py champions team=DAB season="Season 1"
  ./make.py teams     subtitle="Season 1" [wildcards=1 for open slots]
  ./make.py format    (reads groups.txt; or groups="4,3,3,3" for empty slots) top 2 per group to quarter-finals
  ./make.py fixtures  (reads fixtures.txt; make it with ./fixtures.py) [subtitle="Kick-off Saturday · Kartik 14"]
  ./make.py notice    title="Tie-Sheet Draw" date="Today" time="5:00 PM" venue="Tamghas Futsal" body="..." sign="Organizing Committee"

Teams can be full names or short codes (see league.js).
"""
import pathlib, re, subprocess, sys, urllib.parse

here = pathlib.Path(__file__).resolve().parent
if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help'):
    sys.exit(__doc__)

kind, params = sys.argv[1], {'type': sys.argv[1]}
for arg in sys.argv[2:]:
    k, sep, v = arg.partition('=')
    if not sep:
        sys.exit(f'Expected key=value, got: {arg}')
    params[k] = v
if kind == 'table' and 'results' not in params:
    params['results'] = (here / 'results.txt').read_text()
if kind == 'fixtures' and 'fixtures' not in params:
    params['fixtures'] = (here / 'fixtures.txt').read_text()
if kind in ('table', 'format') and 'groups' not in params and (here / 'groups.txt').exists():
    params['groups'] = (here / 'groups.txt').read_text()

# File name from the most identifying values, e.g. goal-dab-rtm-12.png
keys = ['home', 'away', 'team', 'name', 'minute', 'label', 'title', 'subtitle']
slug = re.sub(r'[^a-z0-9]+', '-', '-'.join([kind] + [params[k] for k in keys if params.get(k)]).lower()).strip('-')[:90]
out = here / 'out' / f'{slug}.png'
out.parent.mkdir(exist_ok=True)

url = (here / 'matchday.html').as_uri() + '?' + urllib.parse.urlencode(params)
subprocess.run(['google-chrome', '--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
                '--virtual-time-budget=5000', '--window-size=1080,1350', f'--screenshot={out}', url],
               check=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
print(out)
