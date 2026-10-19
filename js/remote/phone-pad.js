// @ts-check
// ============================================================
// phone-pad — the phone's end of a phone remote (#421)
// ============================================================
//
// Runs on remote/index.html in the phone's normal browser (inside Discord the
// Activity can't read motion sensors, so the phone page is how motion steering
// works there). Sends the raw tilt angle (tilt-math.js, the same one the game
// computes when it runs on a phone) and the two pedal halves as 8-byte frames
// at ~30 Hz, plus immediately on every pedal change.
//
// One fixed layout that never changes: gamepad-style controls along the top
// (Pause / Recenter, a plus-shaped D-pad, OK / BACK) over the two pedals. Every
// press is always sent; the game decides what it means from its own state
// (pedals while riding, the menu buttons as a gamepad in menus). A layout
// that switched on a message from the game could get stuck on the wrong one
// if that message was lost. Menu buttons are sent as HELD bits, so the
// game's menus need no phone-specific code. {type:'cue'} plays a short sound + buzz, since the
// player is watching the big screen, not the phone.
//
// No text inputs on this page: iOS "Shake to Undo" pops up after typing, and
// here shaking is steering.
// ============================================================

import { orientationToRawTilt, gravityToRawTilt } from '../tilt-math.js';
import {
  parsePadLink, padSocketUrl, encodeFrame, NAV, DEFAULT_PAD_RELAY, relayOverrideAllowed,
} from './pad-protocol.js';

const SEND_MS = 33;          // ~30 Hz
const PING_MS = 5000;
const MIN_PRESS_MS = 100;  // shortest menu press the game is sent
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const state = {
  link: /** @type {ReturnType<typeof parsePadLink>} */ (null),
  relay: DEFAULT_PAD_RELAY,
  ws: /** @type {WebSocket|null} */ (null),
  retry: 0,
  hostHere: false,
  closedForGood: false,
  seq: 0,
  tilt: /** @type {number|null} */ (null),
  sawOrientation: false,
  gravity: /** @type {{x:number,y:number,z:number}|null} */ (null),
  left: false, right: false,
  tapsL: 0, tapsR: 0,
  nav: 0,
  dirty: false,
  lastSend: 0,
  wakeLock: /** @type {any} */ (null),
  lastCue: '',
  audio: /** @type {AudioContext|null} */ (null),
};

// ── Boot: read the link, keep the secret out of the address bar ──
function boot() {
  const parsed = parsePadLink(location.href);
  if (!parsed) return showScreen('bad-link');
  const key = 'tandemonium_pad_' + parsed.code + '_' + parsed.seat;
  if (parsed.secret) {
    try { sessionStorage.setItem(key, parsed.secret); } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    try { parsed.secret = sessionStorage.getItem(key); } catch { /* private mode */ }
  }
  if (!parsed.secret) return showScreen('bad-link');
  state.link = parsed;
  if (parsed.relay && relayOverrideAllowed(location.hostname)) state.relay = parsed.relay;
  $('seat-label').textContent = 'Player ' + parsed.seat;
  showScreen('connect');
  $('btn-connect').addEventListener('click', onConnectTap);
}

// ── Connect tap: motion permission MUST be requested before any await ──
function onConnectTap() {
  if (state.started) return;   // a double tap would start everything twice
  state.started = true;
  const DME = /** @type {any} */ (globalThis.DeviceMotionEvent);
  const DOE = /** @type {any} */ (globalThis.DeviceOrientationEvent);
  /** @type {Promise<any>} */
  let perm = Promise.resolve('granted');
  if (DME && typeof DME.requestPermission === 'function') perm = DME.requestPermission();
  else if (DOE && typeof DOE.requestPermission === 'function') perm = DOE.requestPermission();
  perm.then((r) => {
    if (r !== 'granted') $('motion-note').textContent = 'Motion was blocked. Pedals work; to steer, allow Motion & Orientation for this site and reload.';
  }).catch(() => {}).finally(() => {
    unlockAudio();
    startSensors();
    startTouch();
    startMenuPad();
    requestWakeLock();
    try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* iOS */ }
    showScreen('ride');
    connect();
    setInterval(tick, SEND_MS);
  });
}

// ── Sensors ──
function orientAngle() {
  return screen.orientation ? screen.orientation.angle : (/** @type {any} */ (window).orientation || 0);
}

