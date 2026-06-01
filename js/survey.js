// ============================================================
// SURVEY — contextual, branching micro-surveys for play feedback
// ============================================================
//
// A self-contained, drop-in feedback component that asks 2–3 focused
// questions at the end of a ride. Which questions a player sees depends
// entirely on *how* the ride ended — six distinct paths:
//
//   1. solo_completed       solo ride finished
//   2. solo_abandoned       solo ride quit early
//   3. mp_host_completed    multiplayer finished, you were the captain (host)
//   4. mp_guest_completed   multiplayer finished, you were the stoker (guest)
//   5. mp_host_abandoned    multiplayer quit early, you were the captain (host)
//   6. mp_guest_abandoned   multiplayer quit early, you were the stoker (guest)
//
// Solo branches probe controls / difficulty / replay intent.
// Multiplayer branches probe coordination / fairness / partner dynamics.
//
// The component is decoupled from telemetry: it emits abstract survey
// events through an injectable `onEvent` hook. `attachSurveyTelemetry()`
// (see bottom) wires those into analytics.js, but the manager itself has
// no hard dependency on it, which keeps it unit-testable in isolation.
//
// Integration is a single call: `survey.maybeTrigger(context)`. The
// manager owns eligibility (sampling, cooldown, "don't re-ask"), renders
// its own modal, records answers, and tears itself down. The game does
// not need to manage any survey UI or state.
// ============================================================

// ---- Branch keys (stable identifiers used in telemetry) ----

export const BRANCH = {
  SOLO_COMPLETED:    'solo_completed',
  SOLO_ABANDONED:    'solo_abandoned',
  MP_HOST_COMPLETED: 'mp_host_completed',
  MP_GUEST_COMPLETED:'mp_guest_completed',
  MP_HOST_ABANDONED: 'mp_host_abandoned',
  MP_GUEST_ABANDONED:'mp_guest_abandoned',
};

// ---- Branch resolution -------------------------------------
//
// Pure function. Given the ride context, return the branch key for the
// survey to show, or null when no survey applies (e.g. local same-screen
// co-op, tutorials, or an unknown mode). Keeping this pure makes the
// branching logic trivial to test and reason about.
//
//   context = {
//     mode:      'solo' | 'captain' | 'stoker' | 'local',
//     completed: boolean,   // true = reached the finish, false = quit early
//   }
//
export function resolveBranch(context) {
  if (!context) return null;
  const { mode, completed } = context;

  switch (mode) {
    case 'solo':
      return completed ? BRANCH.SOLO_COMPLETED : BRANCH.SOLO_ABANDONED;
    case 'captain': // online host: steers + pedals the shared bike
      return completed ? BRANCH.MP_HOST_COMPLETED : BRANCH.MP_HOST_ABANDONED;
    case 'stoker':  // online guest: pedals the shared bike
      return completed ? BRANCH.MP_GUEST_COMPLETED : BRANCH.MP_GUEST_ABANDONED;
    // 'local' (same-screen co-op) and any unknown mode get no survey —
    // both riders share one device, so a single-respondent survey would
    // conflate two people's experiences.
    default:
      return null;
  }
}

// ---- Question trees ----------------------------------------
//
// Each branch defines its title, an accent theme, and an ordered list of
// questions. Every question is single-choice; options carry a stable
// `value` (logged) and a human `label` (shown). Ordering is deliberate:
// abandoned branches lead with a "why did you stop" friction question so
// we capture the reason while it's fresh, then narrow into the dimension
// most likely implicated by that path.
//
// Dimensions:
//   solo  -> controls | difficulty | replay
//   mp    -> coordination | fairness | partner   (+ a leading `reason`
//            on the abandoned paths)
//
// `note` on an option is an optional sub-label for extra nuance.

