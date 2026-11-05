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
// (plus-shaped D-pad, Pause / Recenter, OK / BACK) over the two pedals. Every
// press is always sent; the game decides what it means from its own state
// (pedals while riding, the menu buttons as a gamepad in menus). A layout
// that switched on a message from the game could get stuck on the wrong one
// if that message was lost. Menu buttons are sent as HELD bits, so the
// game's menus need no phone-specific code. {type:'cue'} plays a short sound + buzz, since the
// player is watching the big screen, not the phone.
//
// No text inputs on this page: iOS "Shake to Undo" pops up after typing, and
// here shaking is steering.
//
// #454, only with a game that answers our hello (v2+; an older game gets
// exactly what it always got):
//   - {type:'mode'} 'menu': send on a change plus a slow heartbeat instead
//     of 30 Hz (anything held still streams at 30 Hz).
//   - {type:'rekey', k}: the game gives this phone its own key and then
//     retires the QR's secret. We keep the new key first and the one we
//     joined with as a fallback (in case the game never got our ack), and a
//     dial that fails tries the other one.
//
// #562 · a shared "Scan to join" link lists several seats (?seats=2,3,4).
// Its secret opens only the FREE ones (the game moves a seat to its own
// secret once a phone takes it), so a dial that never opens tries the next
// seat. The seat that opens is ours from then on (a reload reconnects there).
//
// #563 · a link with ?play=1 asks first: "Control the TV" (the controller,
// as above) or "Play on this phone": we still join a seat, then ask the game
// {type:'open-room'}; it replies {type:'room', code, url} and we go to the
// game's join link, or {type:'room', error} and we offer Control the TV.
// ============================================================

import { orientationToRawTilt, gravityToRawTilt } from '../tilt-math.js';
import {
  parsePadLink, padSocketUrl, encodeFrame, NAV, DEFAULT_PAD_RELAY, relayOverrideAllowed,
  PAD_PROTOCOL, peerVersion, shouldSendFrame, MENU_TILT_STEP, padKeysOnBoot, padKeysAfterRekey,
  playJoinUrl,
} from './pad-protocol.js';

/** #563 · how long "Play on this phone" waits for the TV's room. */
const PLAY_WAIT_MS = 20000;
/** #562 · the next seat of a shared link is tried this soon after a refusal. */
const NEXT_SEAT_MS = 150;

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
  lastChange: 0,
  sentTilt: /** @type {number|null} */ (null),
  wakeLock: /** @type {any} */ (null),
  lastCue: '',
  audio: /** @type {AudioContext|null} */ (null),
  // #454
  hostVersion: 1,        // 1 until the game answers our hello
  mode: 'ride',          // what the game last said; only used with hostVersion >= 2
  keys: /** @type {string[]} */ ([]),   // secrets to try, newest first
  keyIdx: 0,
  storeKey: '',
  framesSent: 0,         // (smoke-test aid)
  // #562 · a shared link: the seats to try, which one we're on, its secret
  seatList: /** @type {number[]} */ ([]),
  sharedSeats: /** @type {number[]} */ ([]),
  seatIdx: 0,
  joinSecret: /** @type {string|null} */ (null),
  everOpened: false,
  started: false,
  ticking: 0,
  // #563 · "Play on this phone"
  playing: false,
  askedRoom: false,
  playTimer: 0,
  playUrl: /** @type {string|null} */ (null),   // (smoke-test aid)
};

/** sessionStorage key for this tab's secrets on one seat. */
const storeKeyFor = (code, seat) => 'tandemonium_pad_' + code + '_' + seat;

function saveKeys() {
  try {
    sessionStorage.setItem(state.storeKey, state.keys[0] || '');
    if (state.keys[1]) sessionStorage.setItem(state.storeKey + '_prev', state.keys[1]);
    else sessionStorage.removeItem(state.storeKey + '_prev');
  } catch { /* private mode */ }
}

