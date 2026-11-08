// smoke-account-stats.mjs — housetandem-web #37: the riding stats on the House Tandem account.
//
//   node scripts/smoke-account-stats.mjs
//
// The API is faked in the page (window.fetch) on top of the real merge
// (worker/games.js · mergeStats), so no network:
//   A. Signed in with 600 m ridden on this device: the stats go up to the
//      account; the badge they earn arrives as one note, not a toast.
//   B. Sign out: the device's stats and badges are reset (and stay reset
//      after a reload); a short ride signed out doesn't re-award First 500m.
//   C. Sign back in: the 600 m come back, plus the 100 m ridden signed out.
//   D. Time in game is reported to /games/tandemonium/sync while signed in.
import { startHarness } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8981, outDir: 'smoke-account-stats' });
const { check } = h;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = b64({ alg: 'HS256' }) + '.' + b64({ sub: 7, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
const USER = JSON.stringify({ id: 'd7', name: 'Pete', serverId: 7, provider: 'discord', identities: { discord: { name: 'Pete' } } });

/** Before any game script: seed this device once (not on reloads), and fake the API. */
function setup({ token, user }) {
  if (!sessionStorage.getItem('__seeded')) {
    sessionStorage.setItem('__seeded', '1');
    localStorage.setItem('tandemonium_tutorial_done', 'smoke');
    localStorage.setItem('tandemonium_auth_token', token);
    localStorage.setItem('tandemonium_auth_user', user);
    localStorage.setItem('tandemonium_achievement_stats', JSON.stringify({ v: 2, cumulativeDistance: 600, rides: 3, bests: {}, bestsAt: {} }));
  }
  const state = (window.__api = JSON.parse(sessionStorage.getItem('__api') || '{"stats":{},"ach":[],"syncs":0,"seconds":0,"timeReports":0}'));
  const save = () => sessionStorage.setItem('__api', JSON.stringify(state));
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const mergeP = import('/worker/games.js').then((m) => m.mergeStats);
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    if (!/tandemonium-api|workers\.dev/.test(url)) return realFetch(input, init);
    const p = new URL(url).pathname;
    if (p === '/me') return json({ user: { id: 7, display_name: 'Pete', identities: { discord: { name: 'Pete' } } }, achievements: state.ach.map((id) => ({ achievement_id: id, earned_at: '2026-11-08' })), bestScores: [] });
    if (p === '/achievements/sync') {
      for (const id of JSON.parse(init.body || '{}').achievements || []) if (!state.ach.includes(id)) state.ach.push(id);
      save();
      return json({ achievements: state.ach.map((id) => ({ achievement_id: id, earned_at: '2026-11-08' })) });
    }
    if (p === '/games/tandemonium/sync') {
      const body = JSON.parse(init.body || '{}');
      if (body.delta) { state.stats = (await mergeP)(state.stats, body.delta); state.syncs++; }
      if (body.seconds) { state.seconds += body.seconds; state.timeReports++; }
      save();
      return json({ game: 'tandemonium', stats: state.stats, playtime: { seconds: state.seconds } });
    }
    return json({ error: 'not faked' }, 404);
  };
}

const page = await h.gamePage({
  viewport: { width: 1280, height: 800 },
  before: (pg) => pg.evaluateOnNewDocument(setup, { token: TOKEN, user: USER }),
});
const api = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('__api') || '{}'));
const local = () => page.evaluate(() => {
  const g = window._game;
  return {
    distance: g.achievements.getStats().cumulativeDistance,
    earned: g.achievements.getEarnedIds(),
    toasts: document.querySelectorAll('.achievement-toast').length,
    notes: Array.from(document.querySelectorAll('.info-toast')).map((t) => t.textContent),
    signedIn: !!localStorage.getItem('tandemonium_auth_token'),
    base: JSON.parse(localStorage.getItem('tandemonium_achievement_stats_base') || 'null'),
  };
});
const waitFor = (fn, arg, timeout = 30000) => page.waitForFunction(fn, { timeout, polling: 200 }, arg).then(() => true).catch(() => false);

// ── A. signed in: up to the account, one quiet note ──
let ok = await waitFor(() => { const s = JSON.parse(sessionStorage.getItem('__api') || '{}'); return s.stats && s.stats.cumulativeDistance === 600; });
let s = await api();
check(ok && s.stats.rides === 3, 'A: the device\'s 600 m and 3 rides reach the account', s.stats);
ok = await waitFor(() => window._game.achievements.getEarnedIds().includes('first_500m'));
let l = await local();
check(ok, 'A: the merged stats earn First 500m', l.earned);
check(l.toasts === 0, 'A: no toast per badge after a sign-in merge', l.toasts);
check(l.notes.some((n) => /achievements from your riding|First 500m/.test(n)), 'A: one note instead', l.notes);
check(l.base && l.base.user === '7' && l.base.add.cumulativeDistance === 600, 'A: the synced baseline is the account\'s', l.base);
await h.shot(page, 'A-signed-in');

// ── D. time in game ──
await page.evaluate(() => window._game.playtime.flush());
ok = await waitFor(() => { const s = JSON.parse(sessionStorage.getItem('__api') || '{}'); return s.timeReports > 0; });
check(ok, 'D: time in game is reported while signed in', (await api()).seconds);

// ── B. sign out: reset, and nothing comes back ──
await page.evaluate(() => document.getElementById('profile-popup-logout').click());
ok = await waitFor(() => !localStorage.getItem('tandemonium_auth_token') && window._game.achievements.getStats().cumulativeDistance === 0);
l = await local();
check(ok && l.earned.length === 0, 'B: sign-out resets the device\'s stats and badges', l);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 90000 });
l = await local();
check(l.distance === 0 && !l.signedIn, 'B: still empty after a reload (nothing re-seeded)', l);
const after = await page.evaluate(() => {
  window._game.achievements.record('ride', { newRide: true, metres: 100, mode: 'grandma' });
  return window._game.achievements.getEarnedIds();
});
check(!after.includes('first_500m'), 'B: a 100 m ride signed out does not re-award First 500m', after);
const before = (await api()).stats.cumulativeDistance;
check(before === 600, 'B: nothing signed out reached the account', before);

// ── C. sign back in: the progress returns ──
await page.evaluate(({ token, user }) => {
  localStorage.setItem('tandemonium_auth_token', token);
  localStorage.setItem('tandemonium_auth_user', user);
}, { token: TOKEN, user: USER });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 90000 });
ok = await waitFor(() => window._game.achievements.getStats().cumulativeDistance === 700);
l = await local();
check(ok, 'C: signed in again, the account\'s 600 m come back (+ the 100 m ridden signed out)', l.distance);
check(l.earned.includes('first_500m') && l.toasts === 0, 'C: First 500m is back, quietly', { earned: l.earned, toasts: l.toasts });
s = await api();
check(s.stats.cumulativeDistance === 700, 'C: the account counts the signed-out 100 m once', s.stats.cumulativeDistance);
await h.shot(page, 'C-signed-in-again');

await page.close();
await h.finish();
