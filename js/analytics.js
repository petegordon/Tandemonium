// ============================================================
// ANALYTICS — fire-and-forget event tracking
// ============================================================

const API_BASE = 'https://tandemonium-api.pete-872.workers.dev/api/analytics';

let sessionId = null;
let currentInputMethod = null;
let currentPage = null;
let currentRideId = null;

// Separate buffers for UI events vs ride events
let eventBuffer = [];
let rideEventBuffer = [];
let flushTimer = null;

// ---- Session Management ----

export function initSession(opts) {
  sessionId = crypto.randomUUID();
  sessionStorage.setItem('tandemonium_session_id', sessionId);
  currentInputMethod = opts.input_method || null;

  beacon(`${API_BASE}/session`, {
    id: sessionId,
    started_at: new Date().toISOString(),
    ...opts,
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

// ---- Ride Tracking ----

export function startRide(opts) {
  currentRideId = crypto.randomUUID();

  beacon(`${API_BASE}/ride`, {
    id: currentRideId,
    session_id: getSessionId(),
    room_code: opts.room_code || null,
    level: opts.level,
    role: opts.role || 'solo',
    difficulty: opts.difficulty || 'normal',
    input_method: currentInputMethod,
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
  try {
    const body = JSON.stringify(data);

    if (method === 'POST' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(e => console.warn('Analytics beacon failed:', e));
    }
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
  });
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushUIEvents();
      flushRideEvents();
    }
  });
}
