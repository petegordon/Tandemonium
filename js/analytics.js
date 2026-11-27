// ============================================================
// ANALYTICS — fire-and-forget event tracking
// ============================================================
//
// Identity, in three layers:
//   sessionId  — one per tab, in sessionStorage. What every event is keyed to.
//   device_id  — one per browser profile, in localStorage (A-9). Anonymous and
//                never shown to players; it is the only way to tell "the same
//                person came back tomorrow" from "a new player arrived", which
//                is what makes D1/D7 retention measurable for signed-out users.
//   account    — only from a verified sign-in token (account_token), never a claimed id.
//   steam_id   — the Steam build only (#889): the SteamID64, signed in or not. Analytics
//                only; the server never trusts it for who someone is (setSteamId below).
//
// Helper vocabulary used by the current work (add here, don't invent names at
// the call site):
//   trackEvent('crash_recover', { ms, cause })    how long a crash cost
//   trackConversion('wishlist_click', where)      demo -> store page
//   trackConversion('invite_click', where)        "send a link" on an end screen

const API_BASE = 'https://tandemonium-api.pete-872.workers.dev/api/analytics';
const IS_ELECTRON = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');
const DISABLED = !IS_ELECTRON && typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

// Consent (js/consent.js): null until the game knows whether this player may be counted,
// then true or false. Nothing is sent before a yes; a no clears what was waiting.
let allowed = null;
let consentMark = null;      // sent with every write after a yes in a country that asks
let pendingSession = null;   // the session row, held until a yes (kept through a no: Settings can turn it on later)
const PENDING_EVENTS_MAX = 300;

/** Add the mark of a yes to an analytics address (the API drops unmarked writes from countries that ask). */
function marked(url) {
  return consentMark ? url + (url.includes('?') ? '&' : '?') + 'consent=' + encodeURIComponent(consentMark) : url;
}

/** May analytics run? null: not known yet. */
export function analyticsAllowed() { return allowed; }
/** Analytics never run here (a developer's own machine). */
export function analyticsDisabled() { return DISABLED; }

/**
 * The answer is in. true: the held session starts and events flow. false: nothing is sent,
 * now or later this launch, and what was waiting is dropped. `mark`: the consent version.
 */
export function setAnalyticsAllowed(yes, mark = null) {
  allowed = !!yes;
  consentMark = allowed && mark ? String(mark) : null;
  if (!allowed) {
    eventBuffer = [];
    rideEventBuffer = [];
    currentRideId = null;
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    return;
  }
  if (DISABLED) return;
  if (pendingSession) {
    const data = pendingSession;
    pendingSession = null;
    createSession(accountToken ? { ...data, account_token: accountToken } : data);
  }
  if (sessionId && !flushTimer) flushTimer = setInterval(flushUIEvents, 5000);
}

let sessionId = null;
let currentInputMethod = null;
let currentPage = null;
let currentRideId = null;
let currentRideStartedAt = 0;   // performance.now() at startRide: an end without its own duration uses it
let currentControllerName = null;
let currentControllerConnection = null;
let sessionStartTime = null;
let firstInputTracked = false;

// Separate buffers for UI events vs ride events
let eventBuffer = [];
let rideEventBuffer = [];
let flushTimer = null;

/**
 * A UUID that survives an insecure context.
 *
 * crypto.randomUUID is [SecureContext]-only, so it is simply undefined when the
 * page is served over plain http — which is how a phone reaches the site when it
 * follows an http:// link, and is what boot-blocked the game on iOS. Anonymous
 * analytics identity must never be the thing that stops the game starting, so
 * fall back to getRandomValues, and then to Math.random, before giving up.
 */
function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40;  // version 4
  b[8] = (b[8] & 0x3f) | 0x80;  // variant 1
  const h = [...b].map(x => x.toString(16).padStart(2, '0'));
  return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
         h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' +
         h.slice(10, 16).join('');
}

// ---- Session Management ----

/**
 * A-9 · a stable anonymous id for this browser profile.
 *
 * Falls back to the session id when localStorage is unavailable (private mode,
 * blocked site data) so the payload shape never changes and nothing throws —
 * those sessions simply look like one-visit devices, which is the truth as far
 * as we can know it.
 */
export function getDeviceId() {
  try {
    let id = localStorage.getItem('tandemonium_device_id');
    if (!id) {
      id = uuid();
      localStorage.setItem('tandemonium_device_id', id);
    }
    return id;
  } catch {
    return getSessionId();
  }
}

