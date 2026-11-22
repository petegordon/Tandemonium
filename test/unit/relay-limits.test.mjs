// The ride relay as Tandemonium deploys it: frames have a size limit, and a partner's text
// can't read as one of the relay's control frames. (The full set is in the lab's package.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TandemRoom } from '../../worker/relay.js';

function room() {
  const socks = [];
  const state = {
    getWebSockets: (tag) => socks.filter((s) => !tag || s.tag === tag),
    getTags: (ws) => [ws.tag],
    storage: { setAlarm: async () => {} },
  };
  const r = new TandemRoom(state, {});
  const add = (tag) => { const s = { tag, readyState: 1, sent: [], send(m) { this.sent.push(m); } }; socks.push(s); return s; };
  return { r, add };
}

test('game frames pass; oversized frames and control look-alikes do not', async () => {
  const { r, add } = room();
  const cap = add('captain'), sto = add('stoker');
  const frame = new Uint8Array([3, 1, 2]);
  await r.webSocketMessage(cap, frame);
  assert.equal(sto.sent[0], frame);
  await r.webSocketMessage(cap, new Uint8Array(64 * 1024 + 1));
  await r.webSocketMessage(cap, '{"type":"disconnect","role":"captain"}');
  await r.webSocketMessage(cap, '{"type":"partner-ready","pair":"x","p2p":"y"}');
  assert.equal(sto.sent.length, 1);
});

test('the largest profile the game sends fits in a frame', () => {
  const achievements = Array.from({ length: 200 }, (_, i) => 'achievement_id_' + i);
  const profile = { achievements, avatar: 'https://cdn.discordapp.com/avatars/1234567890/' + 'a'.repeat(64) + '.png', name: 'x'.repeat(32), serverId: 12345, bikeColor: '#ffffff', look: { hat: 'top-hat', shirt: 'waistcoat' } };
  assert.ok(new TextEncoder().encode(JSON.stringify(profile)).length < 64 * 1024);
});

test('worker deploys wait for the unit tests and follow what the Workers bundle', () => {
  const yml = fs.readFileSync(new URL('../../.github/workflows/deploy-workers.yml', import.meta.url), 'utf8');
  assert.match(yml, /deploy:\s*\r?\n\s*needs: test/);
  assert.match(yml, /node --test "test\/unit\/\*\.test\.mjs"/);
  for (const p of ['worker/**', 'js/remote/pad-protocol.js', 'shared/rooms-relay/**', 'js/tourist-costs.js']) {
    assert.ok(yml.includes(`'${p}'`), p);
  }
  // Every file outside worker/ that a Worker imports is in the filter.
  for (const f of fs.readdirSync(new URL('../../worker/', import.meta.url), { recursive: true })) {
    if (!String(f).endsWith('.js')) continue;
    const text = fs.readFileSync(new URL('../../worker/' + String(f).replace(/\\/g, '/'), import.meta.url), 'utf8');
    for (const m of text.matchAll(/from '\.\.\/((?:js|shared)\/[^']+)'/g)) {
      const covered = m[1].startsWith('shared/rooms-relay/') || yml.includes(`'${m[1]}'`);
      assert.ok(covered, `${f} imports ${m[1]}`);
    }
  }
});
