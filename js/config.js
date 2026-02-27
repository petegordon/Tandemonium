// ============================================================
// CONFIG — shared constants
// ============================================================

export const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1);

export const BIKE_MODEL_PATH = '../tandem-3d/tandem_bicycle.glb';

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

export const RELAY_URL = 'wss://tandemonium-relay.pete-872.workers.dev';
