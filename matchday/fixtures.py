#!/usr/bin/env python3
"""Group-stage match order from groups.txt -> fixtures.txt (edit freely, then ./make.py fixtures).

Every pairing once per group; each next match is the one whose teams have rested longest,
so nobody plays back-to-back. Run with --check to only verify fixtures.txt.
"""
import itertools, pathlib, sys

here = pathlib.Path(__file__).resolve().parent

def groups():
    gs = {}
    for l in (here / 'groups.txt').read_text().splitlines():
        l = l.strip()
        if not l or l.startswith('#'): continue
        if l.lower().startswith('group'): g = l.split()[-1]; gs[g] = []
        else: gs[g].append(l)
    return gs

def order(gs):
    left = [(g, a, b) for g, ts in gs.items() for a, b in itertools.combinations(ts, 2)]
    last, out = {}, []
    while left:
        # ponytail: greedy, not optimal; fine for 22 matches
        rest = lambda m: (min(len(out) - last.get(t, -9) for t in m[1:]), sum(len(out) - last.get(t, -9) for t in m[1:]))
        m = max(left, key=rest)  # ties keep group order A, B, C, D
        left.remove(m); out.append(m)
        for t in m[1:]: last[t] = len(out) - 1
    return out

def check(ms):
    for i in range(1, len(ms)):
        assert not set(ms[i][1:]) & set(ms[i - 1][1:]), f'back-to-back at match {i + 1}: {ms[i]}'

if __name__ == '__main__':
    f = here / 'fixtures.txt'
    if '--check' not in sys.argv:
        ms = order(groups())
        check(ms)
        f.write_text('# Group stage, in playing order:  Group, Home v Away[, time]\n'
                     + ''.join(f'{g}, {a} v {b}\n' for g, a, b in ms))
    ms = [(g.strip(), *[t.strip() for t in rest.split(',')[0].split(' v ')]) for g, rest in
          (l.split(',', 1) for l in f.read_text().splitlines() if l.strip() and not l.startswith('#'))]
    check(ms)
    print(f.read_text())
