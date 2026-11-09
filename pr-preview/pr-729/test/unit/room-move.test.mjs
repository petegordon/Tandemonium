// #667 · HOST INSTEAD: the room-move message, the cap gating, and the move sequence
// (js/lobby/room-move.js) with fake transports: never stranded, the old room is
// kept until the new one is connected, and an older build never sees the offer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomProtocol, ROOM_MSG, isRoomCode } from '../../js/lobby/room-protocol.js';
import { RoomMove, watchMoveNet, closeQuietly, within } from '../../js/lobby/room-move.js';
import { NetSession } from '../../js/lobby/net-session.js';
import {
  FULL_RULES, DEMO_RULES, ROOM_CAPS, roomProfileFields, partnerFromProfile, canHostInstead, mergeRoomRules, roomBadge,
} from '../../js/edition.js';

test('roomMoved is a typed room message carrying the new code; codes are validated', () => {
  const m = JSON.parse(JSON.stringify(RoomProtocol.roomMoved('TNDM-AB2C')));
  assert.deepEqual(m, { type: ROOM_MSG.ROOM_MOVED, code: 'TNDM-AB2C' });
  assert.equal(ROOM_MSG.ROOM_MOVED, 'roomMoved');
  assert.ok(!Object.values(ROOM_MSG).some((t, i, all) => all.indexOf(t) !== i), 'message types are unique');
  assert.ok(isRoomCode('TNDM-AB2C'));
  for (const bad of ['TNDM-AB1C', 'TNDM-ABO2', 'tndm-ab2c', 'TNDM-AB2', 'TNDM-AB2CD', '', null, 42, 'XXXX-AB2C']) assert.ok(!isRoomCode(bad), String(bad));
});

test("every build advertises the 'rehost' cap", () => {
  assert.ok(ROOM_CAPS.includes('rehost'));
  assert.ok(roomProfileFields(FULL_RULES).caps.includes('rehost'));
  assert.ok(roomProfileFields(DEMO_RULES).caps.includes('rehost'));
});

test('HOST INSTEAD is offered only to a full guest of a demo host whose build follows a move', () => {
  const demoHost = partnerFromProfile({ edition: 'demo', caps: [...ROOM_CAPS] });
  const fullHost = partnerFromProfile({ edition: 'full', caps: [...ROOM_CAPS] });
  const oldDemoHost = partnerFromProfile({ edition: 'demo', caps: ROOM_CAPS.filter((c) => c !== 'rehost') });
  const ancientDemoHost = partnerFromProfile({ edition: 'demo' });   // no caps at all
  assert.equal(canHostInstead(FULL_RULES, demoHost, 'stoker'), true);
  assert.equal(roomBadge(mergeRoomRules(FULL_RULES, demoHost, 'stoker')), 'Demo room', 'the offer is in a Demo room');
  assert.equal(canHostInstead(FULL_RULES, oldDemoHost, 'stoker'), false, 'an older build never sees the button');
  assert.equal(canHostInstead(FULL_RULES, ancientDemoHost, 'stoker'), false);
  assert.equal(canHostInstead(FULL_RULES, fullHost, 'stoker'), false, 'already a Full game room');
  assert.equal(canHostInstead(DEMO_RULES, demoHost, 'stoker'), false, 'a demo guest has nothing to unlock');
  assert.equal(canHostInstead(FULL_RULES, demoHost, 'captain'), false, 'the host already hosts');
  assert.equal(canHostInstead(FULL_RULES, null, 'stoker'), false, 'partner not heard from yet');
  // After the move: the full owner is the captain, and both sides call it a Full game room.
  assert.equal(roomBadge(mergeRoomRules(FULL_RULES, demoHost, 'captain')), 'Full game room');
  assert.equal(roomBadge(mergeRoomRules(DEMO_RULES, fullHost, 'stoker')), 'Full game room');
});

test('within() resolves true before the deadline, false after', async () => {
  assert.equal(await within(Promise.resolve(true), 50), true);
  assert.equal(await within(new Promise(() => {}), 10), false);
  assert.equal(await within(Promise.reject(new Error('x')), 50), false);
});

// ── the move, with fake transports ──

class FakeNet {
  constructor(code = null) {
    this.roomCode = code; this.role = null; this.connected = !!code; this.destroyed = false; this.sent = [];
    this.onRoomJoined = null; this.onConnected = null; this.onDisconnected = null; this.onProfileReceived = null;
    this._partnerLeft = false; this.byeSent = false;
  }
  enterRoom(code, role) { this.roomCode = code; this.role = role; }
  sendProfile(p) { this.sent.push(p); }
  destroy() { if (this.connected && !this._partnerLeft) this.byeSent = true; this.destroyed = true; this.connected = false; }
  // test helpers
  open() { this.onRoomJoined && this.onRoomJoined(); }
  join() { this.connected = true; this.onConnected && this.onConnected(); }
  drop(r = 'Partner disconnected') { this.connected = false; this.onDisconnected && this.onDisconnected(r); }
}

