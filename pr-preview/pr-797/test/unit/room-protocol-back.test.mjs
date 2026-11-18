// #167 · the captain's Back from level select takes the stoker to the room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomProtocol, ROOM_MSG } from '../../js/lobby/room-protocol.js';

test('backToRoom is a typed room message that survives the wire', () => {
  const wire = JSON.parse(JSON.stringify(RoomProtocol.backToRoom()));
  assert.equal(wire.type, ROOM_MSG.BACK_TO_ROOM);
  assert.equal(wire.type, 'backToRoom');
  assert.ok(!Object.values(ROOM_MSG).some((t, i, all) => all.indexOf(t) !== i), 'message types are unique');
});
