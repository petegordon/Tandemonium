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

export const MSG_COLLECT     = 0x06;
export const MSG_PROFILE     = 0x07;

export const RELAY_URL = 'wss://tandemonium-relay.pete-872.workers.dev';
export const TURN_CREDENTIALS_URL = 'https://tandemonium-relay.pete-872.workers.dev/turn-credentials';

// Balance physics defaults — single source of truth
export const BALANCE_DEFAULTS = {
  // Mobile tilt (DeviceOrientation / DeviceMotion)
  sensitivity: 25,
  deadzone: 4,
  lowPassK: 0.1,
  responseCurve: 1.4,
  outputSmoothing: 0.25,
  calibSamples: 10,
  // Controller gyro (WebHID) — integrated angular velocity accumulates
  // faster than absolute orientation, so needs wider range + more smoothing
  gyroSensitivity: 40,
  gyroDeadzone: 4,
  gyroResponseCurve: 1.3,
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
