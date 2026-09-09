// ============================================================
// SYNC PING (pure) — a vocabulary for two people on one bike
// ============================================================
//
// E-3. Portal 2 shipped a ping tool because two people in co-op need a way to
// say "there" and "now" without a microphone. Tandemonium needs it more than
// most: a large share of its sessions are a laptop and a phone with no call
// open, and the two riders may be in different cities.
//
// Two things, both one button:
//
//   SPRINT — either rider calls it, both screens count 3-2-1, and taps in the
//            five seconds that follow build the sync bar twice as fast. It is
//            a shared intention: "now, together", which is the sentence a
//            tandem is actually about.
//
//   EMOTES — four of them, because four is enough to be a language and few
//            enough to fit on a d-pad. 👍 (got it) 🫠 (my fault) 🐢 (slow
//            down) 🔥 (go).
//
// Pure so the timing rules can be tested without a network or a HUD.

/** Beats counted down before a sprint starts. */
export const SPRINT_COUNT = 3;

/** How long the doubled window lasts once the countdown ends. */
export const SPRINT_WINDOW_S = 5;

/** How much faster the sync bar fills during a sprint. */
export const SPRINT_MULTIPLIER = 2;

/** A sprint cannot be called again until this long after the last one ended. */
export const SPRINT_COOLDOWN_S = 8;

export const EMOTES = ['👍', '🫠', '🐢', '🔥'];

/** How long an emote bubble stays up. */
export const EMOTE_TTL_S = 2;

/** At most this many bubbles at once, so a mashed d-pad cannot wall the HUD. */
export const MAX_BUBBLES = 2;

export function createPingState() {
  return {
    phase: 'idle',        // 'idle' | 'counting' | 'sprinting'
    timer: 0,             // seconds left in the current phase
    cooldown: 0,
    calledBy: null,       // 'captain' | 'stoker'
    bubbles: []           // { emote, seat, ttl }
  };
}

/** Can a sprint be called right now? */
export function canCallSprint(state) {
  return state.phase === 'idle' && state.cooldown <= 0;
}

/**
 * Call a sprint. Returns the new state; a call that is not allowed returns the
 * state unchanged, so the caller can treat "refused" as "nothing happened".
 */
export function callSprint(state, seat) {
  if (!canCallSprint(state)) return state;
  return { ...state, phase: 'counting', timer: SPRINT_COUNT, calledBy: seat || 'captain' };
}

/** Add an emote bubble, oldest dropped once the cap is reached. */
export function addEmote(state, emote, seat) {
  if (!EMOTES.includes(emote)) return state;
  const bubbles = [...state.bubbles, { emote, seat: seat || 'captain', ttl: EMOTE_TTL_S }];
  return { ...state, bubbles: bubbles.slice(-MAX_BUBBLES) };
}

/**
 * Advance the clock.
 * @returns {{state, started: boolean, ended: boolean, tick: number|null}}
 *          `tick` is the countdown number that just became current (3, 2, 1),
 *          so the caller can beep once per number rather than every frame.
 */
export function tickPing(state, dt) {
  let next = { ...state, bubbles: state.bubbles.map(b => ({ ...b, ttl: b.ttl - dt })).filter(b => b.ttl > 0) };
  let started = false;
  let ended = false;
  let tick = null;

  if (next.cooldown > 0) next.cooldown = Math.max(0, next.cooldown - dt);

  if (next.phase === 'counting') {
    const before = Math.ceil(next.timer);
    next.timer -= dt;
    const after = Math.ceil(next.timer);
    if (after !== before && after >= 1) tick = after;
    if (next.timer <= 0) {
      next.phase = 'sprinting';
      next.timer = SPRINT_WINDOW_S;
      started = true;
    }
  } else if (next.phase === 'sprinting') {
    next.timer -= dt;
    if (next.timer <= 0) {
      next.phase = 'idle';
      next.timer = 0;
      next.cooldown = SPRINT_COOLDOWN_S;
      next.calledBy = null;
      ended = true;
    }
  }

  return { state: next, started, ended, tick };
}

/** The sync-bar multiplier that applies right now. */
export function syncMultiplier(state) {
  return state.phase === 'sprinting' ? SPRINT_MULTIPLIER : 1;
}

/** What the HUD should say, or null when there is nothing to say. */
export function pingLabel(state) {
  if (state.phase === 'counting') return String(Math.max(1, Math.ceil(state.timer)));
  if (state.phase === 'sprinting') return 'SPRINT!';
  return null;
}
