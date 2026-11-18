// ============================================================
// TIME IN GAME — the shared House Tandem helper (housetandem-web #37)
// ============================================================
//
// One small, dependency-free file every House Tandem game copies (the
// canonical copy is Tandemonium's js/playtime.js; keep the copies in step).
//
// It counts ACTIVE time only: the tab is visible and, with `idleMs`, the
// player did something in the last `idleMs` (a key, a tap, a pointer, a
// gamepad change, or the game calling noteActivity()). It reports DELTAS of
// whole seconds about once a minute, and what's left when the page hides.
// The server (worker/games.js · recordPlay) caps every delta to real time, so
// two tabs or a retried report can't count a minute twice.
//
// Signed out, nothing is counted: time in game is time on the account, from
// sign-in on. (Simple and honest: no "unclaimed" minutes waiting on a device
// for whoever signs in next.)
//
// Two ways to send:
//   - a game with a House Tandem session on the page: `apiBase` + `getToken`
//     → POST {apiBase}/games/{game}/sync { token, seconds } as text/plain
//     (no CORS preflight; the same body works with navigator.sendBeacon);
//   - a game whose server holds the account (a Discord Activity's relay):
//     `send(seconds, { final })` → return true / a promise of true when sent.
//
//   const pt = createPlaytime({ game: 'dice', send: (s) => relay.send({ t: 'playtime', s }) });
//   pt.start();            // pt.stop() on teardown; pt.noteActivity() from a game loop

const TICK_MS = 5000;
const MAX_PENDING_S = 600;   // the server takes at most 10 minutes per report anyway

/**
 * @param {object} o
 * @param {string} o.game                       'tandemonium', 'dice', 'coins', …
 * @param {string} [o.apiBase]                  the House Tandem API (with getToken)
 * @param {() => (string|null)} [o.getToken]    the session token, or null when signed out
 * @param {(seconds: number, info: { final: boolean }) => (boolean|Promise<boolean>)} [o.send]
 * @param {() => boolean} [o.signedIn]          with `send`: is anyone signed in? (default: yes)
 * @param {number} [o.idleMs]                   0 = visible is enough; else idle after this long
 * @param {number} [o.reportMs]                 how often to report (default 60 s)
 * @param {boolean} [o.watchGamepads]           count gamepad changes as activity
 * @param {() => boolean} [o.busy]             the game is mid-play (a ride): active even without input events
 * @param {() => number} [o.now]
 * @param {any} [o.doc] @param {any} [o.win]    for tests
 */
export function createPlaytime(o) {
  const doc = o.doc || (typeof document !== 'undefined' ? document : null);
  const win = o.win || (typeof window !== 'undefined' ? window : null);
  const now = o.now || (() => Date.now());
  const idleMs = o.idleMs || 0;
  const reportMs = o.reportMs || 60000;
  let pending = 0;          // active seconds not yet reported (fractional)
  let lastTick = now();
  let lastActivity = now();
  let lastReport = now();
  let timer = null;
  let sending = false;
  let padSig = '';

  const visible = () => !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';
  const signedIn = () => (o.send ? (o.signedIn ? !!o.signedIn() : true) : !!(o.getToken && o.getToken()));
  const active = (t) => visible() && (!idleMs || t - lastActivity <= idleMs || !!(o.busy && o.busy()));

  function noteActivity() { lastActivity = now(); }

  function pollPads() {
    if (!o.watchGamepads || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    let sig = '';
    try {
      for (const p of navigator.getGamepads() || []) {
        if (!p) continue;
        sig += p.buttons.map((b) => (b.pressed ? 1 : 0)).join('') + p.axes.map((a) => Math.round(a * 4)).join(',') + '|';
      }
    } catch (e) { return; }
    if (sig !== padSig) { if (padSig) noteActivity(); padSig = sig; }
  }

  /** Fold the time since the last tick into `pending` (only the active part). */
  function accrue() {
    const t = now();
    const dt = Math.max(0, Math.min(t - lastTick, TICK_MS * 2)) / 1000;   // a frozen tab doesn't count its sleep
    lastTick = t;
    if (!signedIn()) { pending = 0; return; }
    if (active(t)) pending = Math.min(MAX_PENDING_S, pending + dt);
  }

  function body(seconds) {
    return JSON.stringify({ token: o.getToken && o.getToken(), seconds });
  }

  /** Report the whole seconds pending. `final`: the page is going away (beacon, no answer). */
  function flush(final = false) {
    const whole = Math.floor(pending);
    if (whole < 1 || !signedIn() || (sending && !final)) return false;
    lastReport = now();
    if (o.send) {
      pending -= whole;
      let r;
      try { r = o.send(whole, { final }); } catch (e) { r = false; }
      if (r && typeof r.then === 'function') {
        sending = true;
        r.then((ok) => { if (!ok) pending = Math.min(MAX_PENDING_S, pending + whole); })
          .catch(() => { pending = Math.min(MAX_PENDING_S, pending + whole); })
          .finally(() => { sending = false; });
      } else if (r === false) pending = Math.min(MAX_PENDING_S, pending + whole);
      return true;
    }
    const url = `${o.apiBase}/games/${o.game}/sync`;
    pending -= whole;
    if (final && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(url, new Blob([body(whole)], { type: 'text/plain' }))) return true;
      } catch (e) {}
    }
    sending = true;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body(whole), keepalive: true })
      .then((res) => { if (!res.ok && res.status !== 401 && res.status !== 404) pending = Math.min(MAX_PENDING_S, pending + whole); })
      .catch(() => { pending = Math.min(MAX_PENDING_S, pending + whole); })
      .finally(() => { sending = false; });
    return true;
  }

  function tick() {
    pollPads();
    accrue();
    if (now() - lastReport >= reportMs) flush(false);
  }

  const onVisibility = () => {
    accrue();
    if (!visible()) flush(true);
    else { lastTick = now(); noteActivity(); }
  };
  const onHide = () => { accrue(); flush(true); };
  const onInput = () => noteActivity();
  const INPUTS = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'];

  return {
    start() {
      if (timer) return;
      lastTick = now(); lastActivity = now(); lastReport = now();
      timer = setInterval(tick, TICK_MS);
      if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
      if (win && win.addEventListener) {
        win.addEventListener('pagehide', onHide);
        for (const e of INPUTS) win.addEventListener(e, onInput, { passive: true, capture: true });
      }
    },
    stop() {
      if (!timer) return;
      accrue();
      flush(true);
      clearInterval(timer);
      timer = null;
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
      if (win && win.removeEventListener) {
        win.removeEventListener('pagehide', onHide);
        for (const e of INPUTS) win.removeEventListener(e, onInput, { capture: true });
      }
    },
    noteActivity,
    /** Report now (e.g. right before signing out). */
    flush(final = false) { accrue(); return flush(final); },
    /** For tests and the debug panel. */
    get pending() { return pending; },
    _tick: tick,
  };
}
