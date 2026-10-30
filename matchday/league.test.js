// Run: node league.test.js
const assert = require('assert');
const { team, parseResults, table, parseGroups, groupTables } = require('./league.js');

assert.equal(team('dab').name, 'Da Boys');
assert.equal(team('bhadgaun ward no. 3').code, 'BW3');
assert.throws(() => team('Nobody FC'), /Unknown team/);

const r = parseResults(`
# matchday 1
Da Boys 2-1 Real Tamghas
Bhadgaun Ward No. 3 2-2 14 Star Youth Club
KPT 0-3 dab
`);
assert.equal(r.length, 3);
assert.deepEqual([r[1].home.code, r[1].hg, r[1].ag, r[1].away.code], ['BW3', 2, 2, '14SYC']);
assert.throws(() => parseResults('Da Boys beat Real Tamghas'), /Can't read/);

const t = table(r);
assert.equal(t.length, 13);
assert.deepEqual([t[0].team.code, t[0].p, t[0].w, t[0].gf, t[0].ga, t[0].gd, t[0].pts], ['DAB', 2, 2, 5, 1, 4, 6]);
// BW3 and 14SYC both 1 pt, GD 0, GF 2 -> alphabetical: "14 Star..." before "Bhadgaun..."
assert.deepEqual(t.slice(1, 3).map(x => x.team.code), ['14SYC', 'BW3']);
assert.equal(t.at(-1).team.code, 'KPT');  // -3 GD, bottom

// Groups
const groups = parseGroups(`Group A\nDAB\nRTM\nKPT\nJBT\nRE8\nDFT\nNYC\nGroup B\nFSW\nCYC\nBW3\nKYC\n14SYC\nPTB`);
assert.deepEqual(groups.map(g => [g.name, g.teams.length]), [['Group A', 7], ['Group B', 6]]);
assert.throws(() => parseGroups('Group A\nDAB'), /Not in any group/);
assert.throws(() => parseGroups('Group A\nDAB\nDAB'), /more than one group/);
assert.throws(() => parseGroups('DAB\nGroup A'), /above the first/);

const gt = groupTables(r, groups);
assert.deepEqual(gt[0].rows.map(x => x.team.code), ['DAB', 'DFT', 'JBT', 'NYC', 'RE8', 'RTM', 'KPT']);
assert.deepEqual(gt[1].rows.slice(0, 2).map(x => [x.team.code, x.pts]), [['14SYC', 1], ['BW3', 1]]);
assert.throws(() => groupTables(parseResults('DAB 1-0 FSW'), groups), /different groups/);

// Tie-breaks: head-to-head beats goal difference, then a (pens) shootout.
const tb = parseResults(`
RTM 1-0 DAB
DAB 5-0 KPT
RTM 0-1 KPT
JBT 1-1 RE8
`);
// DAB, RTM, KPT on 3 pts each; mini-league: each beat one other -> 3 h2h pts each;
// h2h GD decides: DAB +4 (lost 0-1, won 5-0), RTM 0, KPT -4.
assert.deepEqual(table(tb).slice(0, 3).map(x => x.team.code), ['DAB', 'RTM', 'KPT']);
// Two teams level on points: head-to-head winner goes above, even with worse overall GD.
const h = table(parseResults('RTM 1-0 DAB|DAB 5-0 KPT|KPT 1-0 RTM|KPT 0-1 DAB'), [team('DAB'), team('RTM'), team('KPT')]);
// DAB 6 pts; RTM 3, KPT 3 -> KPT beat RTM head to head
assert.deepEqual(h.map(x => x.team.code), ['DAB', 'KPT', 'RTM']);
// Drew head to head -> shootout decides, and the shootout adds no points or goals.
const two = [team('JBT'), team('RE8')];
assert.deepEqual(table(parseResults('JBT 1-1 RE8'), two).map(x => x.team.code), ['JBT', 'RE8']);  // provisional: alphabetical
const pens = table(parseResults('JBT 1-1 RE8|JBT 3-4 RE8 (pens)'), two);
assert.deepEqual(pens.map(x => [x.team.code, x.p, x.pts, x.gf]), [['RE8', 1, 1, 1], ['JBT', 1, 1, 1]]);
assert.throws(() => parseResults('JBT 3-3 RE8 (pens)'), /needs a winner/);

console.log('ok');
