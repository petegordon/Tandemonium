// #548 · per-player looks: defaults by player number, saved by controller AND player, the old
// global Goose Outfits / Colours become Player 1's look, and the seats dress by mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PlayerLooks, defaultLook, normalizeLook, lookColourway, withColourway, seatLook, seatLooks, versusSeatLooks,
  lookToWire, lookFromWire, padKeyFor, vidPidFromGamepadId, LED_COLOURS, ledRgb, BODIES, STORAGE_KEY,
} from '../../js/player-look.js';
import { TEAM_COLOURWAYS } from '../../js/versus/team-looks.js';

const memStore = (init = {}) => {
  const m = { ...init };
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, dump: () => m };
};

test('defaults: P1 is the Victorian gander with a blue light, P2 the Victorian goose in red, P3/P4 alternate', () => {
  assert.deepEqual(defaultLook(1), { outfit: 'victorian', colours: {}, body: 'm', led: 'blue' });
  assert.deepEqual(defaultLook(2), { outfit: 'victorian', colours: {}, body: 'f', led: 'red' });
  assert.equal(defaultLook(3).body, 'm'); assert.equal(defaultLook(3).led, 'green');
  assert.equal(defaultLook(4).body, 'f'); assert.equal(defaultLook(4).led, 'purple');
  assert.equal(defaultLook(7).outfit, 'victorian', 'out-of-range player numbers still get a look');
  assert.deepEqual(Object.keys(BODIES), ['m', 'f']);
  assert.ok(LED_COLOURS.length >= 5 && LED_COLOURS.some((c) => c.key === 'off'));
  assert.deepEqual(ledRgb('nope'), ledRgb('blue'), 'an unknown LED key is the first colour');
});

test('normalizeLook: unknown fields fall back to the player defaults; default colourways are dropped', () => {
  const l = normalizeLook({ outfit: 'tuxedo', body: 'x', led: 'neon', colours: { victorian: 'v_navy', fancy: 'default', nope: 'z' } }, 2);
  assert.deepEqual(l, { outfit: 'victorian', colours: { victorian: 'v_navy' }, body: 'f', led: 'red' });
  assert.deepEqual(normalizeLook(null, 1), defaultLook(1));
  assert.equal(normalizeLook({ outfit: 'original' }, 1).outfit, 'victorian', 'old saved outfit names still map');
});

test('colourway helpers: per-outfit memory, default is dropped', () => {
  let l = withColourway(defaultLook(1), 'v_navy');
  assert.equal(lookColourway(l), 'v_navy');
  l = { ...l, outfit: 'fancy' };
  assert.equal(lookColourway(l), 'default', 'switching outfit shows that outfit\'s own colours');
  l = { ...l, outfit: 'victorian' };
  assert.equal(lookColourway(l), 'v_navy', '…and switching back remembers the pick');
  assert.deepEqual(withColourway(l, 'default').colours, {});
  assert.deepEqual(seatLook(l), { outfit: 'victorian', colourway: 'v_navy', body: 'm' });
});

test('a pad gets its look back by controller identity; a new pad as P2 gets the P2 default', () => {
  const store = memStore();
  const looks = new PlayerLooks(store);
  assert.deepEqual(looks.get(2, 'pad:054c:0ce6:P2'), defaultLook(2));
  assert.equal(looks.isPicked(2, 'pad:054c:0ce6:P2'), false);
  looks.set(2, 'pad:054c:0ce6:P2', { outfit: 'georgian', body: 'm', led: 'gold' });
  // next session: same store, fresh instance
  const again = new PlayerLooks(store);
  assert.equal(again.get(2, 'pad:054c:0ce6:P2').outfit, 'georgian');
  assert.equal(again.get(2, 'pad:054c:0ce6:P2').body, 'm');
  assert.equal(again.isPicked(2, 'pad:054c:0ce6:P2'), true);
  // the same pad seated as P3 keeps its own look
  assert.equal(again.get(3, 'pad:054c:0ce6:P2').outfit, 'georgian');
  // a different pad in P2 gets the look saved for player 2 (the pad's pick doubled as P2's)
  assert.equal(again.get(2, 'pad:057e:2009:P2').outfit, 'georgian', 'the player-number look is the fallback');
  // a different pad in P3 gets the P3 default
  assert.deepEqual(again.get(3, 'pad:057e:2009:P3'), defaultLook(3));
  // bound pads: get(n) without a key uses the binding
  again.bindPad(4, 'pad:054c:0ce6:P2');
  assert.equal(again.get(4).outfit, 'georgian');
  again.bindPad(4, null);
  assert.deepEqual(again.get(4), defaultLook(4));
});

