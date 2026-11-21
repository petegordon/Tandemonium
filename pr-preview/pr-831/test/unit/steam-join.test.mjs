// #694 E5 · Steam Join Game / invites (js/steam-join.js): the connect string both ways, when the
// presence offers Join Game, and SteamJoin against a fake window.steam bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoomCode, steamConnectString, roomCodeFromConnect, steamPresence, SteamJoin, STEAM_CONNECT_FLAG } from '../../js/steam-join.js';

test('room codes and the connect string', () => {
  assert.equal(normalizeRoomCode('TNDM-ABCD'), 'TNDM-ABCD');
  assert.equal(normalizeRoomCode('abcd'), 'TNDM-ABCD');
  assert.equal(normalizeRoomCode('tndm-x2y3'), 'TNDM-X2Y3');
  assert.equal(normalizeRoomCode(''), null);
  assert.equal(normalizeRoomCode('AB'), null);
  assert.equal(normalizeRoomCode('AB CD'), null);
  assert.equal(steamConnectString('TNDM-ABCD'), `${STEAM_CONNECT_FLAG} TNDM-ABCD`);
  assert.equal(steamConnectString(null), null);
});

test('the room code read back from what Steam hands the game', () => {
  assert.equal(roomCodeFromConnect('+tandemonium_room TNDM-ABCD'), 'TNDM-ABCD');
  // a cold start: the whole command line
  assert.equal(roomCodeFromConnect('C:\\Games\\Tandemonium.exe --foo +tandemonium_room TNDM-QR7Z'), 'TNDM-QR7Z');
  assert.equal(roomCodeFromConnect('Tandemonium.exe +tandemonium_room "tndm-qr7z"'), 'TNDM-QR7Z');
  assert.equal(roomCodeFromConnect('+tandemonium_room qr7z'), 'TNDM-QR7Z');
  assert.equal(roomCodeFromConnect('Tandemonium.exe --demo'), null);
  assert.equal(roomCodeFromConnect('+connect 1.2.3.4:27015'), null);
  assert.equal(roomCodeFromConnect(null), null);
});

test('Join Game is offered only while the captain waits for a partner', () => {
  assert.deepEqual(steamPresence({ code: 'TNDM-ABCD', role: 'captain', partner: false }),
    { connect: '+tandemonium_room TNDM-ABCD', status: 'Waiting for a partner in room ABCD' });
  assert.deepEqual(steamPresence({ code: 'TNDM-ABCD', role: 'captain', partner: true }), { connect: null, status: null });
  assert.deepEqual(steamPresence({ code: 'TNDM-ABCD', role: 'stoker', partner: false }), { connect: null, status: null });
  assert.deepEqual(steamPresence({ code: null, role: 'captain', partner: false }), { connect: null, status: null });
  assert.deepEqual(steamPresence({}), { connect: null, status: null });
});

function fakeSteam({ pending = null, names = {} } = {}) {
  const s = {
    presence: [], invites: [], listener: null,
    setPresence: async (p) => { s.presence.push(p); return true; },
    inviteFriends: async (c) => { s.invites.push(c); return true; },
    takePendingJoin: async () => pending,
    friendName: async (id) => names[id] || null,
    onJoinRequest: (cb) => { s.listener = cb; },
  };
  return s;
}

function fakeTimers() {
  const t = { fns: [], setInterval: (fn) => { t.fns.push(fn); return t.fns.length; }, clearInterval: () => { t.fns = []; }, tick: () => t.fns.forEach((f) => f()) };
  return t;
}

test('SteamJoin keeps the presence on the room, and only talks to Steam when it changes', async () => {
  const steam = fakeSteam();
  const timers = fakeTimers();
  let state = { code: null, role: null, partner: false };
  const sj = new SteamJoin({ steam, roomState: () => state, onJoin: () => {}, ...timers });
  assert.equal(sj.start(), true);
  assert.deepEqual(steam.presence, [{ connect: null, status: null }]);
  timers.tick();
  assert.equal(steam.presence.length, 1, 'no change: no call');
  state = { code: 'TNDM-ABCD', role: 'captain', partner: false };
  timers.tick();
  assert.equal(steam.presence.at(-1).connect, '+tandemonium_room TNDM-ABCD');
  state = { ...state, partner: true };
  timers.tick();
  assert.deepEqual(steam.presence.at(-1), { connect: null, status: null }, 'the seat filled: Join Game goes');
  state = { ...state, partner: false };
  timers.tick();
  sj.stop();
  assert.deepEqual(steam.presence.at(-1), { connect: null, status: null }, 'stop clears it');
});

test('SteamJoin passes on a join: a cold start, then one while running (with the friend’s name)', async () => {
  const steam = fakeSteam({ pending: { connect: 'Tandemonium.exe +tandemonium_room TNDM-WXYZ', via: 'launch', friend: null }, names: { '76561198000000001': 'Pete' } });
  const joins = [];
  const sj = new SteamJoin({ steam, roomState: () => ({}), onJoin: (j) => joins.push(j), ...fakeTimers() });
  sj.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(joins, [{ code: 'TNDM-WXYZ', friendName: null, via: 'launch' }]);
  await steam.listener({ connect: '+tandemonium_room TNDM-ABCD', friend: '76561198000000001', via: 'join-request' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(joins.at(-1), { code: 'TNDM-ABCD', friendName: 'Pete', via: 'join-request' });
  assert.equal(await sj.handleRequest({ connect: 'nothing here' }), null);
  assert.equal(joins.length, 2);
});

test('SteamJoin invite opens Steam’s picker with the room’s connect string', async () => {
  const steam = fakeSteam();
  const sj = new SteamJoin({ steam, roomState: () => ({}), onJoin: () => {}, ...fakeTimers() });
  assert.equal(await sj.invite('TNDM-ABCD'), true);
  assert.deepEqual(steam.invites, ['+tandemonium_room TNDM-ABCD']);
  assert.equal(await sj.invite(null), false);
});

test('without the desktop app’s bridge SteamJoin does nothing', () => {
  const sj = new SteamJoin({ steam: { isAvailable: async () => true }, roomState: () => ({}), onJoin: () => {}, ...fakeTimers() });
  assert.equal(sj.bridged, false);
  assert.equal(sj.start(), false);
  const none = new SteamJoin({ steam: undefined, roomState: () => ({}), onJoin: () => {}, ...fakeTimers() });
  assert.equal(none.start(), false);
});

test('the desktop app outside Steam (bridge there, Steam not running): no presence, no Invite', async () => {
  const steam = fakeSteam();
  steam.isAvailable = async () => false;
  let ready = 0;
  const sj = new SteamJoin({ steam, roomState: () => ({ code: 'TNDM-ABCD', role: 'captain' }), onJoin: () => {}, onReady: () => ready++, ...fakeTimers() });
  assert.equal(sj.start(), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sj.available, false);
  assert.equal(ready, 0);
  assert.deepEqual(steam.presence, []);
  assert.equal(steam.listener, null);
  steam.isAvailable = async () => true;
  const sj2 = new SteamJoin({ steam, roomState: () => ({ code: 'TNDM-ABCD', role: 'captain' }), onJoin: () => {}, onReady: () => ready++, ...fakeTimers() });
  sj2.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sj2.available, true);
  assert.equal(ready, 1);
  assert.equal(steam.presence.at(-1).connect, '+tandemonium_room TNDM-ABCD');
});
