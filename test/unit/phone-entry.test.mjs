// #562 · phones as controllers for extra seats: PhoneEntry / PhonePool, all
// on seats of one shared pad room (one QR for every phone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhoneEntry, PhonePool, makePhoneSynthetic, applyNavToSynthetic } from '../../js/remote/phone-entry.js';
import { NAV } from '../../js/remote/pad-protocol.js';

/** A stand-in PadSeat: records calls, lets the test drive status and frames. */
function fakeSeat(n, opts) {
  const h = {
    n, opts, link: null, status: 'idle', mode: 'menu', label: opts.label, cues: [], closed: false, opened: 0,
    open() { h.opened++; h.link = 'https://x/remote/?pad=ROOM&seat=2&seats=2,3,4#k=join'; h.status = 'waiting'; return Promise.resolve(h.link); },
    close() { h.closed = true; h.status = 'idle'; },
    setMode(m) { h.mode = m; },
    cue(c) { h.cues.push(c); },
    setLabel(l) { h.label = l; },
    // test drivers
    connect() { h.status = 'connected'; opts.onStatus('connected'); },
    drop() { h.status = 'waiting'; opts.onStatus('waiting'); opts.onDrop(); },
    back() { h.status = 'connected'; opts.onStatus('connected'); opts.onReturn(); },
    frame(nav, f = {}) { opts.onFrame({ left: false, right: false, ...f }, nav); },
    handOff(on) { opts.onHandOff(on); },
  };
  return h;
}
const fakeInput = () => ({ remotePresent: false });
const flush = () => new Promise((r) => setTimeout(r, 0));

function pool(extra = {}) {
  const events = [];
  let rotations = 0;
  const p = new PhonePool({
    makeInput: fakeInput, makeSeat: fakeSeat,
    joinLink: ({ play } = {}) => 'https://x/remote/?pad=ROOM&seat=2&seats=2,3,4' + (play ? '&play=1' : '') + '#k=join',
    rotateJoin: () => { rotations++; },
    onDrop: (e) => events.push(['drop', e.n]), onReturn: (e) => events.push(['return', e.n]), onPause: (e) => events.push(['pause', e.n]),
    ...extra,
  });
  return { p, events, rotations: () => rotations };
}

test('synthetic: OK is button 0, Back 1, D-pad 12-15, pedals on the triggers', () => {
  const gp = makePhoneSynthetic(2);
  applyNavToSynthetic(gp, NAV.ok | NAV.left, { left: true });
  const on = gp.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(on, [0, 6, 14]);
  applyNavToSynthetic(gp, NAV.back | NAV.right);
  assert.deepEqual(gp.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0), [1, 15]);
  assert.equal(gp.mapping, 'standard');
});

test('entry: its seat is the relay seat of its number; presence drives the seat input', () => {
  let arrived = 0;
  const e = new PhoneEntry(3, { makeInput: fakeInput, makeSeat: fakeSeat, onArrive: () => arrived++ });
  assert.equal(e.host.n, 3, 'Phone 3 is seat 3 of the shared room');
  assert.equal(e.identity.name, 'Phone 3');
  assert.equal(e.input.remotePresent, false);
  e.host.connect();
  assert.equal(e.present, true);
  assert.equal(e.input.remotePresent, true);
  e.host.drop();
  assert.equal(e.input.remotePresent, false);
  e.host.back();
  assert.equal(arrived, 1);
});

test('entry: a button held when the phone joined is not a fresh press', () => {
  const e = new PhoneEntry(2, { makeInput: fakeInput, makeSeat: fakeSeat });
  e.host.connect();
  e.host.frame(NAV.ok);
  assert.equal(e.hasFreshButtonPress(), false);   // first look snapshots OK as held
  assert.equal(e.hasFreshButtonPress(), false);
  e.host.frame(0);
  e.host.frame(NAV.right);
  assert.equal(e.hasFreshInput(), true);
});

test('entry: attach hands over the input and relabels the phone; release gives it back', () => {
  const e = new PhoneEntry(3, { makeInput: fakeInput, makeSeat: fakeSeat });
  const input = e.attach('Player 2');
  assert.equal(input, e.input);
  assert.equal(e.attached, true);
  assert.equal(e.host.label, 'Player 2');
  e.release();
  assert.equal(e.attached, false);
  assert.equal(e.host.label, 'Phone 3');
});

