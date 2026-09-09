// E-3 · a vocabulary for two people on one bike.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPingState, canCallSprint, callSprint, addEmote, tickPing,
  syncMultiplier, pingLabel,
  SPRINT_COUNT, SPRINT_WINDOW_S, SPRINT_MULTIPLIER, SPRINT_COOLDOWN_S,
  EMOTES, EMOTE_TTL_S, MAX_BUBBLES
} from '../../js/sync-ping.js';

/** Run the clock forward in 1/60 steps, collecting what happened. */
function run(state, seconds) {
  const events = { started: 0, ended: 0, ticks: [] };
  for (let t = 0; t < seconds; t += 1 / 60) {
    const r = tickPing(state, 1 / 60);
    state = r.state;
    if (r.started) events.started++;
    if (r.ended) events.ended++;
    if (r.tick !== null) events.ticks.push(r.tick);
  }
  return { state, events };
}

test('a sprint counts down, runs, and ends', () => {
  let s = callSprint(createPingState(), 'stoker');
  assert.equal(s.phase, 'counting');
  assert.equal(pingLabel(s), String(SPRINT_COUNT));

  const counting = run(s, SPRINT_COUNT - 0.1);
  assert.equal(counting.state.phase, 'counting');
  assert.equal(syncMultiplier(counting.state), 1, 'no bonus until the sprint starts');

  const sprinting = run(s, SPRINT_COUNT + 0.5);
  assert.equal(sprinting.state.phase, 'sprinting');
  assert.equal(sprinting.events.started, 1);
  assert.equal(syncMultiplier(sprinting.state), SPRINT_MULTIPLIER);
  assert.equal(pingLabel(sprinting.state), 'SPRINT!');

  const done = run(s, SPRINT_COUNT + SPRINT_WINDOW_S + 0.5);
  assert.equal(done.state.phase, 'idle');
  assert.equal(done.events.ended, 1);
  assert.equal(syncMultiplier(done.state), 1);
});

test('the countdown reports each number exactly once', () => {
  const s = callSprint(createPingState(), 'captain');
  const { events } = run(s, SPRINT_COUNT + 0.2);
  // 3 is showing from the moment it is called; 2 and 1 arrive as it counts.
  assert.deepEqual(events.ticks, [2, 1]);
});

test('either seat can call it', () => {
  assert.equal(callSprint(createPingState(), 'stoker').calledBy, 'stoker');
  assert.equal(callSprint(createPingState(), 'captain').calledBy, 'captain');
});

test('a sprint cannot be called on top of a sprint', () => {
  let s = callSprint(createPingState(), 'captain');
  assert.equal(canCallSprint(s), false);
  const second = callSprint(s, 'stoker');
  assert.equal(second.calledBy, 'captain', 'the first call stands');
  assert.equal(second, s, 'a refused call changes nothing at all');
});

test('there is a cooldown, so it cannot be spammed', () => {
  const s = callSprint(createPingState(), 'captain');
  const after = run(s, SPRINT_COUNT + SPRINT_WINDOW_S + 0.1).state;
  assert.equal(canCallSprint(after), false, 'still cooling down');
  assert.ok(after.cooldown > 0 && after.cooldown <= SPRINT_COOLDOWN_S);
  const later = run(after, SPRINT_COOLDOWN_S + 0.1).state;
  assert.equal(canCallSprint(later), true);
});

test('emotes appear, expire, and never stack up', () => {
  let s = createPingState();
  for (const e of EMOTES) s = addEmote(s, e, 'stoker');
  assert.equal(s.bubbles.length, MAX_BUBBLES, 'a mashed d-pad cannot wall the HUD');
  assert.deepEqual(s.bubbles.map(b => b.emote), EMOTES.slice(-MAX_BUBBLES));

  const gone = run(s, EMOTE_TTL_S + 0.2).state;
  assert.equal(gone.bubbles.length, 0);
});

test('an emote that is not one of ours is ignored', () => {
  const s = addEmote(createPingState(), '💀', 'captain');
  assert.equal(s.bubbles.length, 0);
});

test('emotes carry the seat that sent them', () => {
  const s = addEmote(createPingState(), '🐢', 'stoker');
  assert.equal(s.bubbles[0].seat, 'stoker');
});

test('emotes are independent of the sprint', () => {
  let s = addEmote(callSprint(createPingState(), 'captain'), '🔥', 'stoker');
  assert.equal(s.phase, 'counting');
  assert.equal(s.bubbles.length, 1);
  const after = run(s, SPRINT_COUNT + 0.2).state;
  assert.equal(after.phase, 'sprinting', 'an emote does not disturb the countdown');
});

test('an idle state says nothing and multiplies nothing', () => {
  const s = createPingState();
  assert.equal(pingLabel(s), null);
  assert.equal(syncMultiplier(s), 1);
  assert.equal(canCallSprint(s), true);
});

test('four emotes is the whole vocabulary', () => {
  assert.equal(EMOTES.length, 4);
  assert.equal(new Set(EMOTES).size, 4);
});