export function initSession(opts) {
  if (DISABLED) return null;
  sessionId = uuid();
  sessionStorage.setItem('tandemonium_session_id', sessionId);
  currentInputMethod = opts.input_method || null;
  // Already signed in at launch: the server reads the account from this token.
  if (opts.account_token) accountToken = opts.account_token;

  sessionStartTime = performance.now();

  const data = {
    id: sessionId,
    started_at: new Date().toISOString(),
    ...opts,
    device_id: getDeviceId(),
    user_agent: navigator.userAgent,
  };
  if (steamId) data.steam_id = steamId;
  requestSteamId();
  // Not known yet whether this player may be counted: the row waits (setAnalyticsAllowed).
  if (allowed !== true) { pendingSession = data; return sessionId; }
  createSession(data);
  flushTimer = setInterval(flushUIEvents, 5000);
  return sessionId;
}

// The account this session belongs to, once Player 1 signs in. The session row
// is created at launch, before the Steam build's ticket sign-in finishes, so it
// was left a guest (Pete 2026-11-09: signed-in Steam players read as guests).
// The server takes the account from the verified token, never from the client.
let accountToken = null;
// The Steam sign-in attaches the account itself (it sends the session id);
// this covers the other sign-ins. A shared venue IP can hit the per-IP update
// limit (429), so it tries again a few times, spread out.
const ATTACH_RETRY_MS = [5000, 20000, 60000];
export function attachAccount(token) {
  if (DISABLED || !token || token === accountToken) return;
  accountToken = token;
  const sid = sessionId;
  if (!sid || allowed !== true) return;   // (a held session row takes the token with it)
  const send = (attempt) => {
    if (accountToken !== token || allowed !== true) return;   // signed in again since: that one carries on
    fetch(marked(`${API_BASE}/session/${sid}`), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ account_token: token }), keepalive: true, credentials: 'omit',
    }).then((r) => { if (!r.ok) throw new Error(String(r.status)); })
      .catch(() => { if (attempt < ATTACH_RETRY_MS.length) setTimeout(() => send(attempt + 1), ATTACH_RETRY_MS[attempt]); });
  };
  send(0);
}
/** Later session updates carry it too, in case the first one beat the create. */
function withAccount(data) {
  return accountToken ? { ...data, account_token: accountToken } : data;
}

// #889 · the Steam build records the player's SteamID64 with the session, signed in or not
// (Pete 2026-11-27: to improve the game and follow Steam achievements). Only the id: no name,
// avatar or friends. window.steam is the Electron preload's, so no other build sends one. The
// server keeps it for analytics only and never trusts it for sign-in.
const STEAM_ID64 = /^7656119\d{10}$/;
let steamId = null;
function requestSteamId() {
  const s = typeof window !== 'undefined' ? window.steam : null;
  if (steamId || !s || typeof s.getSteamId !== 'function') return;
  Promise.resolve().then(() => s.getSteamId()).then(setSteamId, () => {});
}
/**
 * The Steam ID is known. It goes with the session row when that hasn't gone out yet (or is
 * held for consent), else on a session update. Set once per launch; anything else is ignored.
 */
export function setSteamId(id) {
  if (DISABLED || steamId || typeof id !== 'string' || !STEAM_ID64.test(id)) return;
  steamId = id;
  if (pendingSession) { pendingSession.steam_id = id; return; }
  const sid = sessionId;
  if (!sid || allowed !== true) return;   // no session yet: initSession takes it
  const send = (attempt) => {
    if (allowed !== true) return;
    fetch(marked(`${API_BASE}/session/${sid}`), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ steam_id: id }), keepalive: true, credentials: 'omit',
    }).then((r) => { if (!r.ok) throw new Error(String(r.status)); })
      .catch(() => { if (attempt < ATTACH_RETRY_MS.length) setTimeout(() => send(attempt + 1), ATTACH_RETRY_MS[attempt]); });
  };
  send(0);
}

export function getSessionId() {
  if (!sessionId) {
    sessionId = sessionStorage.getItem('tandemonium_session_id');
  }
  return sessionId;
}

// ---- UI/Flow Event Tracking ----

