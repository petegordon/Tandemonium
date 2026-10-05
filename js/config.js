// ============================================================
// CONFIG — shared constants
// ============================================================

const _isElectron = navigator.userAgent.includes('Electron');
export const isMobile = !_isElectron && (
    /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1));
export const isAndroid = /Android/i.test(navigator.userAgent);
export const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

// Riders model: the fused tandem + Victorian goose captain & stoker, skinned so
// their torsos lean with the balance. See BikeModel rider-lean wiring. The older
// rider-less frame lives at 'tandem-3d/tandem_bicycle.glb'.
export const BIKE_MODEL_PATH = 'tandem-3d/tandem_riders.glb';

// The bike chooser / lobby preview keeps the original recolorable frame so the
// color presets still take effect there. The in-game bike uses the riders model
// above (one fused mesh, so presets no-op on it).
export const CHOOSER_MODEL_PATH = 'tandem-3d/tandem_bicycle.glb';

/**
 * "Show Riders" setting — when on, the in-game bike is the Canadian-goose
 * riders model (with torso lean + the front-facing selfie cam); when off, the
 * plain frame. With no saved choice it's ON for desktop and OFF on phones:
 * the ~500K-triangle skinned riders, the selfie cam's second full scene render
 * and the PBR lighting made phone rides lag badly (issue #390). An explicit
 * 'on' / 'off' from Options always wins. Read at boot (see Game constructor).
 */
export function getShowRiders() {
  try {
    const pref = localStorage.getItem('tandemonium_show_riders');
    if (pref === 'on') return true;
    if (pref === 'off') return false;
  } catch (e) {}
  return !isMobile;
}

/**
 * "FPS Display" setting — when on, a small frame-rate readout shows at the
 * top of the screen in every mode. Off by default; applies immediately.
 */
export function getShowFps() {
  try { return localStorage.getItem('tandemonium_show_fps') === 'on'; }
  catch (e) { return false; }
}

/**
 * "Physics FX" setting — the Rapier-driven crash tumble, knocked pylons and
 * goose strikes (issue #388). Purely visual: the sidecar drives transforms of
 * transient props and never touches lean, speed, position or anything the
 * netcode serialises, so this is safe to differ between the two players in a
 * multiplayer ride.
 *
 * The default follows the RESOLVED QUALITY TIER, not the form factor. It was
 * originally `!isMobile`, which was wrong for this game: Tandemonium is
 * mobile-first — tilt steering, QR join, phones on handlebars — so keying off
 * `isMobile` switched the whole feature off for most of the people it was
 * built for, silently, with no way to tell. (It also caught touchscreen
 * laptops, since isMobile is true for maxTouchPoints > 1.)
 *
 * A mid-range phone runs this fine: the sidecar is capped at 24 bodies, is
 * usually simulating one or two, and costs nothing at all when nothing is
 * tumbling. The real cost is the one-off ~1MB WASM fetch, which is small next
 * to the 7MB bike GLB the same ride already pays for, and is deferred to the
 * countdown. What genuinely can't afford it is a weak device — and the game
 * already decides that, once, in Game's quality resolution.
 *
 * @param {boolean} [lowQuality] the resolved low-quality tier (Game._lowQuality),
 *   which already folds in the user's Options choice, the ?quality= param and
 *   hardware detection.
 */