export const SURVEY_BRANCHES = {

  // ── 1. Solo, completed ───────────────────────────────────
  [BRANCH.SOLO_COMPLETED]: {
    title: 'Nice ride! Two quick questions.',
    theme: 'positive',
    questions: [
      {
        id: 'controls_feel',
        dimension: 'controls',
        prompt: 'How did steering and pedaling feel?',
        options: [
          { value: 'clunky',  label: 'Clunky' },
          { value: 'awkward', label: 'A bit awkward' },
          { value: 'good',    label: 'Just right' },
          { value: 'smooth',  label: 'Super smooth' },
        ],
      },
      {
        id: 'difficulty',
        dimension: 'difficulty',
        prompt: 'How was the challenge?',
        options: [
          { value: 'too_easy',   label: 'Too easy' },
          { value: 'just_right', label: 'Just right' },
          { value: 'tough_fair', label: 'Tough but fair' },
          { value: 'too_hard',   label: 'Too hard' },
        ],
      },
      {
        id: 'replay_intent',
        dimension: 'replay',
        prompt: 'Up for another ride?',
        options: [
          { value: 'definitely', label: 'Definitely' },
          { value: 'maybe',      label: 'Maybe later' },
          { value: 'not_now',    label: 'Not right now' },
        ],
      },
    ],
  },

  // ── 2. Solo, abandoned ───────────────────────────────────
  [BRANCH.SOLO_ABANDONED]: {
    title: 'Heading out? Help us improve.',
    theme: 'neutral',
    questions: [
      {
        id: 'quit_reason',
        dimension: 'reason',
        prompt: 'What made you stop this ride?',
        options: [
          { value: 'too_hard',     label: 'Too hard' },
          { value: 'controls',     label: 'Controls frustrating' },
          { value: 'boring',       label: 'Got boring' },
          { value: 'just_a_break', label: 'Just taking a break' },
          { value: 'bug',          label: 'Something broke' },
        ],
      },
      {
        id: 'controls_friction',
        dimension: 'controls',
        prompt: 'Were the controls getting in your way?',
        options: [
          { value: 'a_lot',   label: 'Yes, a lot' },
          { value: 'a_little',label: 'A little' },
          { value: 'no',      label: 'No, controls were fine' },
        ],
      },
      {
        id: 'replay_intent',
        dimension: 'replay',
        prompt: 'Would you give it another go?',
        options: [
          { value: 'yes',         label: 'Yes' },
          { value: 'maybe',       label: 'Maybe' },
          { value: 'probably_not',label: 'Probably not' },
        ],
      },
    ],
  },

  // ── 3. Multiplayer, completed, host (captain) ────────────
  [BRANCH.MP_HOST_COMPLETED]: {
    title: 'You made it, captain! Two quick questions.',
    theme: 'positive',
    questions: [
      {
        id: 'coordination',
        dimension: 'coordination',
        prompt: 'How in-sync did you feel with your partner?',
        options: [
          { value: 'out_of_sync', label: 'Totally out of sync' },
          { value: 'took_work',   label: 'Took some work' },
          { value: 'mostly',      label: 'Mostly in sync' },
          { value: 'perfect',     label: 'Perfectly synced' },
        ],
      },
      {
        id: 'fairness',
        dimension: 'fairness',
        prompt: 'You steered as captain — did the workload feel balanced?',
        options: [
          { value: 'i_did_more',   label: 'I did way more' },
          { value: 'slightly_off', label: 'Slightly uneven' },
          { value: 'balanced',     label: 'Felt balanced' },
          { value: 'partner_more', label: 'Partner carried us' },
        ],
      },
      {
        id: 'partner_dynamics',
        dimension: 'partner',
        prompt: 'How was riding with your partner?',
        options: [
          { value: 'frustrating', label: 'Frustrating' },
          { value: 'okay',        label: 'Okay' },
          { value: 'fun',         label: 'Fun' },
          { value: 'a_blast',     label: 'A blast' },
        ],
      },
    ],
  },

  // ── 4. Multiplayer, completed, guest (stoker) ────────────
  [BRANCH.MP_GUEST_COMPLETED]: {
    title: 'You made it, stoker! Two quick questions.',
    theme: 'positive',
    questions: [
      {
        id: 'coordination',
        dimension: 'coordination',
        prompt: 'Could you tell what your captain was doing?',
        options: [
          { value: 'no_idea',  label: 'No idea' },
          { value: 'sometimes',label: 'Sometimes' },
          { value: 'usually',  label: 'Usually' },
          { value: 'always',   label: 'Always clear' },
        ],
      },
      {
        id: 'fairness',
        dimension: 'fairness',
        prompt: 'You pedaled as stoker — did your input feel like it mattered?',
        options: [
          { value: 'useless',  label: 'Felt useless' },
          { value: 'a_little', label: 'A little' },
          { value: 'mattered', label: 'It mattered' },
          { value: 'essential',label: 'Totally essential' },
        ],
      },
      {
        id: 'partner_dynamics',
        dimension: 'partner',
        prompt: 'How was riding with your captain?',
        options: [
          { value: 'frustrating', label: 'Frustrating' },
          { value: 'okay',        label: 'Okay' },
          { value: 'fun',         label: 'Fun' },
          { value: 'a_blast',     label: 'A blast' },
        ],
      },
    ],
  },

  // ── 5. Multiplayer, abandoned, host (captain) ────────────
  [BRANCH.MP_HOST_ABANDONED]: {
    title: 'Ride cut short? Help us improve.',
    theme: 'neutral',
    questions: [
      {
        id: 'quit_reason',
        dimension: 'reason',
        prompt: 'What ended the ride?',
        options: [
          { value: 'coordination', label: "Couldn't coordinate" },
          { value: 'partner_left', label: 'Partner left' },
          { value: 'too_hard',     label: 'Too hard together' },
          { value: 'lost_interest',label: 'Lost interest' },
          { value: 'technical',    label: 'Technical issue' },
        ],
      },
      {
        id: 'coordination',
        dimension: 'coordination',
        prompt: 'Was staying in sync the hard part?',
        options: [
          { value: 'mainly_that', label: 'Yes, mainly that' },
          { value: 'partly',      label: 'Partly' },
          { value: 'no',          label: 'No, that was fine' },
        ],
      },
      {
        id: 'partner_dynamics',
        dimension: 'partner',
        prompt: 'Would you ride with this partner again?',
        options: [
          { value: 'yes',   label: 'Yes' },
          { value: 'maybe', label: 'Maybe' },
          { value: 'no',    label: 'No' },
        ],
      },
    ],
  },

  // ── 6. Multiplayer, abandoned, guest (stoker) ────────────
  [BRANCH.MP_GUEST_ABANDONED]: {
    title: 'Ride cut short? Help us improve.',
    theme: 'neutral',
    questions: [
      {
        id: 'quit_reason',
        dimension: 'reason',
        prompt: 'What ended the ride?',
        options: [
          { value: 'coordination', label: "Couldn't coordinate" },
          { value: 'captain_left', label: 'Captain left' },
          { value: 'too_hard',     label: 'Too hard together' },
          { value: 'lost_interest',label: 'Lost interest' },
          { value: 'technical',    label: 'Technical issue' },
        ],
      },
      {
        id: 'fairness',
        dimension: 'fairness',
        prompt: 'Did it feel like your pedaling mattered?',
        options: [
          { value: 'not_at_all', label: 'Not at all' },
          { value: 'a_little',   label: 'A little' },
          { value: 'yes',        label: 'Yes' },
        ],
      },
      {
        id: 'partner_dynamics',
        dimension: 'partner',
        prompt: 'Would you ride with this captain again?',
        options: [
          { value: 'yes',   label: 'Yes' },
          { value: 'maybe', label: 'Maybe' },
          { value: 'no',    label: 'No' },
        ],
      },
    ],
  },
};

