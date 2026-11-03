// Bump ?v= in the pages' <script src="live.js?v=N"> when this changes: GitHub Pages lets phones cache it for 10 min.
// Live scoreboard state (Supabase table `live`, one row), shared by overlay, control, screen and the hub. Needs ../db.js first.
// Anyone can read it (so PRISM/OBS can show it from anywhere); writing needs an editor sign-in.
let serverOffset = 0;  // phone clocks drift; the database tells us how far off we are
rpc('now_ms').then(t => serverOffset = t - Date.now(), () => {});
// hc/ac = kit colours; scene = auto | soon | match | break; match = id of the match on air (its goals set hs/as)
const LIVE_DEFAULT = { home: '', away: '', hs: 0, as: 0, period: '1st Half', show: true, elapsed: 0, since: null, hc: '', ac: '', scene: 'auto', ticker: true, ad: null, match: null };
// lay = { x, y, zoom, tb, side } overlay positions set from the control page; guide = draw the widget's edges (for lining it up in PRISM); ticker = sponsor strip on/off; ad = { src, until } sponsor ad popped over the stream until that server time
const serverNow = () => Date.now() + serverOffset;
const clockOf = s => s.elapsed + (s.since ? Math.max(0, Date.now() + serverOffset - s.since) / 1000 : 0);

// cb(state) on every change, and 4x a second so the clock ticks.
function onLive(cb) {
  if (new URLSearchParams(location.search).has('nolive')) return;  // ?nolive = local test: page.render(state) by hand
  let s = null;  // nothing to draw until the first state arrives
  const tick = () => s && cb({ ...s, clock: clockOf(s), running: !!s.since });
  const set = state => { s = { ...LIVE_DEFAULT, ...state }; tick(); };
  const load = () => sb.from('live').select('state').eq('id', 1).single().then(r => r.data && set(r.data.state));
  sb.channel('live-' + Math.random()).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'live' }, p => set(p.new.state))
    .subscribe(st => st === 'SUBSCRIBED' && load());  // (re)connected: catch up on anything missed
  load();
  setInterval(tick, 250);
}

// clock 'start' | 'stop' | 'reset' | seconds, plus home/away/hs/as/period/show/... Merged on the server ("now" = server time).
function patchLive(s, p) {
  const u = {};
  if (p.clock === 'start' && !s.since) u.since = 'now';
  if (p.clock === 'stop' && s.since) { u.elapsed = clockOf(s); u.since = null; }
  if (p.clock === 'reset') { u.elapsed = 0; u.since = null; }
  if (typeof p.clock === 'number') { u.elapsed = Math.max(0, p.clock); u.since = s.since ? 'now' : null; }
  for (const k of ['home', 'away', 'period', 'show', 'hc', 'ac', 'scene', 'ticker', 'ad', 'guide', 'lay', 'match']) if (k in p) u[k] = p[k];
  if (p.clock === 'start' && s.scene === 'soon') u.scene = 'auto';  // kick-off takes Starting Soon off air
  for (const k of ['hs', 'as']) if (k in p) u[k] = Math.max(0, +p[k] || 0);
  return rpc('live_patch', { p: u }).then(r => { if (!r) throw new Error('Not saved: sign in with an editor account.'); });
}

// Fixed 1920x1080 pages scale to whatever size the OBS browser source or PRISM web widget gives them.
// center = full-screen scenes: the content (el) stays whole and centred; the page's own background fills the rest of the box.
function fitStage(center = false, el = document.body) {
  const fit = () => {
    const k = Math.min(innerWidth / 1920, innerHeight / 1080);
    const dx = center ? (innerWidth - 1920 * k) / 2 : 0, dy = center ? (innerHeight - 1080 * k) / 2 : 0;
    el.style.transformOrigin = '0 0';
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
  };
  addEventListener('resize', fit); fit();
}

// Sponsors of the latest season (table `sponsors`): [{ name, line, logo, ad }], image paths ready to use from live/ pages.
const loadSponsors = () => sb.from('sponsors').select('*').order('season', { ascending: false }).order('sort').then(ok).then(rows =>
  rows.filter(x => x.season === rows[0].season).map(x => ({ name: x.name, line: x.line || '', logo: x.logo && `../Sponsors/${x.logo}`, ad: x.ad && `../Sponsors/${x.ad}` })));