export function getPhysicsFx(lowQuality = false) {
  try {
    const v = localStorage.getItem('tandemonium_physics_fx');
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch (e) { /* localStorage unavailable — fall through to the default */ }
  return !lowQuality;
}

// Protocol message types
export const MSG_PEDAL     = 0x01;
export const MSG_STATE     = 0x02;
export const MSG_EVENT     = 0x03;
export const MSG_HEARTBEAT = 0x04;
export const MSG_LEAN      = 0x05;

// Event subtypes
export const EVT_COUNTDOWN = 0x01;
export const EVT_START     = 0x02;
export const EVT_CRASH     = 0x03;
export const EVT_RESET     = 0x04;
export const EVT_GAMEOVER    = 0x05;
export const EVT_CHECKPOINT  = 0x06;
export const EVT_FINISH      = 0x07;
export const EVT_RETURN_ROOM = 0x08;
// B-2 · a reset that lands in the short post-crash countdown, so both riders
// get back on the road at the same moment. A partner on an older build sees
// EVT_RESET semantics for anything it does not know, so this is additive.
export const EVT_RESET_QUICK = 0x09;

export const MSG_COLLECT     = 0x06;
export const MSG_PROFILE     = 0x07;

export const RELAY_URL = 'wss://tandemonium-relay.pete-872.workers.dev';

// Backend API (auth, scores, achievements, leaderboard, /me). Shared by the
// identity client and the achievements sync glue. (#318 Step 4)
export const API_BASE = 'https://tandemonium-api.pete-872.workers.dev';

// Production web URL — used for QR codes in Electron, share links, etc.
// Update this when the domain changes.
export const SITE_URL = 'https://tandemonium.jimandi.love';
export const TURN_CREDENTIALS_URL = 'https://tandemonium-relay.pete-872.workers.dev/turn-credentials';

// Display name shown to a partner when a player joins an invite without
// signing in (anonymous play). See Issue #312.
export const GUEST_NAME = 'Guest';

// Self-hosted PeerJS signaling server (Cloud Run)
export const PEERJS_HOST = 'peerjs-640682648249.us-central1.run.app';
export const PEERJS_PORT = 443;
export const PEERJS_PATH = '/';
export const PEERJS_SECURE = true;

// Shared defaults (platform-independent)
const SHARED_PHYSICS = {
  calibSamples: 10,
  // Controller gyro (WebHID). #399 playtest: 5/5 testers found steering too
  // sensitive ("gyro is fidgety"), so the defaults are gentler:
  //   gyroSensitivity 40 → 55: degrees of controller roll for a full lean.
  gyroSensitivity: 55,
  gyroDeadzone: 4,
  //   gyroOutputSmoothing 0.5 → 0.4: this is the EMA weight of each new
  //   sample, so LOWER = MORE smoothing (see applySteeringFeel: Stable scales
  //   it down). #399 asked for slightly more smoothing.
  gyroOutputSmoothing: 0.4,
  //   gyroResponseCurve 1.5 → 2.0: small rolls barely steer; 2.0 is also the
  //   ceiling applySteeringFeel and calibration clamp it to.
  gyroResponseCurve: 2.0,
  // Steering Feel slider default (0 = Stable … 1 = Responsive). #399: 0.5 →
  // 0.3, the stable end. Only the default — a saved preference wins. Applied
  // at module load below, so it shapes the defaults even with nothing saved.
  steeringFeel: 0.3,
  gyroAccelCorrection: 0.02,
  // Gamepad left stick (#399: "joystick went way off"). Dead zone 0.08 → 0.15,
  // then out = sign(x)·|x|^curve rescaled past the dead zone so full deflection
  // is still 1 — small thumb movements barely steer. See stickResponse().
  stickDeadzone: 0.15,
  stickResponseCurve: 1.8,
  // Phone tilt steering gain: the lean a given tilt produces is scaled by
  // this after the deadzone/response curve. 1 = the original feel; 0.25 =
  // a quarter as sensitive (requested for a phone player who found tilt too
  // twitchy). Phone tilt only — controller gyro (WebHID/Steam) is unchanged.
  mobileTiltGain: 0.25,
  // Shared physics
  leanForce: 12,
  gravityForce: 2.5,
  damping: 4.0,
  turnRate: 0.50,
};

// Platform-specific tilt defaults
const PLATFORM_TILT_DEFAULTS = isAndroid ? {
  // Android: wider range, higher noise floor, heavier filtering
  sensitivity: 32,        // Android gamma reports ~30-50% higher
  deadzone: 5,            // Android rest noise ±2–4° vs iOS ±1–2°
  lowPassK: 0.08,         // more aggressive low-pass on raw accel
  responseCurve: 2.2,     // gentler center zone hides micro-jitter
  outputSmoothing: 0.50,  // heavier EMA compensates for noise
} : {
  // iOS (and desktop fallback): tighter, more responsive
  sensitivity: 23,
  deadzone: 4,
  lowPassK: 0.1,
  responseCurve: 2.0,
  outputSmoothing: 0.38,
};

// Balance physics defaults — single source of truth
export const BALANCE_DEFAULTS = { ...SHARED_PHYSICS, ...PLATFORM_TILT_DEFAULTS };

// Mutable runtime tuning (initialized from defaults, adjustable by player)
export const TUNE = { ...BALANCE_DEFAULTS };

// Difficulty presets
//
// A-5 · honest tension. Safety mode clamps lean to ±1.0, so a preset whose
// crashThreshold sits above 1.0 CANNOT fall while safety is on. That was true
// of every preset, on by default, while the screen said "Don't lean too far or
// you'll crash!". Now:
//
//   safetyDefault true  (tutorial, chill) — cannot fall, by design. The edge is
//                       still felt: past |lean| > 0.8 the bike wobbles (see
//                       EDGE_BAND in bike-model) so the player learns where it is.
//   safetyDefault false (adventurous, daredevil) — falls, and warns first. The
//                       thresholds below are chosen so the danger wobble starts
//                       well before the fall: crashThreshold x dangerOnset is
//                       the lean where the warning begins.
//
// These are starting values. B-1 (the GDEX playtest) retunes them against real
// crash-per-ride numbers.
export const DIFFICULTY_PRESETS = {
  tutorial: {
    safetyDefault: true,        // cannot fall — this is where people learn
    crashThreshold: 2.2,        // ~126° — nearly impossible to reach
    gravityForce: 1.0,          // very weak topple force
    wobbleMultiplier: 0.0,      // NO random wobble
    dangerOnset: 0.85,          // danger shaking only very close to edge
    timeMultiplier: 2.0,        // generous time (timer is hidden anyway)
    maxSpeed: 12,               // lower top speed = easier to control
    scoreMultiplier: 0,         // no scoring in tutorial
    autoCorrection: true,       // gentle return-to-center force
    autoCorrectionStrength: 6.0, // strong self-righting (ramped per phase)
    pedalLeanKickScale: 0.0,    // no random lean impulse on pedal strokes
    autoSpeed: true,            // bike rolls forward automatically
  },
  chill: {
    safetyDefault: true,        // cannot fall; the wobble band teaches the edge
    crashThreshold: 2.2,        // same as tutorial — nearly impossible to crash
    gravityForce: 1.0,          // very weak topple force
    wobbleMultiplier: 0.0,      // no random wobble
    dangerOnset: 0.85,          // danger shaking only very close to edge
    timeMultiplier: 1.3,
    maxSpeed: 12,               // same as tutorial
    scoreMultiplier: 0.75,
    autoCorrection: true,
    autoCorrectionStrength: 6.0, // strong self-righting
    pedalLeanKickScale: 0.0,    // no random lean impulse
    autoSpeed: true,            // steady cruise speed for smooth, stable riding
  },
  adventurous: {
    safetyDefault: false,       // A-5: this is the difficulty that can fall
    crashThreshold: 1.4,        // falls at ~80° of lean
    gravityForce: 1.2,          // slightly more topple than chill
    wobbleMultiplier: 0.1,      // very light wobble
    dangerOnset: 0.65,          // warning from |lean| 0.91 — about 1.5 s of notice
    timeMultiplier: 1.0,
    maxSpeed: 14,               // moderate speed
    scoreMultiplier: 1.0,
    autoCorrection: true,       // still has auto-correction
    autoCorrectionStrength: 4.0, // helps, but no longer does the riding for you
    pedalLeanKickScale: 0.1,    // barely noticeable pedal kicks
  },
  daredevil: {
    safetyDefault: false,
    crashThreshold: 1.2,        // falls at ~69° of lean
    gravityForce: 1.5,          // moderate topple force
    wobbleMultiplier: 0.3,      // light wobble
    dangerOnset: 0.55,          // warning from |lean| 0.66
    timeMultiplier: 0.9,
    maxSpeed: 19,
    scoreMultiplier: 1.5,
    autoCorrection: true,       // still has auto-correction
    autoCorrectionStrength: 2.5, // barely there — you are riding this one
    pedalLeanKickScale: 0.3,    // light pedal kicks
  },
};

export function applyDifficulty(presetName) {
  const preset = DIFFICULTY_PRESETS[presetName] || DIFFICULTY_PRESETS.adventurous;
  Object.assign(TUNE, preset);
}

// The calibrated, UN-FEELED motion tuning (B2, PR #397 review). The tutorial's
// calibration and background adaptation write HERE (setTuningBase) and are what
// gets saved; TUNE's motion params are always applySteeringFeel(base, feel),
// derived once per change. Never copy TUNE back into the base: TUNE is already
// feel-scaled, and re-applying the feel on top compounded every adaptation
// pass (sensitivity 51.7 → 29.6 in ~2 min of gyro riding).
export const TUNING_BASE = { ...BALANCE_DEFAULTS };

/** The motion params steering feel scales (phone tilt + controller gyro). */
export const TUNING_KEYS = ['sensitivity', 'deadzone', 'outputSmoothing', 'responseCurve',
  'gyroSensitivity', 'gyroDeadzone', 'gyroOutputSmoothing', 'gyroResponseCurve'];

/**
 * Write calibrated (un-feeled) values into the base. Only finite numbers for
 * TUNING_KEYS are taken. Follow with applySteeringFeel(feel) to ride them.
 */
export function setTuningBase(values) {
  if (!values) return;
  for (const k of TUNING_KEYS) {
    if (Number.isFinite(values[k])) TUNING_BASE[k] = values[k];
  }
}

/**
 * Legacy: copies TUNE (already feel-scaled) into the base — the B2 compounding
 * bug. Nothing calls it any more; kept only so existing imports still resolve.
 * @deprecated use setTuningBase()
 */
export function snapshotTuningBase() {
  for (const k of TUNING_KEYS) TUNING_BASE[k] = TUNE[k];
}

// Each param's clamp, as applySteeringFeel and calibration apply it.
const TUNING_BOUNDS = {
  sensitivity: [15, 60], deadzone: [2, 8], outputSmoothing: [0.15, 0.8], responseCurve: [1.0, 2.5],
  gyroSensitivity: [15, 60], gyroDeadzone: [2, 8], gyroOutputSmoothing: [0.15, 0.8], gyroResponseCurve: [1.0, 2.0],
};

/** Saves written from this build on hold the un-feeled base (see migrateSavedTuning). */
export const TUNING_SAVE_BASE_FLAG = 'tuningBase';

/**
 * The calibration base held in a saved tuning record (`tandemonium_motion_tuning…`).
 *
 * Saves written before B2's fix stored the FEEL-SCALED values for sensitivity,
 * deadzone and response curve (background adaptation saved TUNE). If such a
 * save carries a steeringFeel, that scale is divided back out using the old
 * formula; a value pinned at its clamp can't be un-scaled (the clamp threw the
 * information away), so that param falls back to its default. outputSmoothing
 * was only ever written by the tutorial, un-feeled, so it is taken as is. A
 * legacy save with no steeringFeel was never feel-scaled (old default 0.5 for
 * the scaled params is the identity). Saves flagged TUNING_SAVE_BASE_FLAG are
 * already the base.
 *
 * Pure. @returns {{ values: object, migrated: boolean }} values keyed like the save.
 */
export function migrateSavedTuning(data, defaults = BALANCE_DEFAULTS) {
  const values = {};
  if (!data || typeof data !== 'object') return { values, migrated: false };
  for (const k of TUNING_KEYS) if (Number.isFinite(data[k])) values[k] = data[k];
  const feel = data.steeringFeel;
  if (data[TUNING_SAVE_BASE_FLAG] || !Number.isFinite(feel)) return { values, migrated: false };
  const gyroSave = data.inputType === 'gyro';
  // The scales the pre-fix applySteeringFeel used (senScale had the old, inverted sign).
  const old = { dz: 1.4 - 0.8 * feel, sen: 0.85 + 0.3 * feel, rc: 0.3 - 0.6 * feel };
  for (const k of Object.keys(values)) {
    if (/OutputSmoothing$|^outputSmoothing$/.test(k)) continue;
    // A gyro save stored the gyro values under the phone-named keys.
    const bk = gyroSave && !k.startsWith('gyro') ? 'gyro' + k[0].toUpperCase() + k.slice(1) : k;
    const [lo, hi] = TUNING_BOUNDS[bk];
    const v = values[k];
    const pinned = v <= lo + 1e-6 || v >= hi - 1e-6;
    let base;
    if (/[sS]ensitivity$/.test(k)) base = v / old.sen;
    else if (/[dD]eadzone$/.test(k)) base = v / old.dz;
    else base = v - old.rc;                     // response curve: additive shift
    values[k] = pinned || !Number.isFinite(base) ? defaults[k] : Math.min(hi, Math.max(lo, base));
  }
  return { values, migrated: true };
}

/**
 * Apply a steering feel value (0 = Stable, 1 = Responsive) by scaling
 * TUNING_BASE into TUNE's motion params. Reads only the base, so calling it
 * any number of times with the same feel gives the same TUNE. Call after
 * setTuningBase (saved tuning, tutorial calibration, adaptation) or when the
 * slider moves.
 * @param {number} feel — 0..1 slider value
 */
export function applySteeringFeel(feel) {
  TUNE.steeringFeel = feel;
  // Deadzone: Stable = wider (×1.4), Responsive = tighter (×0.6)
  const dzScale = 1.4 - 0.8 * feel;
  // Smoothing: Stable = more smoothing (×0.6 output factor), Responsive = less (×1.5)
  const smScale = 0.6 + 0.9 * feel;
  // Sensitivity is DEGREES of tilt for a full lean, so a bigger number steers
  // less. Stable = more degrees (×1.15, gentler), Responsive = fewer (×0.85).
  // (B2: this was 0.85 + 0.3·feel, which made the Stable end twitchier.)
  const senScale = 1.15 - 0.3 * feel;
  // Response curve: Stable = higher exponent (more gradual center), Responsive = lower
  const rcShift = 0.3 - 0.6 * feel; // +0.3 at Stable, -0.3 at Responsive

  // Apply to mobile tilt params (scaled from calibrated base)
  TUNE.deadzone = Math.min(8, Math.max(2, TUNING_BASE.deadzone * dzScale));
  TUNE.outputSmoothing = Math.min(0.8, Math.max(0.15, TUNING_BASE.outputSmoothing * smScale));
  TUNE.sensitivity = Math.min(60, Math.max(15, TUNING_BASE.sensitivity * senScale));
  TUNE.responseCurve = Math.min(2.5, Math.max(1.0, TUNING_BASE.responseCurve + rcShift));

  // Apply to gyro params
  TUNE.gyroDeadzone = Math.min(8, Math.max(2, TUNING_BASE.gyroDeadzone * dzScale));
  TUNE.gyroOutputSmoothing = Math.min(0.8, Math.max(0.15, TUNING_BASE.gyroOutputSmoothing * smScale));
  TUNE.gyroSensitivity = Math.min(60, Math.max(15, TUNING_BASE.gyroSensitivity * senScale));
  TUNE.gyroResponseCurve = Math.min(2.0, Math.max(1.0, TUNING_BASE.gyroResponseCurve + rcShift));
}

// #399: the default feel has to shape the defaults, not just the slider. With
// nothing saved (no tutorial yet) this is what a first-time player rides with;
// a saved preference re-applies over it in Game._loadSavedTuning.
applySteeringFeel(TUNE.steeringFeel);

/**
 * Gamepad left-stick X → lean input (#399). Inside the dead zone → 0; past it
 * the remaining travel is rescaled to 0..1 and raised to `curve`, so a light
 * thumb barely steers and full deflection is still exactly ±1.
 * @param {number} x raw axis, -1..1
 */
export function stickResponse(x, deadzone = TUNE.stickDeadzone, curve = TUNE.stickResponseCurve) {
  const ax = Math.abs(x || 0);
  if (!(ax > deadzone)) return 0;
  if (ax >= 1) return Math.sign(x);
  const t = (ax - deadzone) / (1 - deadzone);
  return Math.sign(x) * Math.pow(t, curve);
}

// ============================================================
// D-6 · Feature flag: the partners board
// ============================================================
//
// The server-side daily board (worker /daily) ships dark. It only ever shows
// the caller and people they have ridden with, so it cannot look like an empty
// global leaderboard — but it still has nothing useful to say until enough
// people are riding Today's Road, and a feature that says nothing teaches
// players to stop looking. Turn this on after two weeks of daily_* data show
// real players, and after the migration has been applied.
export const DAILY_BOARD_ENABLED = false;
