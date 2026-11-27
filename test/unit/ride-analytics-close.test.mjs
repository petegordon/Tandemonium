// #887 · every way out of a ride closes its analytics row, and a new ride gets a new row.
// (A co-op ride left through the room stayed open: the tutorial after it was saved on the
// Grandma's row, as finished, and every later achievement carried the first ride's id.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const gameSrc = readFileSync(new URL('../../js/game.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The source of one Game method, from its signature to the closing brace at its indent. */
function method(name) {
  const start = gameSrc.search(new RegExp(`\\n  ${name}\\([^)]*\\) \\{\\n`));
  assert.ok(start >= 0, `${name} not found`);
  const end = gameSrc.indexOf('\n  }\n', start);
  return gameSrc.slice(start, end + 4);
}

// ---- the analytics client ----

test('an abandoned ride row gets how long it was open; a finish keeps its own race time', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) }); return { ok: true, status: 200, headers: { get: () => null } }; };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test Electron' }, configurable: true });
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.setInterval = () => 0;
  const a = await import('../../js/analytics.js');
  a.initSession({ device_type: 'desktop' });
  a.setAnalyticsAllowed(true);

  const first = a.startRide({ level: 'grandma', role: 'captain' });
  a.endRide({ completed: false, abandon_reason: 'room' });
  const put1 = calls.find((c) => c.method === 'PUT' && c.url.includes(first));
  assert.equal(typeof put1.body.duration_ms, 'number');
  assert.ok(put1.body.duration_ms >= 0);
  assert.ok(put1.body.ended_at);
  assert.equal(a.getCurrentRideId(), null);

  const second = a.startRide({ level: 'tutorial', role: 'captain' });
  assert.notEqual(second, first, 'a new ride, a new id');
  a.endRide({ completed: true, duration_ms: 123000 });
  const put2 = calls.find((c) => c.method === 'PUT' && c.url.includes(second));
  assert.equal(put2.body.duration_ms, 123000);
  const post2 = calls.find((c) => c.method === 'POST' && c.body.id === second);
  assert.equal(post2.body.level, 'tutorial');
});

// ---- the game's ways out of a ride ----

test('_closeRideAnalytics ends the open row with what the ride knows, once', () => {
  const body = method('_closeRideAnalytics').replace(/^\n  _closeRideAnalytics\(reason, extra = \{\}\) \{/, '').replace(/\n  \}\n?$/, '');
  const ended = [];
  let open = 'ride-1';
  const analytics = { getCurrentRideId: () => open, endRide: (o) => { ended.push(o); open = null; } };
  const close = new Function('analytics', `return function (reason, extra = {}) {${body}\n}`)(analytics);
  // #890: the row itself is built by _rideAnalyticsRow (the exit flush reads it too).
  const rowBody = method('_rideAnalyticsRow').replace(/^\n  _rideAnalyticsRow\(reason\) \{/, '').replace(/\n  \}\n?$/, '');
  const _rideAnalyticsRow = new Function(`return function (reason) {${rowBody}\n}`)();
  const game = {
    _rideAnalyticsRow,
    mode: 'stoker',
    bike: { distanceTraveled: 80.4 },
    raceManager: { getSummary: (d) => ({ checkpointsPassed: 1, checkpointsTotal: 3, collectibles: 2, collectiblesTotal: 9, crashes: 4, timeoutCount: 0, restarts: 3, distance: d }) },
    contributionTracker: { getSummary: () => ({ mode: 'multiplayer', maxSpeed: 9, avgSpeed: 4, captain: { totalTaps: 50 }, stoker: { totalTaps: 40, correctTaps: 35, wrongTaps: 5 } }) },
  };
  close.call(game, 'room');
  close.call(game, 'lobby');   // already closed: nothing more
  assert.equal(ended.length, 1);
  assert.deepEqual(ended[0], {
    completed: false, abandon_reason: 'room', distance: 80.4,
    checkpoints_passed: 1, checkpoints_total: 3, collectibles: 2, collectibles_total: 9,
    crash_count: 4, timeout_count: 0, restarts: 3,
    pedal_taps: 40, pedal_correct: 35, pedal_wrong: 5, max_speed: 9, avg_speed: 4,
  });

  open = 'ride-2';
  close.call({ _rideAnalyticsRow, mode: 'captain', bike: null, raceManager: null, contributionTracker: null }, null, { duration_ms: 5 });
  assert.deepEqual(ended[1], { completed: true, distance: 0, duration_ms: 5 });
});

test('back to the room, back to the lobby, and the stoker\'s tutorial end all close the ride', () => {
  assert.match(method('_returnToRoom'), /this\._closeRideAnalytics\(fromPartner \? 'partner_room' : 'room'\)/);
  assert.match(method('_returnToLobby'), /this\._closeRideAnalytics\('lobby'\)/);
  assert.match(method('_showStokerTutorialComplete'), /this\._closeRideAnalytics\(null,/);
  assert.match(method('_tutorialComplete'), /this\._closeRideAnalytics\(null,/);
  // Closed before the ride's numbers are thrown away.
  for (const m of ['_returnToRoom', '_returnToLobby']) {
    const src = method(m);
    assert.ok(src.indexOf('_closeRideAnalytics') < src.indexOf('this.raceManager = null'), m);
  }
});

test('a new ride (not a retry of the same one) closes an open row before it builds its race', () => {
  const src = method('_startCountdown');
  const close = src.indexOf("if (!this._sameRideNext || !this._rideRef) this._closeRideAnalytics('new_ride')");
  assert.ok(close > 0, 'the new-ride close');
  assert.ok(close < src.indexOf('this.raceManager = new RaceManager(level)'), 'before the old race is replaced');
  assert.ok(close < src.indexOf('analytics.startRide('), 'before the new row starts');
});
