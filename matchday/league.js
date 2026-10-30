// League data + points table logic. Used by matchday.html; `node league.test.js` checks it.

const TEAMS = [
  ['Junior Ballers Tamghas', 'JBT'],
  ['Resunga Eight', 'RE8'],
  ['Darbar Futsal Team', 'DFT'],
  ['Four Star Warriors', 'FSW'],
  ['Cocktails Youth Club', 'CYC'],
  ['Bhadgaun Ward No. 3', 'BW3'],
  ['Real Tamghas', 'RTM'],
  ['Kapey Tribe', 'KPT'],
  ['Khukuri Youth Club', 'KYC'],
  ['14 Star Youth Club', '14SYC'],
  ['Da Boys', 'DAB'],
  ['PTB Guys', 'PTB'],
  ['Navayug Yuwa Club', 'NYC'],
].map(([name, code]) => ({ name, code }));

// Accept a full name or short code, any case. Unknown names throw so typos show up instead of a wrong table.
function team(s) {
  const k = String(s).trim().toLowerCase();
  const t = TEAMS.find(t => t.name.toLowerCase() === k || t.code.toLowerCase() === k);
  if (!t) throw new Error(`Unknown team: "${s}"`);
  return t;
}

// One result per line: "Da Boys 2-1 Real Tamghas". Blank lines and # comments are ignored.
// A tie-break shootout adds "(pens)": "Da Boys 4-3 Real Tamghas (pens)". It only breaks ties, never adds points or goals.
function parseResults(text) {
  return text.split(/\n|\|/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const pens = /\s*\(pens\)$/i.test(l);
    const m = l.replace(/\s*\(pens\)$/i, '').match(/^(.+?)\s+(\d+)\s*-\s*(\d+)\s+(.+)$/);
    if (!m) throw new Error(`Can't read result: "${l}" (expected "Home 2-1 Away")`);
    if (pens && m[2] === m[3]) throw new Error(`A shootout needs a winner: "${l}"`);
    return { home: team(m[1]), hg: +m[2], ag: +m[3], away: team(m[4]), pens };
  });
}

// Mini-table of only the games between `names` (the teams level on points).
function headToHead(results, names) {
  const s = new Map(names.map(n => [n, { pts: 0, gd: 0, pens: 0 }]));
  for (const r of results) {
    const h = s.get(r.home.name), a = s.get(r.away.name);
    if (!h || !a) continue;
    if (r.pens) { (r.hg > r.ag ? h : a).pens++; continue; }
    h.gd += r.hg - r.ag; a.gd += r.ag - r.hg;
    if (r.hg > r.ag) h.pts += 3; else if (r.hg < r.ag) a.pts += 3; else { h.pts++; a.pts++; }
  }
  return s;
}

// Win 3, draw 1. Teams level on points are separated by:
//   1. head-to-head points between them, 2. head-to-head goal difference, 3. penalty shootout (a "(pens)" line).
// Until a needed shootout is played, overall GD, goals scored, then name keep the order stable; that order is provisional.
// ponytail: 3+ team ties use one mini-league among all of them, no re-run of the mini-league once some are separated.
function table(results, teams = TEAMS) {
  const rows = new Map(teams.map(t => [t.name, { team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }]));
  const games = results.filter(r => !r.pens);
  for (const r of games) {
    const h = rows.get(r.home.name), a = rows.get(r.away.name);
    h.p++; a.p++; h.gf += r.hg; h.ga += r.ag; a.gf += r.ag; a.ga += r.hg;
    if (r.hg > r.ag) { h.w++; a.l++; } else if (r.hg < r.ag) { a.w++; h.l++; } else { h.d++; a.d++; }
  }
  const all = [...rows.values()].map(r => ({ ...r, gd: r.gf - r.ga, pts: r.w * 3 + r.d }));
  const h2h = new Map();  // pts -> head-to-head mini-table for the teams on that many points
  for (const pts of new Set(all.map(r => r.pts)))
    h2h.set(pts, headToHead(results, all.filter(r => r.pts === pts).map(r => r.team.name)));
  return all.sort((x, y) => {
    if (y.pts !== x.pts) return y.pts - x.pts;
    const m = h2h.get(x.pts), a = m.get(x.team.name), b = m.get(y.team.name);
    return b.pts - a.pts || b.gd - a.gd || b.pens - a.pens
      || y.gd - x.gd || y.gf - x.gf || x.team.name.localeCompare(y.team.name);
  });
}

// groups.txt: a "Group X" line, then one team per line. Every team must be in exactly one group.
function parseGroups(text) {
  const groups = [];
  for (const l of text.split(/\n|\|/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
    if (/^group\b/i.test(l)) groups.push({ name: l, teams: [] });
    else if (!groups.length) throw new Error(`Team "${l}" is above the first "Group" line`);
    else groups.at(-1).teams.push(team(l));
  }
  const seen = groups.flatMap(g => g.teams.map(t => t.name));
  const dup = seen.find((n, i) => seen.indexOf(n) !== i);
  if (dup) throw new Error(`${dup} is in more than one group`);
  const missing = TEAMS.filter(t => !seen.includes(t.name)).map(t => t.name);
  if (missing.length) throw new Error(`Not in any group: ${missing.join(', ')}`);
  return groups;
}

// One table per group. A result between teams from different groups is a mistake (or a knockout game,
// which doesn't belong in results.txt), so it throws instead of being silently dropped.
function groupTables(results, groups) {
  const groupOf = t => groups.find(g => g.teams.includes(t));
  for (const r of results)
    if (groupOf(r.home) !== groupOf(r.away)) throw new Error(`${r.home.name} and ${r.away.name} are in different groups`);
  return groups.map(g => ({ name: g.name, rows: table(results.filter(r => groupOf(r.home) === g), g.teams) }));
}

if (typeof module !== 'undefined') module.exports = { TEAMS, team, parseResults, table, parseGroups, groupTables };
