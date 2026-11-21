// m13 · the helping hand gives safety back after a restart from the beginning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installHelpingHandMode } from '../../js/helping-hand-mode.js';
import { HELP_TIERS } from '../../js/helping-hand.js';

class FakeGame {
  constructor({ safety, touched }) {
    this.mode = 'solo';
    this.lobby = { selectedLevel: { id: 'grandma' } };
    this.raceManager = {};
    this.safetyMode = safety;
    this._safetyTouched = touched;
  }
}
installHelpingHandMode(FakeGame);

const safetyTier = Number(Object.keys(HELP_TIERS).find(k => HELP_TIERS[k].safety));

test('m13: a player who turned SAFETY off gets it back off after a restart from the beginning', () => {
  assert.ok(safetyTier > 0, 'some tier turns safety on');
  const g = new FakeGame({ safety: false, touched: true });
  g._helpStartRide(false);
  g._setHelpTier(safetyTier);
  assert.equal(g.safetyMode, true, 'the helping hand turns safety on');
  // RESTART from the beginning: _applySafetyDefault keeps a touched choice, then _helpStartRide(false).
  g._helpStartRide(false);
  assert.equal(g.safetyMode, false, "the player's own choice is back");
  assert.equal(g._helpSafetyPrev, null);
});

test('m13: an untouched choice stays at the difficulty default the countdown just applied', () => {
  const g = new FakeGame({ safety: false, touched: false });
  g._helpStartRide(false);
  g._setHelpTier(safetyTier);
  g.safetyMode = true;            // _applySafetyDefault: e.g. Chill's default
  g._helpStartRide(false);
  assert.equal(g.safetyMode, true);
});

test('m13: a retry of segment 1 keeps the tier and its safety', () => {
  const g = new FakeGame({ safety: false, touched: true });
  g._helpStartRide(false);
  g._setHelpTier(safetyTier);
  g._helpStartRide(true);
  assert.equal(g.safetyMode, true);
});
