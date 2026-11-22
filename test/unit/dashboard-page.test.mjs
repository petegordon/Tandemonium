// The dashboard page: a strict content policy, a pinned chart library, and every API value
// escaped where it is written into HTML, even when it reaches the renderers uncleaned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../../dashboard/index.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../../dashboard/dashboard.js', import.meta.url), 'utf8');
const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
const directive = (name) => (policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '').split(/\s+/).slice(1);

test('the content policy is strict and allows what the page uses', () => {
  assert.deepEqual(directive('default-src'), ["'none'"]);
  const scripts = directive('script-src');
  assert.ok(!scripts.includes("'unsafe-inline'") && !scripts.includes("'unsafe-eval'"));
  assert.ok(scripts.includes("'self'"));
  assert.ok(scripts.includes('https://accounts.google.com/gsi/client'), 'Google sign-in');
  assert.ok(directive('frame-src').includes('https://accounts.google.com/gsi/'));
  assert.ok(directive('connect-src').includes('https://accounts.google.com/gsi/'));
  assert.ok(directive('style-src').includes('https://accounts.google.com/gsi/style'));
  assert.deepEqual(directive('base-uri'), ["'none'"]);
  assert.deepEqual(directive('form-action'), ["'none'"]);
  const api = js.match(/const API_BASE = '([^']+)'/)[1];
  assert.ok(directive('connect-src').includes(api), 'the API the page calls');
});

test('the page has no inline script or handler for the policy to block', () => {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /\ssrc=/, 'every script is a file');
    assert.equal(m[2].trim(), '');
  }
  assert.ok(!/<[^>]+\son[a-z]+\s*=/i.test(html), 'no handler attributes in the page');
  assert.ok(!/\son(click|change|load|error)\s*=\s*["']/i.test(js), 'none in the HTML the script writes');
});

test('the chart library is an exact version with an integrity hash the policy names', () => {
  const tag = html.match(/<script src="(https:\/\/cdn\.jsdelivr\.net[^"]+)" integrity="(sha384-[A-Za-z0-9+/=]{64})" crossorigin="anonymous">/);
  assert.ok(tag, 'pinned tag');
  assert.match(tag[1], /chart\.js@\d+\.\d+\.\d+\/dist\/chart\.umd\.min\.js$/);
  assert.ok(directive('script-src').includes(tag[1]));
});

test('Google\'s callback is defined before Google\'s script loads', () => {
  assert.ok(html.indexOf('/dashboard/dashboard.js') < html.indexOf('accounts.google.com/gsi/client"'.replace('"', '" async')));
  assert.match(js, /^async function onGoogleSignIn/m);
});

// ── Escaping ──
const MARK = '<img src=x onerror=boom>';
function loadPage() {
  const el = () => ({ value: '7', style: {}, checked: false, textContent: '', innerHTML: '', addEventListener() {} });
  const els = {};
  const store = () => ({ getItem: () => null, setItem() {}, removeItem() {} });
  const ctx = {
    document: { getElementById: (id) => (els[id] ||= el()), addEventListener() {} },
    sessionStorage: store(), localStorage: store(), console, location: { reload() {} },
    setInterval() {}, clearInterval() {}, fetch: async () => ({ ok: false, status: 500 }),
  };
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  return ctx;
}
/** Any field a renderer reads returns the marker (numbers too: it must not rely on them being numbers). */
const oddRow = (extra = {}) => new Proxy({ ...extra }, {
  get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? MARK : undefined),
});

const CASES = {
  renderTutorialTable: () => [[oddRow()]],
  renderPhaseTable: () => [[oddRow()]],
  renderSoloToMp: () => [oddRow()],
  renderRidesTable: () => [[oddRow()]],
  renderAbandonsTable: () => [[oddRow()]],
  renderNetworkHealth: () => [oddRow()],
  renderInputTable: () => [[oddRow()]],
  renderControllerTable: () => [[oddRow()]],
  renderBrowserTable: () => [[{ user_agent: `Android 14; ${MARK} Build/x)`, sessions: 3 }]],
  renderSessionDurationTable: () => [[oddRow()]],
  renderQualityTable: () => [[oddRow()]],
  renderPerformanceTable: () => [[oddRow()]],
  renderSimpleTable: () => [[oddRow()], ['level', 'cause']],
  renderTable: () => [[oddRow()], ['level', 'cause']],
  renderRetention: () => [{ cohorts: [oddRow({ d1: 0.5, d7: 0.2 })], overall: { d1: 0.1, d7: 0.1 }, coverage: oddRow() }],
  renderFirstRide: () => [{ first_ride: { n: MARK, completed: 1, avg_ms: 5 } }],
  renderCrashRecover: () => [{ crash_recover: { n: MARK, avg_ms: 5 } }],
  renderPairs: () => [{ pairs: [oddRow()], total_pairs: MARK, repeat_pairs: MARK, repeat_share: 0.5, median_days_between_rides: MARK, note: MARK }],
  renderPlayers: () => [{ note: MARK, players: [
    { guest: false, sign_ins: [{ name: MARK, provider: MARK }], platforms: MARK, minutes: 5, seat_rides: 1, seat_minutes: 2, days: MARK, sessions: MARK, rides: MARK, finished: MARK, controllers: MARK, first_seen: MARK, last_seen: MARK },
    { guest: false, sign_ins: [], acct: MARK, platforms: 'steam', minutes: 5 },
  ] }],
  renderTouristCosts: () => [{
    total_usd: 1, active_players: 1, cost_per_player: 1,
    today_of_cap: { tiles: MARK, geocode: MARK, elevation: MARK }, caps: { tiles: MARK, geocode: MARK, elevation: MARK },
    months: [{ month: MARK, cost: { total: 1 } }], days: [{ day: MARK }], top_players: [{ who: MARK, sessions: 1, lookups: 1 }],
  }],
};

for (const [fn, args] of Object.entries(CASES)) {
  test(`${fn} escapes what the API sends`, () => {
    const page = loadPage();
    page.__args = args();
    const out = vm.runInContext(`${fn}(...__args)`, page);
    assert.equal(typeof out, 'string');
    assert.ok(!out.includes('<img'), `${fn} wrote markup: ${out.slice(0, 200)}`);
  });
}

test('every renderer in the page is covered above', () => {
  const declared = [...js.matchAll(/^function (render\w+)\(/gm)].map((m) => m[1]).filter((n) => n !== 'renderDashboard');
  assert.deepEqual(declared.filter((n) => !(n in CASES)), []);
});

test('a site build carries the page script', async () => {
  const { isPublished } = await import('../../scripts/build-site.mjs');
  assert.equal(isPublished('dashboard/dashboard.js'), true);
});
