// The room camera and microphone are gone from Tandemonium (Pete, 2026-11-20; off since #400 D7).
// The game's transport is the rooms package's relay + P2P layers without its optional media layer:
// it has nothing to ask for a camera or place a call with, and it closes a media call that an
// older build places. An old link or setting that still says media=1 changes none of it.
// Own file (own process): the stubbed location below is what the game modules see on import.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = { search: '?media=1&room=TNDM-ABCD' };   // (no window: the modules below run headless)

const { P2PRoomTransport, MediaRoomTransport } = await import('../../shared/rooms/index.js');
const { RoomTransport } = await import('../../js/net/room-transport.js');
const { NetworkManager } = await import('../../js/network-manager.js');
const { NET_CALLBACKS } = await import('../../js/lobby/net-session.js');
const edition = await import('../../js/edition.js');
const { ROOM_MSG } = await import('../../js/lobby/room-protocol.js');

const MEDIA_MEMBERS = ['acquireLocalMedia', 'initiateCall', 'onRemoteStream', 'mediaEnabled',
  'cameraEnabled', 'audioEnabled', '_mediaCall', '_localMediaStream', '_playRemoteAudio'];

function fakeCall() {
  const c = { closed: false, answered: false };
  c.close = () => { c.closed = true; };
  c.answer = () => { c.answered = true; };
  c.on = () => {};
  return c;
}

/** Run `fn` with a navigator whose getUserMedia / enumerateDevices are counted. */
async function countingMedia(fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const n = { gum: 0, enumerate: 0 };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: {
      getUserMedia: async () => { n.gum++; return {}; },
      enumerateDevices: async () => { n.enumerate++; return []; },
    } },
  });
  try { await fn(); } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
  return n;
}

for (const [name, Net] of [['RoomTransport', RoomTransport], ['NetworkManager', NetworkManager]]) {
  test(`${name} is the P2P layer, not the media layer (with ?media=1 in the URL)`, () => {
    const t = new Net();
    assert.ok(t instanceof P2PRoomTransport);
    assert.equal(t instanceof MediaRoomTransport, false);
    for (const k of MEDIA_MEMBERS) assert.equal(k in t, false, `${name}.${k} should not exist`);
    assert.equal('mediaEnabled' in t.options, false);
    assert.equal('audioElement' in t.options, false);
    // the P2P data lane's settings are still there
    assert.equal(t.options.fastChannelLabel, 'tndm-fast');
    assert.equal(t.options.codePrefix, 'TNDM-');
    assert.equal(typeof t.options.peerjs.host, 'string');
  });

  test(`${name}: a media call from an older build is closed, never answered, and no camera is asked for`, async () => {
    const t = new Net();
    const call = fakeCall();
    const n = await countingMedia(async () => { t._handleIncomingCall(call); });
    assert.equal(call.closed, true);
    assert.equal(call.answered, false);
    assert.deepEqual(n, { gum: 0, enumerate: 0 });
  });
}

test('no transport callback is for a remote stream; the P2P upgrade one stays', () => {
  assert.equal(NET_CALLBACKS.includes('onRemoteStream'), false);
  assert.ok(NET_CALLBACKS.includes('onP2PUpgrade'));
});

test('?media=1 is not a setting any more: nothing reads it, URL tidy drops it, join links never carry it', () => {
  assert.equal('isMediaEnabled' in edition, false);
  assert.equal('resolveMediaEnabled' in edition, false);
  assert.deepEqual([...edition.CARRIED_PARAMS], ['demo']);
  assert.equal(edition.carriedQuery('?media=1&room=TNDM-ABCD'), '');
  assert.equal(edition.carriedQuery('?media=1&demo=1'), '?demo=1');
  const base = 'https://tandemonium.housetandem.com/';
  assert.equal(edition.buildJoinUrl(base, 'TNDM-ABCD', { media: true }), base + '?room=TNDM-ABCD');
  // the edition itself is untouched by it
  assert.equal(edition.getEditionRules(), edition.FULL_RULES);
});

test('the room protocol still knows the old camera message by its name (older builds send it)', () => {
  assert.equal(ROOM_MSG.CAMERA_TOGGLE, 'cameraToggle');
});