// ---- Default configuration ---------------------------------

const DEFAULTS = {
  enabled: true,
  // Fraction of *eligible* ride-ends that actually surface a survey.
  // Keep below 1.0 in production so players aren't surveyed every ride.
  sampleRate: 1.0,
  // Minimum gap between any two surveys for this player, in ms.
  cooldownMs: 6 * 60 * 60 * 1000, // 6 hours
  // Don't re-ask the *same branch* within this window, in ms.
  perBranchCooldownMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  // localStorage key for throttling state.
  storageKey: 'tandemonium_survey_state',
  // z-index for the modal (sits above victory/gameover overlays at 60).
  zIndex: 120,
};

// ---- SurveyManager -----------------------------------------

export class SurveyManager {
  /**
   * @param {object} opts
   * @param {(type, payload) => void} [opts.onEvent] telemetry hook. Called
   *   with ('shown'|'answer'|'complete'|'dismiss', payload).
   * @param {object} [opts.config] overrides for DEFAULTS.
   * @param {Storage} [opts.storage] storage backend (defaults to localStorage).
   * @param {() => number} [opts.now] clock (injectable for tests).
   * @param {() => number} [opts.random] RNG in [0,1) (injectable for tests).
   */
  constructor(opts = {}) {
    this.config = { ...DEFAULTS, ...(opts.config || {}) };
    this.onEvent = opts.onEvent || (() => {});
    this.storage = opts.storage !== undefined ? opts.storage : _safeLocalStorage();
    this.now = opts.now || (() => Date.now());
    this.random = opts.random || Math.random;

    this._active = null;     // in-flight survey runtime state
    this._root = null;       // modal DOM root
    this._stylesInjected = false;
  }

