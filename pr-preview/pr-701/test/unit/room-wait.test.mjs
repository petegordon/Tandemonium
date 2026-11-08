// #694 · RoomWait views (js/lobby/room-wait.js): who, how long, what you can do. Pure views
// with a fake clock; RoomSession's use of them is in room-session.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roomWaitView, fmtClock, fmtAgo, fmtSpan, IdleWatch, ActivityPinger, RoomWait, ROOM_WAIT_COPY, ROOM_WAIT_MS } from '../../js/lobby/room-wait.js';

const base = (o) => ({ seat: 'host', kind: 'create', code: 'TNDM-ABCD', role: 'captain', partner: null, startedAt: 0, openAt: null, absentAt: null, retryAt: null, outShown: false, ...o });

test('clock and spans', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(34999), '0:30');
  assert.equal(fmtClock(35000), '0:35');
  assert.equal(fmtClock(65000), '1:05');
  assert.equal(fmtAgo(20000), 'just now');
  assert.equal(fmtAgo(3 * 60000 + 5000), '3 min ago');
  assert.equal(fmtSpan(2 * 3600000 + 1), '2 h');
  assert.equal(fmtSpan(3 * 86400000), '3 days');
});

test('the copy names the partner, else their role', () => {
  assert.equal(ROOM_WAIT_COPY.partner({ name: 'Pete', role: 'captain' }), 'Pete (your Captain)');
  assert.equal(ROOM_WAIT_COPY.partner({ role: 'stoker' }), 'your Stoker');
  assert.equal(ROOM_WAIT_COPY.idle({ name: 'Pete', role: 'captain' }, '1:00'), "Your Captain (Pete) hasn't moved for 1:00");
  assert.equal(ROOM_WAIT_COPY.dropTitle({ role: 'stoker' }), 'Your Stoker lost connection');
  assert.equal(ROOM_WAIT_COPY.dropTitle({ name: 'Pete', role: 'captain' }), 'Pete (your Captain) lost connection');
});

test('A counts up only after 0:30; nothing before the room opens', () => {
  assert.equal(roomWaitView(base(), 1000), null);
  const s = base({ openAt: 0 });
  assert.match(roomWaitView(s, 29999).text, /^You're the only one in room ABCD\./);
  assert.match(roomWaitView(s, 35000).text, /Waiting 0:35…$/);
  assert.deepEqual(roomWaitView(s, 99999).actions, []);
});

test('B waits for the relay (or 3 s), then offers the way out at 0:15', () => {
  const s = base({ seat: 'join', kind: 'join', role: 'stoker', openAt: 0 });
  assert.equal(roomWaitView(s, 2000), null);
  assert.equal(roomWaitView(s, 3000).kind, 'B');
  assert.deepEqual(roomWaitView(s, 14999).actions, []);
  const v = roomWaitView(s, 15000);
  assert.deepEqual(v.actions.map((a) => a.id), ['keep', 'other-code']);
  assert.equal(v.focus, 'keep', 'focus on the waiting choice');
});

test('C → D as the last-seen time ages past 10 min; D offers the way out at once', () => {
  const s = base({ kind: 'rejoin', partner: { name: 'Pat', seenAt: 0 }, startedAt: 9 * 60000, openAt: 9 * 60000 });
  const c = roomWaitView(s, 9 * 60000);
  assert.equal(c.kind, 'C');
  assert.match(c.text, /Pat \(your Stoker\) was here 9 min ago/);
  const d = roomWaitView(s, ROOM_WAIT_MS.recentSeen);
  assert.equal(d.kind, 'D');
  assert.deepEqual(d.actions.map((a) => a.id), ['keep', 'new-room']);
});

test('E beats every other view while the room never opened; never partner wording', () => {
  for (const kind of ['create', 'join', 'rejoin']) {
    const v = roomWaitView(base({ kind, partner: { name: 'Pat', seenAt: 1 } }), ROOM_WAIT_MS.unreachable);
    assert.equal(v.kind, 'E', kind);
    assert.ok(!/Pat|partner|Captain|Stoker/.test(v.text), v.text);
    assert.equal(v.focus, 'retry');
  }
});

test('RoomWait: a way out once shown stays, even if the clock goes back', () => {
  let now = 0;
  const seen = [];
  const w = new RoomWait({ render: (seat, v) => seen.push(v), now: () => now, setInterval: () => 1, clearInterval: () => {} });
  w.begin({ seat: 'join', kind: 'join', code: 'TNDM-WXYZ', role: 'stoker' });
  w.roomOpen(); w.partnerAbsent();
  now = 20000; w.tick();
  assert.equal(seen.at(-1).actions.length, 2);
  now = 1000; w.tick();
  assert.equal(w.view().actions.length, 2);
  w.end();
  assert.equal(seen.at(-1), null);
});

test("IdleWatch: silent until the partner's build pings; then \"hasn't moved\" from 0:30 in 5 s steps; clears when they act", () => {
  let now = 0;
  const w = new IdleWatch({ now: () => now });
  const p = { name: 'Pete', role: 'captain' };
  now = 120000;
  assert.equal(w.text(p), '', 'an old build (never pings) never shows idle');
  w.heard(true);
  now += 29999; assert.equal(w.text(p), '');
  now += 1; assert.equal(w.text(p), "Your Captain (Pete) hasn't moved for 0:30");
  now += 7000; assert.equal(w.text(p), "Your Captain (Pete) hasn't moved for 0:35");
  w.heard(false);
  assert.equal(w.text(p), '');
});

test('ActivityPinger: at most one ping per period, and only after a change', () => {
  let now = 0; let sent = 0;
  const a = new ActivityPinger({ send: () => sent++, now: () => now, every: 4000 });
  assert.equal(a.pump(), true, 'the first goes at once');
  assert.equal(a.pump(), false, 'nothing new');
  a.mark(); now = 1000;
  assert.equal(a.pump(), false, 'too soon');
  now = 4000;
  assert.equal(a.pump(), true);
  now = 99999;
  assert.equal(a.pump(), false, 'no change, no ping');
  assert.equal(sent, 2);
});
