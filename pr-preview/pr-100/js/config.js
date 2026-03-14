// ============================================================
// CONFIG — shared constants
// ============================================================

export const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1);

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
export const TURN_CREDENTIALS_URL = 'https://tandemonium-relay.pete-872.workers.dev/turn-credentials';

// Self-hosted PeerJS signaling server (Cloud Run)
export const PEERJS_HOST = 'peerjs-640682648249.us-central1.run.app';
export const PEERJS_PORT = 443;
export const PEERJS_PATH = '/';
export const PEERJS_SECURE = true;

// Balance physics defaults — single source of truth
export const BALANCE_DEFAULTS = {
  // Mobile tilt (DeviceOrientation / DeviceMotion)
  sensitivity: 25,
  deadzone: 4,
  lowPassK: 0.1,
  responseCurve: 2.0,
  outputSmoothing: 0.4,
  calibSamples: 10,
  // Controller gyro (WebHID) — integrated angular velocity accumulates
  // faster than absolute orientation, so needs wider range + more smoothing
  gyroSensitivity: 40,
  gyroDeadzone: 4,
  gyroOutputSmoothing: 0.3,
  // Accelerometer-assisted gyro drift correction
  gyroAccelCorrection: 0.02,
  // Shared physics
  leanForce: 12,
  gravityForce: 2.5,
  damping: 4.0,
  turnRate: 0.50,
};

// Mutable runtime tuning (initialized from defaults, adjustable by player)
export const TUNE = { ...BALANCE_DEFAULTS };

// Difficulty presets
export const DIFFICULTY_PRESETS = {
  chill: {
    crashThreshold: 1.8,
    gravityForce: 1.5,
    wobbleMultiplier: 0.5,
    dangerOnset: 0.75,
    timeMultiplier: 1.3,
    maxSpeed: 14,
    scoreMultiplier: 0.75,
    autoCorrection: true,
  },
  normal: {
    crashThreshold: 1.35,
    gravityForce: 2.5,
    wobbleMultiplier: 1.0,
    dangerOnset: 0.55,
    timeMultiplier: 1.0,
    maxSpeed: 19,
    scoreMultiplier: 1.0,
    autoCorrection: false,
  },
  daredevil: {
    crashThreshold: 1.0,
    gravityForce: 3.5,
    wobbleMultiplier: 1.3,
    dangerOnset: 0.40,
    timeMultiplier: 0.8,
    maxSpeed: 20,
    scoreMultiplier: 1.5,
    autoCorrection: false,
  },
};

export function applyDifficulty(presetName) {
  const preset = DIFFICULTY_PRESETS[presetName] || DIFFICULTY_PRESETS.normal;
  Object.assign(TUNE, preset);
}