  // ---- Public entry point ----
  //
  // The single hook the game calls at the end of a ride. Resolves the
  // branch, checks eligibility, and (if all pass) renders the survey.
  // Fire-and-forget: returns the branch key shown, or null if skipped.
  //
  //   context = {
  //     mode, completed,                  // -> branch resolution
  //     rideId, sessionId,                // -> telemetry correlation
  //     level, difficulty, role,          // -> optional segmentation
  //     abandonReason, distance,          // -> optional segmentation
  //   }
  maybeTrigger(context = {}) {
    if (!this.config.enabled) return null;
    if (this._active) return null; // never stack surveys

    const branchKey = resolveBranch(context);
    if (!branchKey) return null;
    if (!SURVEY_BRANCHES[branchKey]) return null;

    if (!this._isEligible(branchKey)) return null;

    this._open(branchKey, context);
    return branchKey;
  }

  // Force a survey regardless of sampling/cooldown (debug / QA).
  forceTrigger(context = {}) {
    const branchKey = resolveBranch(context);
    if (!branchKey || this._active) return null;
    this._open(branchKey, context);
    return branchKey;
  }

  // ---- Eligibility / throttling ----

  _isEligible(branchKey) {
    const state = this._readState();
    const t = this.now();

    // Global cooldown: at most one survey per cooldown window.
    if (state.lastShownAt && (t - state.lastShownAt) < this.config.cooldownMs) {
      return false;
    }
    // Per-branch cooldown: don't re-ask the same path too soon.
    const branchAt = state.branches && state.branches[branchKey];
    if (branchAt && (t - branchAt) < this.config.perBranchCooldownMs) {
      return false;
    }
    // Random sampling — last so the dice only roll on otherwise-eligible ends.
    if (this.random() > this.config.sampleRate) {
      return false;
    }
    return true;
  }

  _markShown(branchKey) {
    const state = this._readState();
    const t = this.now();
    state.lastShownAt = t;
    state.branches = state.branches || {};
    state.branches[branchKey] = t;
    this._writeState(state);
  }

  _readState() {
    if (!this.storage) return {};
    try {
      return JSON.parse(this.storage.getItem(this.config.storageKey) || '{}');
    } catch {
      return {};
    }
  }