function startSensors() {
  window.addEventListener('deviceorientation', (e) => {
    const t = orientationToRawTilt(e.beta, e.gamma, orientAngle());
    if (t == null) return;
    state.sawOrientation = true;
    state.tilt = t;
  });
  // Fallback for phones without orientation events, as in InputManager.
  window.addEventListener('devicemotion', (e) => {
    if (state.sawOrientation) return;
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const k = 0.15;
    const g = state.gravity;
    if (!g) state.gravity = { x: a.x, y: a.y, z: a.z };
    else { g.x += (a.x - g.x) * k; g.y += (a.y - g.y) * k; g.z += (a.z - g.z) * k; }
    const gg = /** @type {{x:number,y:number}} */ (state.gravity);
    state.tilt = gravityToRawTilt(gg.x, gg.y, orientAngle());
  });
}

// ── Pedals: left half / right half of the screen, multi-touch ──
function startTouch() {
  const pad = $('pedals');
  /** @type {Map<number, 'L'|'R'>} */
  const touches = new Map();
  const sideOf = (x) => (x < window.innerWidth / 2 ? 'L' : 'R');
  const refresh = () => {
    const vals = [...touches.values()];
    const left = vals.includes('L'), right = vals.includes('R');
    if (left && !state.left) { state.tapsL = (state.tapsL + 1) & 0xff; buzz(); }
    if (right && !state.right) { state.tapsR = (state.tapsR + 1) & 0xff; buzz(); }
    state.left = left; state.right = right;
    $('pedal-l').classList.toggle('down', left);
    $('pedal-r').classList.toggle('down', right);
    state.dirty = true;
    tick();
  };
  pad.addEventListener('touchstart', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) touches.set(t.identifier, sideOf(t.clientX));
    refresh();
  }, { passive: false });
  pad.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) if (touches.has(t.identifier)) touches.set(t.identifier, sideOf(t.clientX));
    refresh();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) touches.delete(t.identifier);
    if (e.touches.length === 0) touches.clear();
    refresh();
  };
  pad.addEventListener('touchend', end);
  pad.addEventListener('touchcancel', end);
  // Mouse, for testing on a desktop browser.
  pad.addEventListener('mousedown', (e) => { touches.set(-1, sideOf(e.clientX)); refresh(); });
  window.addEventListener('mouseup', () => { touches.delete(-1); refresh(); });
}

// ── Top controls: D-pad, OK / BACK, Pause, Recenter, sent as held bits ──
function startMenuPad() {
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#controls [data-nav]'))) {
    const bit = NAV[/** @type {keyof typeof NAV} */ (el.dataset.nav)];
    let downAt = 0;
    let releaseTimer = 0;
    const down = (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      clearTimeout(releaseTimer);
      if (state.nav & bit) return;
      downAt = performance.now();
      state.nav |= bit; el.classList.add('down'); buzz(); state.dirty = true; tick();
    };
    const release = () => {
      if (!(state.nav & bit)) return;
      state.nav &= ~bit; el.classList.remove('down'); state.dirty = true; tick();
    };
    // A quick tap still lasts MIN_PRESS_MS, so the game's once-a-frame menu
    // poll always sees it.
    const up = () => {
      const left = MIN_PRESS_MS - (performance.now() - downAt);
      if (left > 0) releaseTimer = setTimeout(release, left); else release();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }
}

// ── Cues: the player is looking at the big screen ──
function unlockAudio() {
  try {
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (AC && !state.audio) state.audio = new AC();
    if (state.audio && state.audio.state === 'suspended') state.audio.resume();
  } catch { /* no audio */ }
}

/** @param {number} freq @param {number} at seconds from now @param {number} dur */
function tone(freq, at, dur, type = 'sine', gain = 0.18) {
  const ac = state.audio;
  if (!ac) return;
  const t0 = ac.currentTime + at;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = /** @type {OscillatorType} */ (type);
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const CUES = {
  countdown: () => { tone(660, 0, 0.12); vibrate(30); },
  go: () => { tone(990, 0, 0.25); vibrate([40, 30, 40]); },
  crash: () => { tone(140, 0, 0.35, 'sawtooth', 0.14); vibrate([60, 40, 120]); },
  finish: () => { tone(660, 0, 0.15); tone(880, 0.15, 0.15); tone(1320, 0.3, 0.35); vibrate([40, 40, 40, 40, 120]); },
};

function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* iOS has none */ }
}

function buzz() {
  try { navigator.vibrate?.(12); } catch { /* iOS has none */ }
}

// ── Send loop ──
function tick() {
  const ws = state.ws;
  if (!ws || ws.readyState !== 1 || !state.hostHere) return;
  const now = performance.now();
  if (!state.dirty && now - state.lastSend < SEND_MS - 2) return;
  state.seq = (state.seq + 1) & 0xff;
  ws.send(encodeFrame({
    seq: state.seq, tilt: state.tilt, left: state.left, right: state.right,
    tapsL: state.tapsL, tapsR: state.tapsR, nav: state.nav,
  }));
  state.dirty = false;
  state.lastSend = now;
}

