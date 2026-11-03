// TSL data in Supabase (Postgres). Anyone can read; only editors can write (rules: supabase/schema.sql).
// Pages load supabase-js first: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
const sb = supabase.createClient('https://bicxaypaaawrvzfeptjp.supabase.co', 'sb_publishable_1uLQL2J9c3_eVAnplpvslg_yGWPZvBR');

const ok = r => { if (r.error) throw r.error; return r.data; };
// Updates and deletes that RLS blocks just touch 0 rows, so ask for the rows back and treat none as "not allowed".
const write = async q => { const d = ok(await q.select()); if (!d.length) throw new Error('Not saved: sign in with an editor account.'); return d; };
const rpc = async (f, args) => ok(await sb.rpc(f, args));

// Organiser sign-in (users made in Supabase → Authentication, listed in the editors table). cb(user | null) now and on every change.
const onUser = cb => sb.auth.onAuthStateChange((_, s) => cb(s?.user || null));
const signIn = async (email, password) => ok(await sb.auth.signInWithPassword({ email, password }));
const signOut = () => sb.auth.signOut();

const to12 = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

// The season (?season=N, else the latest) with its rows, plus the same text/JSON the graphics and league.js have always read.
async function loadSeason() {
  const want = +new URLSearchParams(location.search).get('season');
  const seasons = ok(await sb.from('seasons').select('*').order('id'));
  const season = seasons.find(s => s.id === want) || seasons.at(-1), id = season.id;
  const [teams, st, squad, matches, sponsors] = (await Promise.all([
    sb.from('teams').select('*').order('id'), sb.from('season_teams').select('*').eq('season', id),
    sb.from('squad').select('*, players(name)').eq('season', id).order('sort'),
    sb.from('matches').select('*').eq('season', id).order('n'), sb.from('sponsors').select('*').eq('season', id).order('sort'),
  ])).map(ok);
  const ids = matches.map(m => m.id);
  const [goals, events] = (await Promise.all(['goals', 'events'].map(t => sb.from(t).select('*').in('match', ids).order('id')))).map(ok);

  const T = Object.fromEntries(teams.map(t => [t.id, t])), P = Object.fromEntries(squad.map(s => [s.player, s.players.name]));
  const grp = Object.fromEntries(st.map(s => [s.team, s.grp])), pos = Object.fromEntries(matches.map((m, i) => [m.id, String(i + 1)]));
  const inSeason = teams.filter(t => t.id in grp);
  TEAMS.splice(0, TEAMS.length, ...inSeason.map(t => ({ name: t.name, code: t.code })));  // league.js team() now knows this season's teams
  try { localStorage.setItem('tsl-teams', JSON.stringify(TEAMS)); } catch {}            // ...and so do the graphics templates

  const name = id => T[id].name, min = x => x.minute == null ? '' : String(x.minute);
  const pre = m => m.round === 'Group' ? '' : m.round + ': ';
  const text = {
    fixtures: '# Group, Home v Away, time\n' + matches.map(m =>
      `${m.round === 'Group' ? grp[m.home] || '' : m.round}, ${name(m.home)} v ${name(m.away)}${m.kickoff ? ', ' + to12(m.kickoff) : ''}`).join('\n') + '\n',
    results: matches.filter(m => m.status === 'done').flatMap(m => [`${pre(m)}${name(m.home)} ${m.hg}-${m.ag} ${name(m.away)}`,
      ...(m.hp == null ? [] : [`${pre(m)}${name(m.home)} ${m.hp}-${m.ap} ${name(m.away)} (pens)`])]).join('\n') + '\n',
    groups: [...new Set(st.map(s => s.grp).filter(Boolean))].sort().map(g => `Group ${g}\n` +
      st.filter(s => s.grp === g).sort((a, b) => a.sort - b.sort || a.team - b.team).map(s => name(s.team)).join('\n')).join('\n\n') + '\n',
    squads: inSeason.map(t => `${t.name}: ` + squad.filter(s => s.team === t.id)
      .map(s => s.players.name + (s.captain ? ' (C)' : '') + (s.role ? ` (${s.role})` : '')).join('|')).join('\n') + '\n',
    // name '' = unknown scorer (counts in the score, not in scorer lists)
    goals: JSON.stringify(goals.map(g => ({ id: g.id, n: pos[g.match], team: name(g.team), name: g.og ? 'Own Goal' : P[g.player] || '', min: min(g) }))),
    events: JSON.stringify(events.map(e => ({ id: e.id, n: pos[e.match], type: e.kind, team: name(e.team), name: P[e.player], min: min(e) }))),
  };
  return { season, seasons, teams, st, squad, matches, goals, events, sponsors, T, P, text };
}

// cb(season) now and again whenever anything in the season changes (any phone). onErr(e) if it can't load.
function onSeason(cb, onErr = console.error) {
  let t;
  const go = () => loadSeason().then(cb, onErr), soon = () => { clearTimeout(t); t = setTimeout(go, 300); };
  const ch = sb.channel('season-' + Math.random());
  for (const table of ['matches', 'goals', 'events', 'squad', 'players', 'season_teams', 'teams'])
    ch.on('postgres_changes', { event: '*', schema: 'public', table }, soon);
  go();
  ch.subscribe(s => s === 'SUBSCRIBED' && soon());  // also on reconnect: catches what changed while offline
}
