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
//   google_uid — only for signed-in players.
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

let sessionId = null;
let currentInputMethod = null;
let currentPage = null;
let currentRideId = null;
let currentControllerName = null;
let currentControllerConnection = null;
let sessionStartTime = null;
let firstInputTracked = false;

// Separate buffers for UI events vs ride events
let eventBuffer = [];
let rideEventBuffer = [];
let flushTimer = null;

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
      id = crypto.randomUUID();
      localStorage.setItem('tandemonium_device_id', id);
    }
    return id;
  } catch {
    return getSessionId();
  }
}

export function initSession(opts) {
  if (DISABLED) return null;
  sessionId = crypto.randomUUID();
  sessionStorage.setItem('tandemonium_session_id', sessionId);
  currentInputMethod = opts.input_method || null;

  sessionStartTime = performance.now();

  beacon(`${API_BASE}/session`, {
    id: sessionId,
    started_at: new Date().toISOString(),
    ...opts,
    device_id: getDeviceId(),
    user_agent: navigator.userAgent,
  });

  flushTimer = setInterval(flushUIEvents, 5000);
  return sessionId;
}

export function getSessionId() {
  if (!sessionId) {
    sessionId = sessionStorage.getItem('tandemonium_session_id');
  }
  return sessionId;
}

// ---- UI/Flow Event Tracking ----

export function trackEvent(eventType, eventData = null) {
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

export function setController(name, connection) {
  currentControllerName = name || null;
  currentControllerConnection = connection || null;
  trackEvent('controller_connect', { name, connection });

  // Update session with controller info
  if (sessionId) {
    beacon(`${API_BASE}/session/${sessionId}`, {
      controller_name: currentControllerName,
      controller_connection: currentControllerConnection,
    }, 'PUT');
  }
}

// ---- Ride Tracking ----

export function startRide(opts) {
  currentRideId = crypto.randomUUID();

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

  beacon(`${API_BASE}/ride/${currentRideId}`, {
    ...opts,
    ended_at: new Date().toISOString(),
  }, 'PUT');
  currentRideId = null;
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

function flushUIEvents() {
  if (eventBuffer.length === 0) return;
  const batch = eventBuffer.splice(0);
  beacon(`${API_BASE}/event/batch`, { events: batch });
}

function beacon(url, data, method = 'POST') {
  if (DISABLED) return;
  try {
    const body = JSON.stringify(data);

    // Always use fetch with explicit no-credentials to avoid CORS preflight issues.
    // sendBeacon inherits cookies which forces credentials mode and requires
    // Access-Control-Allow-Credentials, complicating CORS. fetch + keepalive
    // is equally reliable for fire-and-forget.
    fetch(url, {
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
      beacon(`${API_BASE}/session/${sessionId}`, {
        ended_at: new Date().toISOString(),
      }, 'PUT');
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