  _writeState(state) {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.config.storageKey, JSON.stringify(state));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }

  // ---- Lifecycle ----

  _open(branchKey, context) {
    const branch = SURVEY_BRANCHES[branchKey];
    this._markShown(branchKey);

    this._active = {
      branchKey,
      branch,
      context,
      index: 0,                 // current question
      answers: [],              // [{ questionId, dimension, value }]
      startedAt: this.now(),
    };

    this._emit('shown', { totalQuestions: branch.questions.length });
    this._ensureStyles();
    this._render();
  }

  _answer(value) {
    const a = this._active;
    if (!a) return;
    const q = a.branch.questions[a.index];
    a.answers.push({ questionId: q.id, dimension: q.dimension, value });
    this._emit('answer', {
      questionId: q.id,
      dimension: q.dimension,
      value,
      questionIndex: a.index,
    });

    if (a.index < a.branch.questions.length - 1) {
      a.index++;
      this._render();
    } else {
      this._complete();
    }
  }

  _complete() {
    const a = this._active;
    if (!a) return;
    this._emit('complete', {
      answers: a.answers,
      durationMs: this.now() - a.startedAt,
    });
    this._renderThanks();
    // Auto-dismiss the thank-you card after a beat.
    this._closeTimer = setTimeout(() => this._teardown(), 1600);
  }

  _dismiss() {
    const a = this._active;
    if (!a) return;
    this._emit('dismiss', {
      answeredCount: a.answers.length,
      totalQuestions: a.branch.questions.length,
      answers: a.answers,
    });
    this._teardown();
  }

  _teardown() {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = null;
    this._active = null;
  }

  _emit(type, payload) {
    const a = this._active;
    try {
      this.onEvent(type, {
        branch: a ? a.branchKey : null,
        context: a ? a.context : null,
        ...payload,
      });
    } catch (e) {
      // Telemetry must never break the survey UI.
      if (typeof console !== 'undefined') console.warn('Survey telemetry error:', e);
    }
  }

  // ---- Rendering (self-contained DOM, no index.html dependency) ----

  _ensureRoot() {
    if (this._root) return this._root;
    const root = document.createElement('div');
    root.className = 'survey-overlay';
    root.style.zIndex = String(this.config.zIndex);
    document.body.appendChild(root);
    this._root = root;

    // Keyboard: Esc dismisses, number keys 1-9 pick an option.
    this._keyHandler = (e) => {
      if (!this._active) return;
      if (e.key === 'Escape') { this._dismiss(); return; }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1) {
        const q = this._active.branch.questions[this._active.index];
        const opt = q && q.options[n - 1];
        if (opt) this._answer(opt.value);
      }
    };
    document.addEventListener('keydown', this._keyHandler);
    return root;
  }

  _render() {
    const a = this._active;
    const root = this._ensureRoot();
    const q = a.branch.questions[a.index];
    const total = a.branch.questions.length;
    const themeClass = a.branch.theme === 'positive' ? 'survey-positive' : 'survey-neutral';

    root.innerHTML = `
      <div class="survey-card ${themeClass}">
        <button class="survey-skip" type="button" aria-label="Skip survey">Skip &times;</button>
        <div class="survey-progress">Question ${a.index + 1} of ${total}</div>
        ${a.index === 0 ? `<div class="survey-title">${_esc(a.branch.title)}</div>` : ''}
        <div class="survey-prompt">${_esc(q.prompt)}</div>
        <div class="survey-options"></div>
      </div>`;

    const optionsEl = root.querySelector('.survey-options');
    q.options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'survey-opt';
      btn.innerHTML = _esc(opt.label) + (opt.note ? `<span class="survey-opt-note">${_esc(opt.note)}</span>` : '');
      btn.addEventListener('click', () => this._answer(opt.value));
      optionsEl.appendChild(btn);
    });

    root.querySelector('.survey-skip').addEventListener('click', () => this._dismiss());
  }

  _renderThanks() {
    const root = this._ensureRoot();
    root.innerHTML = `
      <div class="survey-card survey-positive survey-thanks">
        <div class="survey-thanks-mark">✓</div>
        <div class="survey-title">Thanks for the feedback!</div>
      </div>`;
  }

  _ensureStyles() {
    if (this._stylesInjected) return;
    if (document.getElementById('survey-styles')) { this._stylesInjected = true; return; }
    const style = document.createElement('style');
    style.id = 'survey-styles';
    style.textContent = SURVEY_CSS;
    document.head.appendChild(style);
    this._stylesInjected = true;
  }
}

// ---- Scoped styles (match the game's overlay / lobby-btn look) ----

