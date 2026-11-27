// ============================================================
// EXIT FLUSH — save the open analytics ride before the app quits (#890)
//
// A page closing as the app exits loses its keepalive requests: the main
// process is gone before they are sent. So the window's close is held once,
// the page is asked to save (analytics.flushOnExit over IPC), and the close
// goes on when it answers or after timeoutMs, whichever is first. Quitting
// never hangs on it.
//
// Pure (no electron import) so node tests can drive it.
// ============================================================

/**
 * @param {object} o
 * @param {(reason: string) => boolean} o.ask  send the request to the page; false when there is no page to ask
 * @param {() => void} o.finish   close the window again (the held close)
 * @param {number} [o.timeoutMs]
 * @param {(msg: string) => void} [o.log]
 * @param {Function} [o.setTimer]
 * @param {Function} [o.clearTimer]
 * @param {() => number} [o.now]
 */
function createExitFlush({ ask, finish, timeoutMs = 1200, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let state = 'idle';   // idle → asking → done
  let timer = null;
  let startedAt = 0;
  let why = '';

  function done(how) {
    if (state !== 'asking') return;
    state = 'done';
    if (timer) clearTimer(timer);
    timer = null;
    log(`[app] exit flush ${how} after ${now() - startedAt} ms (${why})`);
    try { finish(); } catch (e) { log('[app] exit flush: close failed: ' + ((e && e.message) || e)); }
  }

  return {
    /**
     * From the window's 'close' handler. true: let this close go on.
     * false: hold it (preventDefault); finish() closes the window later.
     */
    begin(reason) {
      if (state === 'done') return true;
      if (state === 'asking') return false;
      why = String(reason || 'window_close');
      let asked = false;
      try { asked = ask(why) !== false; } catch (e) { asked = false; }
      if (!asked) { state = 'done'; log(`[app] exit flush skipped: no page to ask (${why})`); return true; }
      state = 'asking';
      startedAt = now();
      timer = setTimer(() => done('timed out'), timeoutMs);
      return false;
    },
    /** The page answered: its writes are done (or it gave up waiting). */
    answered() { done('done'); },
    get state() { return state; },
  };
}

module.exports = { createExitFlush };