/** openNet that hands out FakeNets and records them. */
function opener() {
  const made = [];
  const openNet = async (code, role) => {
    const net = new FakeNet();
    const mn = watchMoveNet(net);
    net.enterRoom(code, role);
    made.push(net);
    return mn;
  };
  return { made, openNet };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const T = { open: 60, follow: 80, connect: 120 };

test('lead: the new room opens, ROOM_MOVED goes over the old room, the partner arrives → ok', async () => {
  const old = new FakeNet('TNDM-AAAA');
  const { made, openNet } = opener();
  const sent = [];
  const move = new RoomMove({ side: 'lead', old, code: 'TNDM-BBBB', openNet, sendMoved: (m) => sent.push(m), timeouts: T });
  const p = move.run();
  await tick();
  assert.equal(made.length, 1);
  assert.equal(made[0].role, 'captain', 'the full guest opens the new room as its captain');
  assert.equal(sent.length, 0, 'nothing is sent before the new room exists');
  made[0].open();
  await tick();
  assert.deepEqual(sent, [{ code: 'TNDM-BBBB' }]);
  made[0].onProfileReceived({ name: 'Pat' });   // early message: queued for the lobby
  made[0].join();
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.moveNet.net, made[0]);
  assert.deepEqual(res.moveNet.queue, [{ name: 'Pat' }]);
  assert.equal(old.destroyed, false, 'the lobby adopts the new room and closes the old one');
});

test('lead: the new room never opens → nothing sent, the new transport closed, still in the old room', async () => {
  const old = new FakeNet('TNDM-AAAA');
  const { made, openNet } = opener();
  const sent = [];
  const res = await new RoomMove({ side: 'lead', old, code: 'TNDM-BBBB', openNet, sendMoved: (m) => sent.push(m), timeouts: T }).run();
  assert.deepEqual(res, { ok: false, reason: 'open' });
  assert.equal(sent.length, 0);
  assert.ok(made[0].destroyed && !made[0].byeSent);
  assert.ok(old.connected && !old.destroyed);
});

test('lead: the partner never follows → back to the old room, whose drop handling is restored', async () => {
  const old = new FakeNet('TNDM-AAAA');
  let drops = 0;
  old.onDisconnected = () => { drops++; };
  const { made, openNet } = opener();
  const move = new RoomMove({ side: 'lead', old, code: 'TNDM-BBBB', openNet, sendMoved: () => {}, timeouts: T });
  const p = move.run();
  await tick(); made[0].open();
  const res = await p;
  assert.deepEqual(res, { ok: false, reason: 'connect' });
  assert.ok(made[0].destroyed);
  assert.ok(!old.destroyed && old.connected);
  old.drop();
  assert.equal(drops, 1, 'after the move the old room drops as usual');
});

test('follow: joins the new code as stoker; the old room dropping meanwhile is ignored', async () => {
  const old = new FakeNet('TNDM-AAAA');
  let drops = 0;
  old.onDisconnected = () => { drops++; };
  const { made, openNet } = opener();
  const p = new RoomMove({ side: 'follow', old, code: 'TNDM-BBBB', openNet, timeouts: T }).run();
  await tick();
  assert.equal(made[0].role, 'stoker');
  assert.equal(made[0].roomCode, 'TNDM-BBBB');
  old.drop();   // the new host adopted its room first and closed the old one
  assert.equal(drops, 0, 'not thrown back to the role screen mid-move');
  made[0].join();
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(old.onDisconnected, null, 'the dead old room no longer reaches the room UI');
});

test('follow: never connects → the old room kept; a drop it missed is replayed so no one sits in a dead room', async () => {
  const old = new FakeNet('TNDM-AAAA');
  const why = [];
  old.onDisconnected = (r) => why.push(r);
  const { made, openNet } = opener();
  const p = new RoomMove({ side: 'follow', old, code: 'TNDM-BBBB', openNet, timeouts: T }).run();
  await tick();
  old.drop('Partner disconnected');
  const res = await p;
  assert.deepEqual(res, { ok: false, reason: 'follow' });
  assert.ok(made[0].destroyed && !made[0].byeSent);
  assert.deepEqual(why, ['Partner disconnected']);
});

test('follow gives up before lead does (lead waits longer from an earlier start)', async () => {
  const { FOLLOW_MS, CONNECT_MS } = await import('../../js/lobby/room-move.js');
  assert.ok(CONNECT_MS - FOLLOW_MS >= 2000);
});

test('a move stops when the room screen goes (a ride started): cancelled, new transport closed', async () => {
  const old = new FakeNet('TNDM-AAAA');
  const { made, openNet } = opener();
  let live = true;
  const p = new RoomMove({ side: 'follow', old, code: 'TNDM-BBBB', openNet, live: () => live, timeouts: T }).run();
  await tick();
  live = false;
  made[0].join();
  const res = await p;
  assert.deepEqual(res, { ok: false, reason: 'cancelled' });
  assert.ok(made[0].destroyed);
});

test('closeQuietly and NetSession.adopt close the old transport without a partnerLeft goodbye', () => {
  const a = new FakeNet('TNDM-AAAA');
  closeQuietly(a);
  assert.ok(a.destroyed && !a.byeSent);
  const s = new NetSession();
  const old = new FakeNet('TNDM-AAAA');
  old.onDisconnected = () => { throw new Error('must be detached'); };
  s.net = old;
  const e0 = s.epoch;
  const fresh = new FakeNet('TNDM-BBBB');
  assert.equal(s.adopt(fresh), fresh);
  assert.equal(s.net, fresh);
  assert.ok(old.destroyed && !old.byeSent && old.onDisconnected === null);
  assert.ok(!s.isCurrent(e0), 'stale callbacks of the old room no-op');
});