// ── Boot: read the link, keep the secret out of the address bar ──
function boot() {
  const parsed = parsePadLink(location.href);
  if (!parsed) return showScreen('bad-link');
  const shared = parsed.seats.length > 1;
  state.seatList = parsed.seats;
  state.seatIdx = 0;
  // #562: a shared link starts on the seat this tab already holds a key for, if any.
  const read = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  if (shared) {
    const i = parsed.seats.findIndex((s) => read(storeKeyFor(parsed.code, s)));
    if (i > 0) state.seatIdx = i;
    state.joinSecret = parsed.secret;
    state.sharedSeats = [...parsed.seats];
  }
  parsed.seat = parsed.seats[state.seatIdx];
  state.storeKey = storeKeyFor(parsed.code, parsed.seat);
  const stored = read(state.storeKey), prev = read(state.storeKey + '_prev');
  state.keys = padKeysOnBoot(parsed.secret, stored, prev);
  if (parsed.secret) history.replaceState(null, '', location.pathname + location.search);
  if (!state.keys.length) return showScreen('bad-link');
  if (!shared) saveKeys();   // a shared link's seat is only ours once it opens
  state.link = parsed;
  if (parsed.relay && relayOverrideAllowed(location.hostname)) state.relay = parsed.relay;
  $('seat-label').textContent = shared ? 'the game on the TV' : 'Player ' + parsed.seat;
  $('btn-connect').addEventListener('click', onConnectTap);
  $('btn-control').addEventListener('click', onConnectTap);
  $('btn-play').addEventListener('click', onPlayTap);
  $('btn-play-control').addEventListener('click', onConnectTap);
  showScreen(parsed.play ? 'choose' : 'connect');
}

// ── #563 · Play on this phone: join a seat, ask the TV for its room, go there ──
function onPlayTap() {
  if (state.started || state.playing) return;
  state.playing = true;
  state.askedRoom = false;
  $('btn-play-control').hidden = true;
  $('play-status').textContent = 'Asking the TV to open a room…';
  showScreen('play');
  clearTimeout(state.playTimer);
  state.playTimer = setTimeout(() => playFailed('The TV didn’t answer.'), PLAY_WAIT_MS);
  if (!state.ws) connect();
  else askForRoom();
  startTicking();   // a heartbeat, so the game doesn't take us for gone
}

/** Ask the game for its online room (once per Play tap, when it is there). */
function askForRoom() {
  const ws = state.ws;
  if (!state.playing || state.askedRoom || !ws || ws.readyState !== 1 || !state.hostHere) return;
  state.askedRoom = true;
  try { ws.send(JSON.stringify({ type: 'open-room' })); } catch { /* closed */ }
}

/** The game's answer to open-room. @param {any} m */
function onRoomReply(m) {
  if (!state.playing) return;
  const url = m && !m.error ? playJoinUrl(location.href, m.code, m.url) : null;
  if (!url) return playFailed(m && m.error === 'not-now' ? 'The TV can’t open a room right now.' : 'The TV couldn’t open a room.');
  clearTimeout(state.playTimer);
  state.playUrl = url;
  state.closedForGood = true;   // we're leaving: no redial
  $('play-status').textContent = 'Joining room ' + m.code + '…';
  try { state.ws?.close(1000, 'play'); } catch { /* closed */ }
  location.assign(url);
}

/** @param {string} why */
function playFailed(why) {
  if (!state.playing) return;
  clearTimeout(state.playTimer);
  state.playing = false;
  state.askedRoom = false;
  $('play-status').textContent = why + ' You can still use this phone as the controller.';
  $('btn-play-control').hidden = false;
}

function startTicking() {
  if (!state.ticking) state.ticking = setInterval(tick, SEND_MS);
}

