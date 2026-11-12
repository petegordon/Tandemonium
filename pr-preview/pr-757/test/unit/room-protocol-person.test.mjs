// #708 · the partner's screen shows my seat's picture + Discord/Steam badge on my seat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { personToWire, partnerPersonFromProfile } from '../../js/lobby/room-protocol.js';

const wire = (v) => JSON.parse(JSON.stringify(v));

test('my seat person survives the wire and comes back as the partner person', () => {
  const me = personToWire({ name: 'Pete', pic: 'https://avatars.steamstatic.com/abc_full.jpg', source: 'steam' });
  const got = partnerPersonFromProfile(wire({ name: 'Pete', avatar: 'https://cdn.discordapp.com/x.png', person: me }));
  assert.deepEqual(got, { name: 'Pete', pic: 'https://avatars.steamstatic.com/abc_full.jpg', source: 'steam' }, 'person wins over the older avatar field');
});

test('not signed in: no person, and a guest profile gives no picture', () => {
  assert.equal(personToWire(null), null);
  assert.equal(partnerPersonFromProfile({ name: 'Guest goose' }), null);
  assert.equal(partnerPersonFromProfile(null), null);
});

test('an older build sends only name + avatar: the picture shows without a badge', () => {
  assert.deepEqual(partnerPersonFromProfile({ name: 'Sam', avatar: 'https://cdn.discordapp.com/a.png' }), { name: 'Sam', pic: 'https://cdn.discordapp.com/a.png', source: '' });
});

test('a signed-in partner with no picture still gets their badge', () => {
  assert.deepEqual(partnerPersonFromProfile({ name: 'Sam', person: { name: 'Sam', pic: '', source: 'discord' } }), { name: 'Sam', pic: '', source: 'discord' });
});

test('only https or inline-image pictures and known sources are taken from the partner', () => {
  assert.equal(personToWire({ name: 'x', pic: 'javascript:alert(1)', source: 'discord' }).pic, '');
  assert.equal(personToWire({ name: 'x', pic: 'http://plain.example/a.png', source: 'discord' }).pic, '');
  assert.equal(personToWire({ name: 'x', pic: 'data:image/png;base64,AAAA', source: 'google' }).source, '');
  assert.equal(partnerPersonFromProfile({ name: 'x', person: { name: 'x', pic: 'javascript:1', source: 'evil' } }), null);
});
