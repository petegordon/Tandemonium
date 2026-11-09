// #620 · the ride relay tells the partner "disconnect" only when the player really left: a
// socket closed because a re-dial replaced it must not, or the partner re-dials too and the
// two sides chase each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TandemRoom } from '../../worker/relay.js';

function room() {
  const socks = [];
  const state = {
    getWebSockets: (tag) => socks.filter((s) => !tag || s.tag === tag),
    getTags: (ws) => [ws.tag],
    storage: { setAlarm: async () => {} },
  };
  const r = new TandemRoom(state, {});
  const add = (tag) => { const s = { tag, readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); } }; socks.push(s); return s; };
  return { r, add };
}

test('the captain really leaves: the stoker hears "disconnect"', async () => {
  const { r, add } = room();
  const cap = add('captain'), sto = add('stoker');
  cap.readyState = 3;
  await r.webSocketClose(cap);
  assert.deepEqual(sto.sent, [{ type: 'disconnect', role: 'captain' }]);
});

test('a captain socket replaced by its own re-dial: the stoker hears nothing', async () => {
  const { r, add } = room();
  const old = add('captain'); add('captain'); const sto = add('stoker');
  old.readyState = 3;
  await r.webSocketClose(old);
  assert.deepEqual(sto.sent, []);
});
