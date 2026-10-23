// m19 · the ?versusbot=1 debug rider: local / ?dev=1 only, and it pays nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { versusBotAllowed, isBotTeam, humanTeams } from '../../js/versus/versus-bot.js';

test('m19: versusbot only on a local server, file:, or with ?dev=1', () => {
  assert.equal(versusBotAllowed('?versusbot=1', 'localhost', 'http:'), true);
  assert.equal(versusBotAllowed('?versusbot=1', '127.0.0.1', 'http:'), true);
  assert.equal(versusBotAllowed('?versusbot=1', '', 'file:'), true);
  assert.equal(versusBotAllowed('?versusbot=1', 'tandemonium.jimandi.love', 'https:'), false, 'never in production');
  assert.equal(versusBotAllowed('?versusbot=1&dev=1', 'tandemonium.jimandi.love', 'https:'), true);
  assert.equal(versusBotAllowed('', 'localhost', 'http:'), false, 'only when asked for');
  assert.equal(versusBotAllowed('?versusbot=0', 'localhost', 'http:'), false);
});

test('m19: bot teams are left out of payouts', () => {
  const human = { members: [{ type: 'keyboard' }] };
  const duo = { members: [{ type: 'gamepad' }, { type: 'bot' }] };
  const bot = { members: [{ type: 'bot' }] };
  assert.equal(isBotTeam(bot), true);
  assert.equal(isBotTeam(human), false);
  assert.equal(isBotTeam(duo), false, 'a human on the team counts');
  assert.equal(isBotTeam({ members: [] }), false);
  assert.deepEqual(humanTeams([human, bot]), [human]);
  assert.deepEqual(humanTeams(null), []);
});