const SURVEY_CSS = `
.survey-overlay {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.78);
  padding: 20px;
  font-family: 'Helvetica Neue', Arial, sans-serif;
  animation: surveyFade 0.18s ease-out;
}
@keyframes surveyFade { from { opacity: 0; } to { opacity: 1; } }
.survey-card {
  position: relative;
  width: 100%; max-width: 340px;
  background: rgba(20,20,24,0.96);
  border: 2px solid rgba(255,255,255,0.18);
  border-radius: 18px;
  padding: 22px 20px 20px;
  box-shadow: 0 18px 60px rgba(0,0,0,0.5);
  text-align: center;
  animation: surveyPop 0.2s ease-out;
}
@keyframes surveyPop { from { transform: scale(0.94); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.survey-positive { border-color: rgba(68,255,102,0.55); }
.survey-neutral  { border-color: rgba(120,170,255,0.5); }
.survey-skip {
  position: absolute; top: 10px; right: 12px;
  background: none; border: none; cursor: pointer;
  color: rgba(255,255,255,0.45); font-size: 13px; font-weight: 700;
  padding: 4px 6px; -webkit-tap-highlight-color: transparent;
}
.survey-skip:active { color: rgba(255,255,255,0.8); }
.survey-progress {
  font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
  text-transform: uppercase; color: rgba(255,255,255,0.4);
  margin-bottom: 10px;
}
.survey-title {
  font-size: 18px; font-weight: 700; color: #44ff66;
  margin-bottom: 12px; line-height: 1.3;
}
.survey-neutral .survey-title { color: #8ab4ff; }
.survey-prompt {
  font-size: 17px; font-weight: 700; color: #fff;
  margin-bottom: 16px; line-height: 1.35;
}
.survey-options { display: flex; flex-direction: column; gap: 8px; }
.survey-opt {
  width: 100%; padding: 13px 16px; border-radius: 12px;
  border: 2px solid rgba(255,255,255,0.25);
  background: rgba(255,255,255,0.08);
  color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
  text-align: center; line-height: 1.3;
  font-family: inherit; -webkit-tap-highlight-color: transparent;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.survey-opt:hover  { background: rgba(255,255,255,0.14); border-color: rgba(255,255,255,0.4); }
.survey-opt:active { background: rgba(68,255,102,0.22); border-color: rgba(68,255,102,0.6); }
.survey-neutral .survey-opt:active { background: rgba(120,170,255,0.22); border-color: rgba(120,170,255,0.6); }
.survey-opt-note { display: block; font-size: 12px; font-weight: 400; opacity: 0.65; margin-top: 2px; }
.survey-thanks { padding: 34px 20px; }
.survey-thanks-mark {
  font-size: 44px; color: #44ff66; line-height: 1;
  margin-bottom: 10px; text-shadow: 0 0 24px rgba(68,255,102,0.5);
}
`;

// ---- Helpers ----

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _safeLocalStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      const k = '__survey_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return localStorage;
    }
  } catch { /* private mode / disabled */ }
  return null;
}

// ---- Telemetry binding -------------------------------------
//
// Wires the manager's abstract events into the existing analytics module
// (or any object exposing the same functions). Pass the analytics module
// and get back an `onEvent` handler to hand to the SurveyManager. Keeping
// this here — rather than inside the manager — is what keeps the manager
// telemetry-agnostic.

export function attachSurveyTelemetry(analytics) {
  return (type, payload) => {
    const base = {
      branch: payload.branch,
      ride_id: payload.context && payload.context.rideId || null,
      level: payload.context && payload.context.level || null,
      difficulty: payload.context && payload.context.difficulty || null,
    };
    switch (type) {
      case 'shown':
        analytics.trackEvent('survey_shown', { ...base, total_questions: payload.totalQuestions });
        break;
      case 'answer':
        analytics.trackEvent('survey_answer', {
          ...base,
          question_id: payload.questionId,
          dimension: payload.dimension,
          value: payload.value,
          question_index: payload.questionIndex,
        });
        break;
      case 'complete':
        analytics.trackEvent('survey_complete', {
          ...base,
          answers: payload.answers,
          duration_ms: payload.durationMs,
        });
        break;
      case 'dismiss':
        analytics.trackEvent('survey_dismiss', {
          ...base,
          answered_count: payload.answeredCount,
          total_questions: payload.totalQuestions,
          answers: payload.answers,
        });
        break;
    }
  };
}

// ---- Default singleton -------------------------------------
//
// Convenience instance for the common case. Tests can construct their own
// SurveyManager with injected clock/RNG/storage instead.

let _singleton = null;

export function getSurveyManager(opts) {
  if (!_singleton) _singleton = new SurveyManager(opts);
  return _singleton;
}