export function trackEvent(eventType, eventData = null) {
  if (allowed === false) return;
  eventBuffer.push({
    session_id: getSessionId(),
    event_type: eventType,
    event_data: eventData,
    page: currentPage,
    input_method: currentInputMethod,
    created_at: new Date().toISOString(),
  });

  // Flush immediately for critical funnel events
  const immediate = [
    'tutorial_complete', 'tutorial_abandon',
    'cta_click', 'room_connect', 'room_connect_fail',
    'room_disconnect', 'auth_complete'
  ];
  if (immediate.includes(eventType)) {
    flushUIEvents();
  }
}

export function setPage(page) {
  const from = currentPage;
  currentPage = page;
  trackEvent('page_view', { page, from });
}

export function setInputMethod(method) {
  const prev = currentInputMethod;
  currentInputMethod = method;
  if (prev && prev !== method) {
    trackEvent('input_change', { from: prev, to: method });
  }
}

export function getInputMethod() {
  return currentInputMethod;
}

export function trackFirstInput(action) {
  if (firstInputTracked || !sessionStartTime) return;
  firstInputTracked = true;
  const ms = Math.round(performance.now() - sessionStartTime);
  trackEvent('first_input', { action, time_to_first_input_ms: ms });
}

let controllerPutTimer = null;
let controllerSent = null;   // "name|connection" last written to the session

export function setController(name, connection) {
  // Every seated controller's InputManager reports here, so seating a player
  // over and over repeats the same names. Only a change is news.
  const key = `${name || ''}|${connection || ''}`;
  if (key === `${currentControllerName || ''}|${currentControllerConnection || ''}`) return;
  currentControllerName = name || null;
  currentControllerConnection = connection || null;
  trackEvent('controller_connect', { name, connection });

  // Update the session with the controller, at most once every 10 s (the
  // latest wins). One PUT per change used to burn the API's per-IP session
  // budget during a burst of seat changes, and the next session's create was
  // then refused (429), which lost that whole session's events.
  if (!sessionId || controllerPutTimer) return;
  controllerPutTimer = setTimeout(() => {
    controllerPutTimer = null;
    const now = `${currentControllerName || ''}|${currentControllerConnection || ''}`;
    if (now === controllerSent) return;
    controllerSent = now;
    beacon(`${API_BASE}/session/${sessionId}`, withAccount({
      controller_name: currentControllerName,
      controller_connection: currentControllerConnection,
    }), 'PUT');
  }, 10000);
}

// ---- Ride Tracking ----

export function startRide(opts) {
  currentRideId = uuid();
  currentRideStartedAt = performance.now();

  beacon(`${API_BASE}/ride`, {
    id: currentRideId,
    session_id: getSessionId(),
    room_code: opts.room_code || null,
    level: opts.level,
    role: opts.role || 'solo',
    difficulty: opts.difficulty || 'adventurous',
    input_method: currentInputMethod,
    controller_name: currentControllerName,
    controller_connection: currentControllerConnection,
    bike_preset: opts.bike_preset || 'default',
    steering_feel: opts.steering_feel,
    started_at: new Date().toISOString(),
    // Everyone on the ride: seat, role/team, controller, and each seat's own
    // sign-in token (the server reads the account from it).
    seats: Array.isArray(opts.seats) ? opts.seats : undefined,
  });

  return currentRideId;
}

export function trackRideEvent(eventType, distance, eventData = null) {
  if (!currentRideId) return;
  rideEventBuffer.push({
    event_type: eventType,
    distance,
    event_data: eventData,
    created_at: new Date().toISOString(),
  });
}

export function flushRideEvents() {
  if (!currentRideId || rideEventBuffer.length === 0) return;
  const batch = rideEventBuffer.splice(0);
  beacon(`${API_BASE}/ride/${currentRideId}/events`, { events: batch });
}

export function endRide(opts) {
  if (!currentRideId) return;

  // Flush any remaining ride events first
  flushRideEvents();

  // #887: an abandoned ride has no race clock to report; how long it was open is its duration.
  const duration = opts && opts.duration_ms != null ? {}
    : { duration_ms: Math.max(0, Math.round(performance.now() - currentRideStartedAt)) };
  beacon(`${API_BASE}/ride/${currentRideId}`, {
    ...duration,
    ...opts,
    ended_at: new Date().toISOString(),
  }, 'PUT');
  currentRideId = null;
  currentRideStartedAt = 0;
}

export function getCurrentRideId() {
  return currentRideId;
}

// ---- Room Tracking ----

export function trackRoomCreate(code) {
  beacon(`${API_BASE}/room`, {
    code,
    captain_session_id: getSessionId(),
    created_at: new Date().toISOString(),
  });
  trackConversion('room_code_generated', currentPage);
}

