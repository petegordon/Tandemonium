// ============================================================
// CONFIG — shared constants
// ============================================================

const _isElectron = navigator.userAgent.includes('Electron');
export const isMobile = !_isElectron && (
    /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1));
export const isAndroid = /Android/i.test(navigator.userAgent);
export const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

export const BIKE_MODEL_PATH = 'tandem-3d/tandem_bicycle.glb';

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

export const MSG_COLLECT     = 0x06;
export const MSG_PROFILE     = 0x07;

export const RELAY_URL = 'wss://tandemonium-relay.pete-872.workers.dev';

// Production web URL — used for QR codes in Electron, share links, etc.
// Update this when the domain changes.
export const SITE_URL = 'https://tandemonium.jimandi.love';
export const TURN_CREDENTIALS_URL = 'https://tandemonium-relay.pete-872.workers.dev/turn-credentials';

// Self-hosted PeerJS signaling server (Cloud Run)
export const PEERJS_HOST = 'peerjs-640682648249.us-central1.run.app';
export const PEERJS_PORT = 443;
export const PEERJS_PATH = '/';
export const PEERJS_SECURE = true;

// Shared defaults (platform-independent)
const SHARED_PHYSICS = {
  calibSamples: 10,
  // Controller gyro (WebHID) — unchanged, hardware is consistent
  gyroSensitivity: 40,
  gyroDeadzone: 4,
  gyroOutputSmoothing: 0.5,
  gyroResponseCurve: 1.5,
  steeringFeel: 0.5,
  gyroAccelCorrection: 0.02,
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
// Design intent (see issue #261):
//   Chill        — Cruise + laugh. Sync failure is flavor, not danger.
//                  Near-impossible to crash. Sells the ritual co-op ICP.
//   Adventurous  — Default. Crashable but forgiving. Sync failure costs
//                  speed and produces light wobble you can recover from.
//   Daredevil    — Sync or crash. Tight lean threshold, weak auto-help,
//                  and sync failure wobble that BIASES toward current
//                  lean so desync compounds instead of cancelling out.
//                  This is the mode that earns the "sync or crash" pitch
//                  and produces the dramatic wipeouts for clip culture.
//
// Sync tuning keys:
//   syncPenaltyScale  — multiplier on pedal-wobble coming from wrong-foot,
//                       in-phase, or crank-fight taps. 0 mutes it entirely.
//   syncLeanBias      — 0..1. At 0, wobble direction is pure random (cancels
//                       over time). At 1, wobble is fully biased toward the
//                       bike's current lean direction (compounds toward a
//                       fall). Daredevil uses ~0.6 for the compounding feel.
export const DIFFICULTY_PRESETS = {
  tutorial: {
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
    syncPenaltyScale: 0.0,      // no sync penalty — pedal however
    syncLeanBias: 0.0,
  },
  chill: {
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
    syncPenaltyScale: 0.0,      // sync failure is flavor, not danger
    syncLeanBias: 0.0,
  },
  adventurous: {
    crashThreshold: 2.0,        // forgiving but crashable
    gravityForce: 1.2,          // slightly more topple than chill
    wobbleMultiplier: 0.15,     // light wobble
    dangerOnset: 0.75,          // moderate warning
    timeMultiplier: 1.0,
    maxSpeed: 14,               // moderate speed
    scoreMultiplier: 1.0,
    autoCorrection: true,       // still has auto-correction
    autoCorrectionStrength: 5.0, // strong — bike helps a lot
    pedalLeanKickScale: 0.1,    // barely noticeable pedal kicks
    syncPenaltyScale: 1.0,      // baseline: sync has consequences, survivable
    syncLeanBias: 0.2,          // mild bias toward current lean
  },
  daredevil: {
    crashThreshold: 1.4,        // ~80° — tight. Sync or crash.
    gravityForce: 2.0,          // strong topple — gravity matters
    wobbleMultiplier: 0.6,      // real wobble
    dangerOnset: 0.55,          // early warning because falling is real
    timeMultiplier: 0.9,
    maxSpeed: 19,
    scoreMultiplier: 1.5,
    autoCorrection: true,       // token help only
    autoCorrectionStrength: 0.5, // bike barely rescues you — you must ride it
    pedalLeanKickScale: 0.3,    // light pedal kicks
    syncPenaltyScale: 2.5,      // wrong-foot / crank-fight punished hard
    syncLeanBias: 0.6,          // wobble compounds toward current lean
  },
};

export function applyDifficulty(presetName) {
  const preset = DIFFICULTY_PRESETS[presetName] || DIFFICULTY_PRESETS.adventurous;
  Object.assign(TUNE, preset);
}

// Snapshot of calibrated base values for steering feel scaling.
// Updated by tutorial completion and background adaptation saves.
export const TUNING_BASE = { ...BALANCE_DEFAULTS };

/** Capture current TUNE motion params as the base for steering feel scaling. */
export function snapshotTuningBase() {
  for (const k of ['sensitivity', 'deadzone', 'outputSmoothing', 'responseCurve',
                    'gyroSensitivity', 'gyroDeadzone', 'gyroOutputSmoothing', 'gyroResponseCurve']) {
    TUNING_BASE[k] = TUNE[k];
  }
}

/**
 * Apply a steering feel value (0 = Stable, 1 = Responsive) by scaling
 * the calibrated base tuning parameters. Call AFTER loading saved tuning
 * or after tutorial completion.
 * @param {number} feel — 0..1 slider value
 */
export function applySteeringFeel(feel) {
  TUNE.steeringFeel = feel;
  // Deadzone: Stable = wider (×1.4), Responsive = tighter (×0.6)
  const dzScale = 1.4 - 0.8 * feel;
  // Smoothing: Stable = more smoothing (×0.6 output factor), Responsive = less (×1.5)
  const smScale = 0.6 + 0.9 * feel;
  // Sensitivity: Stable = less (×0.85), Responsive = more (×1.15)
  const senScale = 0.85 + 0.3 * feel;
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
