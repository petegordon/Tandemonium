// #694 · the ride relay's Durable Object remembers when a room was last used and when each seat
// was last here (with its name), for a week, and says so on "waiting". Old clients read only
// `type`, so the extra fields are harmless to them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TandemRoom, cleanName } from '../../worker/relay.js';

// The Workers runtime's WebSocketPair / Response(101) are not in Node: stand-ins.
globalThis.WebSocketPair = class { constructor() { const mk = () => ({ sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }); this[0] = mk(); this[1] = mk(); } };
const RealResponse = globalThis.Response;
globalThis.Response = class { constructor(body, init) { this.status = (init && init.status) || 200; this.webSocket = init && init.webSocket; } };
test.after(() => { globalThis.Response = RealResponse; });

function room(now) {
  const socks = []; const data = new Map(); let alarm = null;
  const state = {
    getWebSockets: (tag) => socks.filter((s) => !tag || s.tag === tag),
    getTags: (ws) => [ws.tag],
    acceptWebSocket: (ws, tags) => { ws.tag = tags[0]; ws.readyState = 1; socks.push(ws); },
    storage: {
      setAlarm: async (t) => { alarm = t; },
      get: async (k) => data.get(k),
      put: async (k, v) => { data.set(k, structuredClone(v)); },
      deleteAll: async () => { data.clear(); },
    },
  };
  const r = new TandemRoom(state, {});
  const connect = async (role, name) => {
    const q = new URLSearchParams({ room: 'TNDM-ABCD', role }); if (name) q.set('name', name);
    await r.fetch({ url: 'https://relay/?' + q });
    return socks.at(-1);
  };
  return { r, socks, data, connect, alarm: () => alarm, fresh: () => new TandemRoom(state, {}) };
}

test('a never-used room says fresh; the next joiner hears when it was used and who was here', async () => {
  const realNow = Date.now;
  let now = 1_000_000; Date.now = () => now;
  try {
    const R = room();
    const cap = await R.connect('captain', 'Pete');
    assert.deepEqual(cap.sent[0], { type: 'waiting', fresh: true, lastUsedAt: null, partnerSeenAt: null, partnerName: null });
    now += 5000;
    cap.readyState = 3; R.socks.splice(R.socks.indexOf(cap), 1);
    await R.r.webSocketClose(cap);
    now += 2 * 3600_000;
    // a new instance (the DO was evicted): the record comes back from storage
    const R2 = { ...R, r: R.fresh() };
    const sto = await (async () => { const q = new URLSearchParams({ room: 'TNDM-ABCD', role: 'stoker' }); await R2.r.fetch({ url: 'https://relay/?' + q }); return R.socks.at(-1); })();
    assert.deepEqual(sto.sent[0], { type: 'waiting', fresh: false, lastUsedAt: 1_005_000, partnerSeenAt: 1_005_000, partnerName: 'Pete' });
  } finally { Date.now = realNow; }
});

test('the empty room keeps its record for a week, then is forgotten', async () => {
  const realNow = Date.now;
  let now = 5_000_000; Date.now = () => now;
  try {
    const R = room();
    const cap = await R.connect('captain');
    cap.readyState = 3; R.socks.length = 0;
    await R.r.webSocketClose(cap);
    now += 31 * 60_000;
    await R.r.alarm();
    assert.ok(R.data.has('meta'), 'kept after the 30 min socket TTL');
    assert.equal(R.alarm(), 5_000_000 + 7 * 24 * 3600_000);
    now = R.alarm() + 1;
    await R.r.alarm();
    assert.equal(R.data.size, 0, 'gone after a week');
  } finally { Date.now = realNow; }
});

test('relaying messages never writes the record (connect and leave do)', async () => {
  const R = room();
  const cap = await R.connect('captain');
  const sto = await R.connect('stoker');
  let puts = 0; const put = R.r.state.storage.put; R.r.state.storage.put = async (...a) => { puts++; return put(...a); };
  for (let i = 0; i < 50; i++) await R.r.webSocketMessage(cap, 'x');
  assert.equal(puts, 0);
});

test('cleanName trims, drops control characters, caps at 32', () => {
  assert.equal(cleanName('  Pete  '), 'Pete');
  assert.equal(cleanName('a\u0000b\u001fc'), 'abc');
  assert.equal(cleanName('x'.repeat(40)).length, 32);
  assert.equal(cleanName(''), null);
  assert.equal(cleanName(null), null);
});

test('#620 still holds: a re-dial never tells the partner "disconnect" (no await between closing the old socket and seating the new)', async () => {
  const R = room();
  const sto = await R.connect('stoker');
  const cap1 = await R.connect('captain');
  // the runtime delivers the replaced socket's close as a separate event: model it as a microtask
  cap1.close = () => { cap1.readyState = 3; queueMicrotask(() => R.r.webSocketClose(cap1)); };
  sto.sent.length = 0;
  await R.connect('captain');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!sto.sent.some((m) => m.type === 'disconnect'), JSON.stringify(sto.sent));
});

test('#694 partner-ready names each side to the other (null when a side gave no name)', async () => {
  const R = room();
  const cap = await R.connect('captain', 'Pete');
  const sto = await R.connect('stoker', 'Sam');
  assert.deepEqual(sto.sent[0], { type: 'partner-ready', role: 'captain', name: 'Pete' });
  assert.deepEqual(cap.sent.at(-1), { type: 'partner-ready', role: 'stoker', name: 'Sam' });
  const R2 = room();
  const cap2 = await R2.connect('captain');
  const sto2 = await R2.connect('stoker', 'Sam');
  assert.deepEqual(sto2.sent[0], { type: 'partner-ready', role: 'captain', name: null });
  assert.deepEqual(cap2.sent.at(-1), { type: 'partner-ready', role: 'stoker', name: 'Sam' });
});
