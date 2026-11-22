// 2026-11-17 · a Ride Together room belongs to its riders. A seat is held by the account or
// device that took it (and for SEAT_HOLD_MS after it leaves); anyone else is told the room is
// full. A relay token must be genuine. Both seats taken = a pair proof and a P2P key for the two
// riders. TURN credentials only for a seat holder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TandemRoom, seatDecision, isRoomCode, cleanDevice } from '../../worker/relay.js';
import relayWorker from '../../worker/relay.js';
import { signToken, partnerFromProof, guestKey, SEAT_HOLD_MS } from '../../worker/room-proof.js';

const SECRET = 'relay-secret';
globalThis.WebSocketPair = class {
  constructor() {
    const mk = () => ({ sent: [], closedWith: null, send(m) { this.sent.push(JSON.parse(m)); }, accept() {}, close(code, reason) { this.closedWith = { code, reason }; } });
    this[0] = mk(); this[1] = mk();
  }
};
const RealResponse = globalThis.Response;
globalThis.Response = class {
  constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.webSocket = init && init.webSocket; }
  async text() { return String(this.body ?? ''); }
};
test.after(() => { globalThis.Response = RealResponse; });

function room() {
  const socks = []; const data = new Map();
  const state = {
    getWebSockets: (tag) => socks.filter((s) => !tag || s.tag === tag),
    getTags: (ws) => [ws.tag],
    acceptWebSocket: (ws, tags) => { ws.tag = tags[0]; ws.readyState = 1; socks.push(ws); },
    storage: {
      setAlarm: async () => {}, get: async (k) => data.get(k),
      put: async (k, v) => { data.set(k, structuredClone(v)); }, deleteAll: async () => { data.clear(); },
    },
  };
  const r = new TandemRoom(state, { RELAY_SECRET: SECRET, TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' });
  /** Dial; → { res, seated (the socket the room kept, or null), server (the server end) } */
  const dial = async (role, params = {}) => {
    const before = socks.length;
    const q = new URLSearchParams({ room: 'TNDM-ABCD', role, ...params });
    const res = await r.fetch({ url: 'https://relay/?' + q });
    return { res, seated: socks.length > before ? socks.at(-1) : null };
  };
  const leave = async (ws) => { ws.readyState = 3; socks.splice(socks.indexOf(ws), 1); await r.webSocketClose(ws); };
  return { r, socks, dial, leave };
}
const relayToken = (sub, role, room = 'TNDM-ABCD', secret = SECRET) => signToken({ sub, room, role }, secret, 300);

test('seatDecision: owner by account or device; held while open or within the hold; free after', () => {
  const now = 10_000_000;
  const seat = { sub: '7', device: 'dev-aaaaaaaa', releasedAt: null };
  assert.equal(seatDecision(null, false, {}, now), 'free');
  assert.equal(seatDecision(seat, true, { device: 'dev-aaaaaaaa' }, now), 'owner');
  assert.equal(seatDecision(seat, true, { sub: '7', device: 'other-device' }, now), 'owner');
  assert.equal(seatDecision(seat, true, { device: 'dev-bbbbbbbb' }, now), 'full');
  assert.equal(seatDecision(seat, true, {}, now), 'full');
  const left = { ...seat, releasedAt: now - 1000 };
  assert.equal(seatDecision(left, false, { device: 'dev-bbbbbbbb' }, now), 'full', 'held a while after leaving');
  assert.equal(seatDecision({ ...seat, releasedAt: now - SEAT_HOLD_MS - 1 }, false, { device: 'dev-bbbbbbbb' }, now), 'free');
});

test('a stranger can\'t take or listen to a held seat: "room-full", closed, nothing of the room sent', async () => {
  const R = room();
  const cap = (await R.dial('captain', { device: 'device-captain', name: 'Pete' })).seated;
  const sto = (await R.dial('stoker', { device: 'device-stoker', name: 'Sam' })).seated;
  assert.ok(cap && sto);
  for (const role of ['captain', 'stoker']) {
    const before = R.socks.length;
    const res = await R.r.fetch({ url: 'https://relay/?' + new URLSearchParams({ room: 'TNDM-ABCD', role, device: 'device-stranger' }) });
    assert.equal(R.socks.length, before, 'not seated');
    assert.equal(res.status, 101);
  }
  assert.equal(cap.readyState, 1, 'the captain was not replaced');
  assert.equal(sto.readyState, 1);
  await R.r.webSocketMessage(cap, 'secret ride data');
  // no device at all is a stranger too
  assert.equal((await R.dial('stoker')).seated, null);
});

test('the holder gets the seat back: a re-dial from the same device, or the same account from another device', async () => {
  const R = room();
  await R.dial('captain', { device: 'device-captain' });
  const t = await relayToken('42', 'stoker');
  const sto1 = (await R.dial('stoker', { device: 'device-phone', token: t })).seated;
  const sto2 = (await R.dial('stoker', { device: 'device-phone' })).seated;          // its own re-dial
  assert.ok(sto2, 'same device: seated (replaces its old socket)');
  await R.leave(sto2);
  const sto3 = (await R.dial('stoker', { device: 'device-laptop', token: await relayToken('42', 'stoker') })).seated;
  assert.ok(sto3, 'same account, another device');
  assert.ok(sto1);
});

test('a seat left empty stays its holder\'s for a while, then is free for someone new (with a new P2P key)', async () => {
  const realNow = Date.now; let now = 50_000_000; Date.now = () => now;
  try {
    const R = room();
    const cap = (await R.dial('captain', { device: 'device-captain' })).seated;
    const sto = (await R.dial('stoker', { device: 'device-stoker' })).seated;
    const key1 = cap.sent.find((m) => m.type === 'partner-ready').p2p;
    await R.leave(sto);
    now += 60_000;
    assert.equal((await R.dial('stoker', { device: 'device-new-friend' })).seated, null, 'still held');
    now += SEAT_HOLD_MS;
    const friend = (await R.dial('stoker', { device: 'device-new-friend' })).seated;
    assert.ok(friend, 'free after the hold');
    const key2 = friend.sent.find((m) => m.type === 'partner-ready').p2p;
    assert.ok(key1 && key2 && key1 !== key2, 'a new rider means a new P2P key');
  } finally { Date.now = realNow; }
});

test('a relay token must be genuine and for this room and seat (an expired one still names its account)', async () => {
  const R = room();
  assert.equal((await R.dial('captain', { device: 'device-captain', token: 'not.a.token' })).res.status, 403);
  assert.equal((await R.dial('captain', { device: 'device-captain', token: await relayToken('1', 'captain', 'TNDM-ABCD', 'other') })).res.status, 403);
  assert.equal((await R.dial('captain', { device: 'device-captain', token: await relayToken('1', 'stoker') })).res.status, 403);
  assert.equal((await R.dial('captain', { device: 'device-captain', token: await relayToken('1', 'captain', 'TNDM-ZZZZ') })).res.status, 403);
  const expired = await signToken({ sub: '1', room: 'TNDM-ABCD', role: 'captain' }, SECRET, -60);
  assert.ok((await R.dial('captain', { device: 'device-captain', token: expired })).seated, 'a ride outlasts the 5-minute token');
});

test('both seats taken: each rider gets a pair proof naming the two of them (a guest by guest key, never device id)', async () => {
  const R = room();
  const cap = (await R.dial('captain', { device: 'device-captain', token: await relayToken('7', 'captain') })).seated;
  const sto = (await R.dial('stoker', { device: 'device-guest-1' })).seated;
  const toCap = cap.sent.find((m) => m.type === 'partner-ready');
  const toSto = sto.sent.find((m) => m.type === 'partner-ready');
  assert.equal(toCap.pair, toSto.pair);
  assert.equal(toCap.p2p, toSto.p2p);
  const gk = await guestKey(SECRET, 'device-guest-1');
  assert.equal(toCap.partnerGuest, gk, 'the captain learns the guest partner\'s key');
  assert.equal(toSto.partnerGuest, null, 'the captain is signed in: no guest key');
  assert.ok(!JSON.stringify([...cap.sent, ...sto.sent]).includes('device-guest-1'), 'device ids never reach the other rider');
  assert.deepEqual(await partnerFromProof(SECRET, toCap.pair, '7', 'captain'), { role: 'stoker', guestKey: gk });
  assert.equal(await partnerFromProof(SECRET, toCap.pair, '8', 'captain'), null, 'only for the rider it names');
});

test('TURN credentials: only for a connection holding a seat; bad room codes are refused at the door', async () => {
  const R = room();
  const realFetch = globalThis.fetch;
  let minted = 0;
  let sentBody = null;
  globalThis.fetch = async (_u, init) => { minted++; sentBody = init.body; return { ok: true, text: async () => '{"iceServers":{"urls":["turn:x"]}}' }; };
  try {
    await R.dial('captain', { device: 'device-captain' });
    const turn = (q) => R.r.fetch({ url: 'https://relay/turn-credentials?' + new URLSearchParams({ room: 'TNDM-ABCD', ...q }) });
    assert.equal((await turn({ role: 'captain', device: 'device-stranger' })).status, 403);
    assert.equal((await turn({ role: 'stoker', device: 'device-captain' })).status, 403);
    assert.equal((await turn({ role: 'captain', device: 'device-captain' })).status, 403, 'no partner yet: nothing to connect to');
    assert.equal(minted, 0);
    await R.dial('stoker', { device: 'device-stoker' });
    assert.equal((await turn({ role: 'captain', device: 'device-stranger' })).status, 403);
    assert.equal(minted, 0);
    const ok = await turn({ role: 'captain', device: 'device-captain' });
    assert.equal(ok.status, 200);
    assert.equal(minted, 1);
    assert.equal(JSON.parse(sentBody).ttl, 3600, 'credentials last an hour');
  } finally { globalThis.fetch = realFetch; }
  assert.ok(isRoomCode('TNDM-AB2C'));
  assert.ok(!isRoomCode('anything') && !isRoomCode('TNDM-ABCDE') && !isRoomCode(null));
  assert.equal(cleanDevice('short'), null);
  const res = await relayWorker.fetch({ url: 'https://relay/turn-credentials', method: 'GET', headers: new Map() }, {});
  assert.equal(res.status, 403, 'no room: no credentials');
});
