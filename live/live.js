// Bump ?v= in the pages' <script src="live.js?v=N"> when this changes: GitHub Pages lets phones cache it for 10 min.
// Live scoreboard state in Firebase (tsl/live), shared by overlay, control, screen and the hub.
// Anyone can read it (so PRISM/OBS can show it from anywhere); writing needs the organiser sign-in.
firebase.initializeApp(FIREBASE);
const liveRef = firebase.database().ref('tsl/live');
let serverOffset = 0;  // phone clocks drift; Firebase tells us how far off we are
firebase.database().ref('.info/serverTimeOffset').on('value', s => serverOffset = s.val() || 0);
const LIVE_DEFAULT = { home: 'Navayug Yuwa Club', away: 'Da Boys', hs: 0, as: 0, period: '1st Half', show: true, elapsed: 0, since: null, hc: '', ac: '', scene: 'auto', ticker: true, ad: null };  // hc/ac = kit colours; scene = auto | soon | match | break
// ticker = sponsor strip on/off; ad = { src, until } sponsor ad popped over the stream until that server time
const serverNow = () => Date.now() + serverOffset;
const clockOf = s => s.elapsed + (s.since ? Math.max(0, Date.now() + serverOffset - s.since) / 1000 : 0);

// cb(state) on every change, and 4x a second so the clock ticks.
function onLive(cb) {
  if (new URLSearchParams(location.search).has('nolive')) return;  // ?nolive = local test: page.render(state) by hand
  let s = { ...LIVE_DEFAULT };
  const tick = () => cb({ ...s, clock: clockOf(s), running: !!s.since });
  liveRef.on('value', snap => { s = { ...LIVE_DEFAULT, ...snap.val() }; tick(); });
  setInterval(tick, 250);
}

// Same rules as the old laptop /state: clock 'start' | 'stop' | 'reset' | seconds, plus home/away/hs/as/period/show.
function patchLive(s, p) {
  const u = {}, TS = firebase.database.ServerValue.TIMESTAMP;
  if (p.clock === 'start' && !s.since) u.since = TS;
  if (p.clock === 'stop' && s.since) { u.elapsed = clockOf(s); u.since = null; }
  if (p.clock === 'reset') { u.elapsed = 0; u.since = null; }
  if (typeof p.clock === 'number') { u.elapsed = Math.max(0, p.clock); u.since = s.since ? TS : null; }
  for (const k of ['home', 'away', 'period', 'show', 'hc', 'ac', 'scene', 'ticker', 'ad']) if (k in p) u[k] = p[k];
  if (p.clock === 'start' && s.scene === 'soon') u.scene = 'auto';  // kick-off takes Starting Soon off air
  for (const k of ['hs', 'as']) if (k in p) u[k] = Math.max(0, +p[k] || 0);
  return liveRef.update(u);
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

// Sponsors from Sponsors/sponsors.txt: [{ name, line, logo, ad }], image paths ready to use from live/ pages.
const loadSponsors = () => fetch(`../Sponsors/sponsors.txt?t=${Date.now()}`).then(r => r.ok ? r.text() : '').then(t => t.split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const [name, logo, ad, line = ''] = l.split('|').map(x => (x || '').trim());
    return { name, line, logo: logo && `../Sponsors/${logo}`, ad: ad && `../Sponsors/${ad}` };
  }));