// ── Relay connection ──
function connect() {
  if (state.closedForGood || !state.link) return;
  const { code, seat, secret } = state.link;
  setStatus('Connecting…');
  clearTimeout(state.retryTimer);
  const ws = new WebSocket(padSocketUrl(state.relay, code, 'pad-' + seat, secret));
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  let pinger = 0;
  let opened = false;
  // A dial that hangs (a network switch mid-handshake) is abandoned and retried.
  const openTimer = setTimeout(() => { if (ws.readyState === 0) { try { ws.close(); } catch { /* closed */ } } }, 8000);
  ws.onopen = () => {
    clearTimeout(openTimer);
    opened = true;
    state.retry = 0;
    state.failed = 0;
    state.lastRecv = performance.now();
    pinger = setInterval(() => {
      if (ws.readyState !== 1) return;
      // Nothing from the relay (not even a pong) for two pings: the socket is
      // dead even though it says open (iOS after a lock or a network switch).
      if (performance.now() - state.lastRecv > PING_MS * 2 + 1000) { dropSocket(ws); return; }
      try { ws.send('ping'); } catch { /* closed */ }
    }, PING_MS);
  };
  ws.onmessage = (ev) => {
    state.lastRecv = performance.now();
    if (typeof ev.data !== 'string' || ev.data === 'pong') return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'host-ready') { state.hostHere = true; setStatus('Connected', true); state.dirty = true; tick(); }
    else if (m.type === 'host-left' || m.type === 'waiting') { state.hostHere = false; setStatus('Waiting for the game…'); }
    else if (m.type === 'seat' && m.label) $('seat-label').textContent = m.label;
    // (An older game sends {type:'mode'}; the layout no longer changes.)
    else if (m.type === 'bye') {
      state.closedForGood = true;
      setStatus('The game stopped using this phone. Scan its code to connect again.');
      try { ws.close(1000, 'bye'); } catch { /* closed */ }
    }
    else if (m.type === 'cue' && CUES[m.cue]) { state.lastCue = m.cue; CUES[m.cue](); }
  };
  ws.onclose = (ev) => {
    clearTimeout(openTimer);
    clearInterval(pinger);
    if (state.ws !== ws) return;
    state.ws = null;
    state.hostHere = false;
    if (state.closedForGood) return;   // 'bye': keep its message, don't redial
    if (!opened) state.failed = (state.failed || 0) + 1;
    // 4001 = the game made a new link for this seat; 403 at upgrade shows as 1006.
    if (ev.code === 4001) {
      state.closedForGood = true;
      setStatus('This link was replaced. Scan the new code on the game screen.');
      return;
    }
    if (ev.code === 1000 && ev.reason === 'replaced') {
      state.closedForGood = true;
      setStatus('Opened on another phone or tab.');
      return;
    }
    // A link the relay refuses (403) never opens: after a few tries, say so.
    setStatus(state.failed >= 4 ? 'Can’t connect. Check your Wi-Fi, or scan the code on the game screen again.' : 'Reconnecting…');
    const delay = Math.min(8000, 500 * 2 ** state.retry++);
    state.retryTimer = setTimeout(connect, delay);
  };
}

/** Give up on a socket that went quiet and dial again now. */
function dropSocket(ws) {
  if (state.ws !== ws) return;
  state.ws = null;
  state.hostHere = false;
  try { ws.close(); } catch { /* closed */ }
  state.retry = 0;
  connect();
}

// A phone that slept comes back here: reconnect and re-take the wake lock.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  requestWakeLock();
  unlockAudio();
  if (!state.link || state.closedForGood || !$('screen-ride').classList.contains('on')) return;
  // Back from a lock: ask the relay, and redial only if the socket can't answer.
  const ws = state.ws;
  if (ws && ws.readyState === 1) {
    const asked = performance.now();
    try { ws.send('ping'); } catch { /* closed */ }
    setTimeout(() => { if (state.ws === ws && (state.lastRecv || 0) < asked) dropSocket(ws); }, 1500);
  } else if (!ws) { state.retry = 0; connect(); }
});

async function requestWakeLock() {
  try { state.wakeLock = await /** @type {any} */ (navigator).wakeLock?.request('screen'); } catch { /* not allowed */ }
}

// ── UI ──
function showScreen(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('on', el.id === 'screen-' + name);
}

function setStatus(text, ok = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('ok', ok);
}

// Test hook for the local smoke (scripts/smoke-phone-pad.mjs).
/** @type {any} */ (window).__pad = state;

boot();