test('migration: the old global outfit + colours become Player 1\'s look (once), and P1 writes mirror them', () => {
  const store = memStore({ tandemonium_goose_outfit: 'cyclist', tandemonium_goose_colours: JSON.stringify({ cyclists: 'c_blue', fancy: 'bogus' }) });
  const looks = new PlayerLooks(store);
  const p1 = looks.get(1, null);
  assert.deepEqual(p1, { outfit: 'cyclists', colours: { cyclists: 'c_blue' }, body: 'm', led: 'blue' });
  assert.equal(looks.isPicked(1, null), true, 'a migrated look counts as picked');
  assert.ok(store.dump()[STORAGE_KEY], 'migrated store written');
  assert.deepEqual(looks.get(2, null), defaultLook(2), 'P2 is untouched by the migration');
  looks.update(1, { outfit: 'fancy' }, null);
  assert.equal(store.dump().tandemonium_goose_outfit, 'fancy', 'legacy key mirrors P1');
  assert.deepEqual(JSON.parse(store.dump().tandemonium_goose_colours), { cyclists: 'c_blue' });
  looks.update(2, { outfit: 'georgian' }, null);
  assert.equal(store.dump().tandemonium_goose_outfit, 'fancy', 'P2 never touches the legacy keys');
});

test('no legacy settings: nothing is written until someone picks; a broken store is tolerated', () => {
  const store = memStore();
  const looks = new PlayerLooks(store);
  assert.deepEqual(looks.get(1, null), defaultLook(1));
  assert.equal(store.dump()[STORAGE_KEY], undefined);
  const broken = new PlayerLooks(memStore({ [STORAGE_KEY]: '{not json' }));
  assert.deepEqual(broken.get(1, null), defaultLook(1));
  const nullStore = new PlayerLooks(null);
  nullStore.set(1, 'k', { outfit: 'fancy' });
  assert.equal(nullStore.get(1, 'k').outfit, 'fancy', 'in-memory only without a store');
  assert.equal(nullStore.version, 1);
});