export function trackRoomUpdate(code, data) {
  beacon(`${API_BASE}/room/${code}`, data, 'PUT');
}

// ---- Conversion Tracking ----

/** A-9 · how long a crash actually cost the rider (B-2 reads this). */
export function trackCrashRecover(ms, cause) {
  trackEvent('crash_recover', { ms: Math.round(ms), cause: cause || 'unknown' });
}

/** A-9 · demo -> Steam page. `where` is the screen it was clicked from. */
export function trackWishlistClick(where) {
  trackConversion('wishlist_click', where);
}

/** A-9 · "send a link" on an end screen — the co-op invite funnel. */
export function trackInviteClick(where) {
  trackConversion('invite_click', where);
}

export function trackConversion(action, context, url = null) {
  beacon(`${API_BASE}/conversion`, {
    session_id: getSessionId(),
    action,
    context,
    url,
    created_at: new Date().toISOString(),
  });
}

// ---- Internal Helpers ----

/**
 * Create the session row, retrying if the API refuses it for now (429 or a
 * 5xx). Events no longer depend on it (the API makes a placeholder session
 * for them), but the row carries the device, platform and user agent.
 */
function createSession(data, attempt = 0) {
  if (DISABLED || allowed !== true) return;
  fetch(marked(`${API_BASE}/session`), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(data),
    keepalive: true,
    credentials: 'omit',
  }).then((res) => {
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = (parseInt(res.headers.get('Retry-After') || '', 10) || 60) * 1000;
      setTimeout(() => createSession(data, attempt + 1), wait + Math.random() * 5000);
    }
  }).catch(e => console.warn('Analytics session failed:', e));
}

function flushUIEvents() {
  if (allowed !== true) {
    // Waiting for the answer: keep the latest few. A no: keep none.
    if (allowed === false) eventBuffer = [];
    else if (eventBuffer.length > PENDING_EVENTS_MAX) eventBuffer.splice(0, eventBuffer.length - PENDING_EVENTS_MAX);
    return;
  }
  if (eventBuffer.length === 0) return;
  const batch = eventBuffer.splice(0);
  // Events tracked before initSession() have no session yet; give them this one.
  const sid = getSessionId();
  if (sid) for (const e of batch) if (!e.session_id) e.session_id = sid;
  beacon(`${API_BASE}/event/batch`, { events: batch });
}

function beacon(url, data, method = 'POST') {
  if (DISABLED || allowed !== true) return;
  try {
    const body = JSON.stringify(data);

    // Always use fetch with explicit no-credentials to avoid CORS preflight issues.
    // sendBeacon inherits cookies which forces credentials mode and requires
    // Access-Control-Allow-Credentials, complicating CORS. fetch + keepalive
    // is equally reliable for fire-and-forget.
    fetch(marked(url), {
      method,
      headers: { 'Content-Type': 'text/plain' },
      body,
      keepalive: true,
      credentials: 'omit',
    }).catch(e => console.warn('Analytics beacon failed:', e));
  } catch (e) {
    console.warn('Analytics error:', e);
  }
}

// Flush on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (currentRideId) {
      endRide({ completed: false, abandon_reason: 'page_close' });
    }
    flushUIEvents();
    // End session for duration tracking
    if (sessionId) {
      beacon(`${API_BASE}/session/${sessionId}`, withAccount({
        ended_at: new Date().toISOString(),
      }), 'PUT');
    }
  });
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushUIEvents();
      flushRideEvents();
    }
  });

  // ---- Error/Exception Tracking ----
  let errorCount = 0;
  const MAX_ERRORS = 10; // cap per session to avoid flooding

  window.addEventListener('error', (e) => {
    if (DISABLED || errorCount >= MAX_ERRORS) return;
    errorCount++;
    trackEvent('js_error', {
      message: e.message,
      source: e.filename ? e.filename.split('/').pop() : null,
      line: e.lineno,
      col: e.colno,
    });
    flushUIEvents();
  });

  window.addEventListener('unhandledrejection', (e) => {
    if (DISABLED || errorCount >= MAX_ERRORS) return;
    errorCount++;
    const reason = e.reason;
    trackEvent('js_error', {
      message: reason ? (reason.message || String(reason)).slice(0, 200) : 'unhandled promise rejection',
      source: reason && reason.stack ? reason.stack.split('\n')[1]?.trim().slice(0, 100) : null,
      type: 'unhandledrejection',
    });
    flushUIEvents();
  });
}