// ── Connect tap: motion permission MUST be requested before any await ──
function onConnectTap() {
  if (state.started) return;   // a double tap would start everything twice
  state.started = true;
  state.playing = false;
  clearTimeout(state.playTimer);
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
    if (!state.ws) connect();   // after a Play that failed we're already on a seat
    startTicking();
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
  const light = state.hostVersion >= 2 && state.mode === 'menu';
  if (light && !state.dirty) {
    // In menus a moving phone still counts as a change; a still one is idle.
    const t = state.tilt, s = state.sentTilt;
    if ((t == null) !== (s == null) || (t != null && s != null && Math.abs(t - s) >= MENU_TILT_STEP)) state.lastChange = now;
  }
  if (state.dirty) state.lastChange = now;
  const held = state.left || state.right || state.nav !== 0;
  if (!shouldSendFrame({ dirty: state.dirty, light, held, now, lastSend: state.lastSend, lastChange: state.lastChange, sendMs: SEND_MS })) return;
  state.sentTilt = state.tilt;
  state.framesSent++;
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
  const { code, seat } = state.link;
  setStatus('Connecting…');
  clearTimeout(state.retryTimer);
  if (state.keyIdx >= state.keys.length) state.keyIdx = 0;
  const secret = state.keys[state.keyIdx];
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
    // This secret works: the others are stale.
    if (state.keys.length > 1 || state.keyIdx) { state.keys = [secret]; state.keyIdx = 0; saveKeys(); }
    // #562: a shared link's seat that opened is ours: stick to it (and a
    // reload comes back to it, not to the shared list).
    if (!state.everOpened && state.seatList.length > 1) {
      state.seatList = [seat];
      state.seatIdx = 0;
      saveKeys();
      try {
        const u = new URL(location.href);
        u.searchParams.set('seat', String(seat));
        u.searchParams.delete('seats');
        u.searchParams.delete('play');
        history.replaceState(null, '', u.pathname + u.search);
      } catch { /* no history */ }
    }
    state.everOpened = true;
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
    if (m.type === 'host-ready') {
      state.hostHere = true;
      setStatus('Connected', true);
      // #454: an older game ignores this, and never answers.
      try { ws.send(JSON.stringify({ type: 'hello', v: PAD_PROTOCOL })); } catch { /* closed */ }
      state.dirty = true; tick();
      askForRoom();   // #563: only while "Play on this phone" waits
    }
    else if (m.type === 'room') onRoomReply(m);   // #563
    else if (m.type === 'host-left' || m.type === 'waiting') { state.hostHere = false; forgetHost(); setStatus('Waiting for the game…'); }
    else if (m.type === 'seat' && m.label) {
      $('seat-label').textContent = m.label;
      // #562: an extra seat is told where the game is ("watch the TV").
      if (m.note) setStatus(m.note, true);
    }
    else if (m.type === 'hello') state.hostVersion = peerVersion(m);
    // The layout never changes on 'mode'; it only sets how often we send.
    // (A much older game also sent 'mode', without hello: ignored.)
    else if (m.type === 'mode' && state.hostVersion >= 2) { state.mode = m.mode === 'menu' ? 'menu' : 'ride'; state.dirty = true; tick(); }
    else if (m.type === 'rekey' && state.hostVersion >= 2) {
      const next = padKeysAfterRekey(secret, m.k);
      if (next) {
        state.keys = next; state.keyIdx = 0; saveKeys();
        try { ws.send(JSON.stringify({ type: 'rekeyed', k: m.k })); } catch { /* closed */ }
      }
    }
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
    forgetHost();
    if (state.closedForGood) return;   // 'bye': keep its message, don't redial
    // #562: on a shared link, a seat that never opened (taken: its secret
    // moved on) or that another phone just took from under us (before the
    // game gave us a key) means: try the next seat, soon.
    const shared = state.seatList.length > 1 && !!state.joinSecret;
    const bumped = ev.code === 1000 && ev.reason === 'replaced' && opened && state.sharedSeats.length > 1
      && !!state.joinSecret && state.keys[0] === state.joinSecret;
    if (!opened && shared && state.keyIdx + 1 >= state.keys.length) {
      const wrapped = nextSeat();
      if (wrapped) state.failed = (state.failed || 0) + 1;
      if (wrapped) setStatus('No free seat on the TV right now. Retrying…');
      const delay = wrapped ? Math.min(8000, 500 * 2 ** state.retry++) : NEXT_SEAT_MS;
      state.retryTimer = setTimeout(connect, delay);
      return;
    }
    if (bumped) {
      // Two phones scanned at the same moment and the other one won this seat.
      state.everOpened = false;
      state.seatList = [...state.sharedSeats];
      state.seatIdx = Math.max(0, state.seatList.indexOf(state.link ? state.link.seat : 0));
      nextSeat();
      state.retryTimer = setTimeout(connect, NEXT_SEAT_MS);
      return;
    }
    if (!opened) {
      state.failed = (state.failed || 0) + 1;
      // Refused, maybe: the next dial tries our other secret (if we have one).
      state.keyIdx = (state.keyIdx + 1) % Math.max(1, state.keys.length);
    }
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

/**
 * #562 · move a shared link on to its next seat (with the shared secret).
 * @returns {boolean} true when it wrapped round: every seat was tried
 */
function nextSeat() {
  const link = /** @type {NonNullable<typeof state.link>} */ (state.link);
  state.seatIdx = (state.seatIdx + 1) % state.seatList.length;
  link.seat = state.seatList[state.seatIdx];
  state.storeKey = storeKeyFor(link.code, link.seat);
  state.keys = [/** @type {string} */ (state.joinSecret)];
  state.keyIdx = 0;
  return state.seatIdx === 0;
}

/** Until the game says hello again, assume an older one (full rate, no rekey). */
function forgetHost() {
  state.hostVersion = 1;
  state.mode = 'ride';
}

/** Give up on a socket that went quiet and dial again now. */
function dropSocket(ws) {
  if (state.ws !== ws) return;
  state.ws = null;
  state.hostHere = false;
  forgetHost();
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