test('pad keys (#241): serial first, else vendor:product + slot; keyboard and Steam have their own', () => {
  assert.equal(padKeyFor({ serial: ' AB12 ', vendorId: 0x54c, productId: 0xce6, slotId: 'P2' }), 'serial:AB12');
  assert.equal(padKeyFor({ vendorId: 0x54c, productId: 0xce6, slotId: 'P2' }), 'pad:054c:0ce6:P2');
  assert.equal(padKeyFor({ kind: 'keyboard' }), 'keyboard');
  assert.equal(padKeyFor({ kind: 'steam', slotId: 'P3' }), 'steam:P3');
  assert.equal(padKeyFor({ name: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', slotId: 'P1' }), 'pad:name:xbox-360-controller:P1', 'XInput: no vendor:product, so name + slot');
  assert.equal(padKeyFor({}), null);
  assert.deepEqual(vidPidFromGamepadId('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), { vendorId: 0x54c, productId: 0xce6 });
  assert.deepEqual(vidPidFromGamepadId('054c-0ce6-DualSense Wireless Controller'), { vendorId: 0x54c, productId: 0xce6 });
  assert.equal(vidPidFromGamepadId('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), null);
});

test('seatLooks by mode: solo mirrors P1 on the stoker; local = P1 + P2; online = me + partner (or mirror)', () => {
  const p1 = withColourway({ ...defaultLook(1), outfit: 'georgian', body: 'f' }, 'g_claret');
  const p2 = { ...defaultLook(2), outfit: 'cyclists', body: 'm' };
  const solo = seatLooks({ mode: 'solo', p1 });
  assert.deepEqual(solo.Captain, { outfit: 'georgian', colourway: 'g_claret', body: 'f' });
  assert.deepEqual(solo.Stoker, { outfit: 'georgian', colourway: 'g_claret', body: 'f' }, 'the stoker mirrors P1 in the seat\'s own body');
  const local = seatLooks({ mode: 'local', p1, p2 });
  assert.deepEqual(local.Stoker, { outfit: 'cyclists', colourway: 'default', body: 'm' });
  assert.deepEqual(seatLooks({ mode: 'local', p1 }).Stoker, seatLook(defaultLook(2)), 'no P2 look → the P2 default');
  const partner = lookFromWire({ outfit: 'fancy', colourway: 'f_royal', body: 'm' });
  const cap = seatLooks({ mode: 'captain', p1, partner });
  assert.deepEqual(cap.Captain, seatLook(p1));
  assert.deepEqual(cap.Stoker, { outfit: 'fancy', colourway: 'f_royal', body: 'm' });
  const sto = seatLooks({ mode: 'stoker', p1, partner });
  assert.deepEqual(sto.Stoker, seatLook(p1), 'as stoker my own look rides the back seat');
  assert.deepEqual(sto.Captain, { outfit: 'fancy', colourway: 'f_royal', body: 'm' });
  const old = seatLooks({ mode: 'stoker', p1, partner: null });
  assert.deepEqual(old.Captain, { outfit: 'georgian', colourway: 'g_claret', body: 'm' }, 'an older partner with no look mirrors mine');
});

test('wire format round-trips and tolerates garbage / an older peer', () => {
  const l = withColourway({ ...defaultLook(2), outfit: 'fancy' }, 'f_royal');
  const w = lookToWire(l);
  assert.deepEqual(w, { outfit: 'fancy', colourway: 'f_royal', body: 'f', led: 'red' });
  assert.deepEqual(seatLook(lookFromWire(w)), { outfit: 'fancy', colourway: 'f_royal', body: 'f' });
  assert.equal(lookFromWire(w).led, 'red', "#672: the light travels, for the partner's swatch");
  assert.equal(lookFromWire({ outfit: 'fancy' }).led, 'off', 'an older peer sends no light');
  assert.equal(lookFromWire({ outfit: 'fancy', led: 'rainbow' }).led, 'off');
  assert.equal(lookFromWire(undefined), null);
  assert.equal(lookFromWire('x'), null);
  assert.deepEqual(seatLook(lookFromWire({ outfit: 'nope', colourway: 'zzz', body: 'q' })), { outfit: 'victorian', colourway: 'default', body: 'f' });
});

test('versus seats: picked looks are worn (team colour when in the outfit\'s own colours); unpicked seats take the team fallback', () => {
  const picked = { look: withColourway({ ...defaultLook(2), outfit: 'fancy', body: 'm' }, 'f_royal'), picked: true };
  const plain = { look: { ...defaultLook(3), outfit: 'georgian' }, picked: true };
  const nobody = { look: defaultLook(4), picked: false };
  const a = versusSeatLooks('A', [picked, plain], 'victorian');
  assert.deepEqual(a.Captain, { outfit: 'fancy', colourway: 'f_royal', body: 'm' });
  assert.deepEqual(a.Stoker, { outfit: 'georgian', colourway: TEAM_COLOURWAYS.A.georgian, body: 'm' }, 'own colours → the team colourway');
  const b = versusSeatLooks('B', [nobody], 'victorian');
  // Team B's fallback is the outfit after P1's, in B's colourway (versusTeamLooks)
  assert.equal(b.Captain.outfit, 'cyclists');
  assert.equal(b.Captain.colourway, TEAM_COLOURWAYS.B.cyclists);
  assert.equal(b.Captain.body, 'f', 'an unpicked player keeps their default body');
  assert.deepEqual(b.Stoker, { outfit: 'cyclists', colourway: TEAM_COLOURWAYS.B.cyclists, body: 'f' }, 'an empty stoker seat wears the team fallback in the seat\'s body');
});
