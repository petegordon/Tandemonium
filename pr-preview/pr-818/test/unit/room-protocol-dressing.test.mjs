// #672 · a player's Wardrobe opening / closing tags their card "dressing…" on the partner's screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomProtocol, ROOM_MSG } from '../../js/lobby/room-protocol.js';

test('dressing is a typed room message with a boolean open flag that survives the wire', () => {
  const on = JSON.parse(JSON.stringify(RoomProtocol.dressing(true)));
  const off = JSON.parse(JSON.stringify(RoomProtocol.dressing(0)));
  assert.deepEqual(on, { type: ROOM_MSG.DRESSING, open: true });
  assert.deepEqual(off, { type: 'dressing', open: false });
  assert.ok(!Object.values(ROOM_MSG).some((t, i, all) => all.indexOf(t) !== i), 'message types are unique');
});
