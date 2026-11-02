// #562 · phones as controllers for extra seats: PhoneEntry / PhonePool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhoneEntry, PhonePool, makePhoneSynthetic, applyNavToSynthetic } from '../../js/remote/phone-entry.js';
import { NAV } from '../../js/remote/pad-protocol.js';

/** A stand-in PhonePadHost: records calls, lets the test drive status and frames. */
function fakeHost(opts) {
  const h = {
    opts, link: null, status: 'idle', mode: 'menu', label: opts.label, cues: [], closed: false, opened: 0,
    open() { h.opened++; h.link = `https://x/remote/#${opts.label}`; h.status = 'waiting'; return Promise.resolve(h.link); },
    close() { h.closed = true; h.status = 'idle'; },
    setMode(m) { h.mode = m; },
    cue(c) { h.cues.push(c); },
    setLabel(l) { h.label = l; },
    // test drivers
    connect() { h.status = 'connected'; opts.onStatus('connected'); },
    drop() { h.status = 'waiting'; opts.onStatus('waiting'); opts.onDrop(); },
    back() { h.status = 'connected'; opts.onStatus('connected'); opts.onReturn(); },
    frame(nav, f = {}) { opts.onFrame({ left: false, right: false, ...f }, nav); },
  };
  return h;
}
const fakeInput = () => ({ remotePresent: false });

function pool(extra = {}) {
  const events = [];
  const p = new PhonePool({
    makeInput: fakeInput, makeHost: fakeHost,
    onDrop: (e) => events.push(['drop', e.n]), onReturn: (e) => events.push(['return', e.n]), onPause: (e) => events.push(['pause', e.n]),
    ...extra,
  });
  return { p, events };
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

test('entry: presence drives the seat input and the first join fires once', () => {
  let arrived = 0;
  const e = new PhoneEntry(2, { makeInput: fakeInput, makeHost: fakeHost, onArrive: () => arrived++ });
  assert.equal(e.identity.name, 'Phone 2');
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
  const e = new PhoneEntry(2, { makeInput: fakeInput, makeHost: fakeHost });
  e.host.connect();
  e.host.frame(NAV.ok);
  assert.equal(e.hasFreshButtonPress(), false);   // first look snapshots OK as held
  assert.equal(e.hasFreshButtonPress(), false);
  e.host.frame(0);
  e.host.frame(NAV.right);
  assert.equal(e.hasFreshInput(), true);
});

test('entry: attach hands over the input and relabels the phone; release gives it back', () => {
  const e = new PhoneEntry(3, { makeInput: fakeInput, makeHost: fakeHost });
  const input = e.attach('Player 2');
  assert.equal(input, e.input);
  assert.equal(e.attached, true);
  assert.equal(e.host.label, 'Player 2');
  e.release();
  assert.equal(e.attached, false);
  assert.equal(e.host.label, 'Phone 3');
});

test('pool: the QR moves on to the next phone after a join while offering', () => {
  const { p } = pool();
  const first = p.setOffering(true);
  assert.equal(first.n, 2);
  assert.equal(first.host.opened, 1);
  first.host.connect();
  assert.equal(p.pending.n, 3);
  p.pending.host.connect();
  assert.equal(p.pending.n, 4);
  p.pending.host.connect();
  assert.equal(p.pending, null, 'phones 2-4 all out');
  assert.deepEqual(p.presentableEntries().map((e) => e.n), [2, 3, 4]);
});

test('pool: closing the panel closes the unjoined room; joined phones stay', () => {
  const { p } = pool();
  const a = p.setOffering(true);
  a.host.connect();
  const b = p.pending;
  p.setOffering(false);
  assert.equal(b.host.closed, true);
  assert.equal(p.entries.has(b.n), false);
  assert.deepEqual(p.joinedEntries().map((e) => e.n), [2]);
  // Offering again reuses the lowest free number.
  assert.equal(p.setOffering(true).n, 3);
});

test('pool: seated phones are not candidates; drops and Pause are only reported for seated phones', () => {
  const { p, events } = pool();
  const a = p.setOffering(true); a.host.connect();
  const b = p.pending; b.host.connect();
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
  const a = p.setOffering(true); a.host.connect();
  const b = p.pending; b.host.connect();
  a.attach();
  p.setMode('ride');
  assert.equal(a.host.mode, 'ride');
  assert.equal(b.host.mode, 'ride');
  p.cue('go');
  assert.deepEqual(a.host.cues, ['go']);
  assert.deepEqual(b.host.cues, []);
  // A phone joining mid-ride starts in the pool's mode.
  assert.equal(p.pending.host.mode, 'ride');
});