test('pool: offering opens every free seat at once, behind ONE join link that stays put', async () => {
  const { p } = pool();
  const first = p.setOffering(true);
  assert.equal(first.n, 2);
  assert.deepEqual([...p.entries.keys()], [2, 3, 4], 'seats 2..4 all open');
  for (const e of p.entries.values()) assert.equal(e.host.opened, 1);
  await flush();
  const link = p.joinLink();
  assert.match(link, /seats=2,3,4/);
  p.entries.get(2).host.connect();
  assert.equal(p.pending.n, 3, 'the next free seat');
  assert.equal(p.joinLink(), link, 'the QR does not change after a join');
  p.entries.get(3).host.connect();
  p.entries.get(4).host.connect();
  assert.equal(p.pending, null, 'phones 2-4 all out');
  assert.equal(p.joinLink(), null, 'no QR once every seat is taken');
  assert.deepEqual(p.presentableEntries().map((e) => e.n), [2, 3, 4]);
});

test('pool: the join link offers "Play on this phone" only when asked (#563)', async () => {
  const { p } = pool();
  p.setOffering(true);
  await flush();
  assert.doesNotMatch(p.joinLink(), /play=1/);
  assert.match(p.joinLink({ play: true }), /play=1/);
});

test('pool: stopping the offer closes the unjoined seats and retires the QR; joined phones stay', () => {
  const { p, rotations } = pool();
  p.setOffering(true);
  const a = p.entries.get(2);
  a.host.connect();
  const b = p.entries.get(3), c = p.entries.get(4);
  p.setOffering(false);
  assert.equal(b.host.closed, true);
  assert.equal(c.host.closed, true);
  assert.equal(a.host.closed, false);
  assert.deepEqual([...p.entries.keys()], [2]);
  assert.equal(rotations(), 1, 'the next offer shows a new QR');
  p.setOffering(false);
  assert.equal(rotations(), 1, 'turning it off again is a no-op');
  // Offering again opens the free numbers.
  assert.equal(p.setOffering(true).n, 3);
  assert.deepEqual([...p.entries.keys()].sort(), [2, 3, 4]);
});

test('pool: seated phones are not candidates; drops and Pause are only reported for seated phones', () => {
  const { p, events } = pool();
  p.setOffering(true);
  const a = p.entries.get(2), b = p.entries.get(3);
  a.host.connect(); b.host.connect();
  a.attach('Player 2');
  assert.deepEqual(p.presentableEntries().map((e) => e.n), [3]);
  b.host.drop();
  a.host.drop();
  a.host.back();
  a.host.opts.onPause();
  b.host.opts.onPause();
  assert.deepEqual(events, [['drop', 2], ['return', 2], ['pause', 2]]);
  assert.equal(p.entryForInput(a.input), a);
});

test('pool: mode and cues reach the phones (cues only seated ones)', () => {
  const { p } = pool();
  p.setOffering(true);
  const a = p.entries.get(2), b = p.entries.get(3);
  a.host.connect(); b.host.connect();
  a.attach();
  p.setMode('ride');
  assert.equal(a.host.mode, 'ride');
  assert.equal(b.host.mode, 'ride');
  p.cue('go');
  assert.deepEqual(a.host.cues, ['go']);
  assert.deepEqual(b.host.cues, []);
  // A seat opened mid-ride starts in the pool's mode.
  p.remove(b);
  p.offer();
  assert.equal(p.entries.get(3).host.mode, 'ride');
});

test('pool: a phone that chose "Play on this phone" is no controller, and its seat goes back on offer when it leaves (#563)', () => {
  const { p, events } = pool();
  p.setOffering(true);
  const a = p.entries.get(2);
  a.host.connect();
  a.host.frame(NAV.ok);
  a.host.handOff(true);
  assert.equal(a.handedOff, true);
  assert.equal(a.synthetic.buttons[0].pressed, false, 'its held buttons are let go');
  assert.deepEqual(p.presentableEntries(), [], 'not a join candidate');
  assert.deepEqual(p.joinedEntries(), []);
  a.host.drop();   // it went to the game's join link
  assert.equal(a.host.closed, true);
  assert.notEqual(p.entries.get(2), a, 'seat 2 is offered afresh');
  assert.equal(p.entries.get(2).everJoined, false);
  assert.deepEqual(events, [], 'not reported as a seated phone dropping');
});

test('pool: a failed hand-off makes the phone a controller again (#563)', () => {
  const { p } = pool();
  p.setOffering(true);
  const a = p.entries.get(2);
  a.host.connect();
  a.host.handOff(true);
  a.host.handOff(false);
  assert.equal(a.handedOff, false);
  assert.deepEqual(p.presentableEntries().map((e) => e.n), [2]);
});
