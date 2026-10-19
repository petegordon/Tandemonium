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
// No text inputs on this page: iOS "Shake to Undo" pops up after typing, and
// here shaking is steering.
// ============================================================

import { orientationToRawTilt, gravityToRawTilt } from '../tilt-math.js';
import {
  parsePadLink, padSocketUrl, encodeFrame, NAV, DEFAULT_PAD_RELAY, relayOverrideAllowed,
} from './pad-protocol.js';

const SEND_MS = 33;          // ~30 Hz
const PING_MS = 5000;
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
  const DME = /** @type {any} */ (globalThis.DeviceMotionEvent);
  const DOE = /** @type {any} */ (globalThis.DeviceOrientationEvent);
  /** @type {Promise<any>} */
  let perm = Promise.resolve('granted');
  if (DME && typeof DME.requestPermission === 'function') perm = DME.requestPermission();
  else if (DOE && typeof DOE.requestPermission === 'function') perm = DOE.requestPermission();
  perm.then((r) => {
    if (r !== 'granted') $('motion-note').textContent = 'Motion was blocked. Pedals work; to steer, allow Motion & Orientation for this site and reload.';
  }).catch(() => {}).finally(() => {
    startSensors();
    startTouch();
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

  $('btn-recenter').addEventListener('touchstart', (e) => { e.stopPropagation(); pressNav(NAV.recenter); }, { passive: true });
  $('btn-recenter').addEventListener('click', () => pressNav(NAV.recenter));
}

/** Hold a nav bit for a few frames so the host sees the edge. */
function pressNav(bit) {
  state.nav |= bit;
  state.dirty = true;
  tick();
  setTimeout(() => { state.nav &= ~bit; state.dirty = true; }, 150);
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
  const ws = new WebSocket(padSocketUrl(state.relay, code, 'pad-' + seat, secret));
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  let pinger = 0;
  ws.onopen = () => {
    state.retry = 0;
    pinger = setInterval(() => { try { ws.send('ping'); } catch { /* closed */ } }, PING_MS);
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string' || ev.data === 'pong') return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'host-ready') { state.hostHere = true; setStatus('Connected', true); state.dirty = true; tick(); }
    else if (m.type === 'host-left' || m.type === 'waiting') { state.hostHere = false; setStatus('Waiting for the game…'); }
    else if (m.type === 'seat' && m.label) $('seat-label').textContent = m.label;
  };
  ws.onclose = (ev) => {
    clearInterval(pinger);
    if (state.ws !== ws) return;
    state.ws = null;
    state.hostHere = false;
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
    setStatus('Reconnecting…');
    const delay = Math.min(8000, 500 * 2 ** state.retry++);
    setTimeout(connect, delay);
  };
}

// A phone that slept comes back here: reconnect and re-take the wake lock.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  requestWakeLock();
  if (!state.ws && state.link && !state.closedForGood && $('screen-ride').classList.contains('on')) {
    state.retry = 0;
    connect();
  }
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
