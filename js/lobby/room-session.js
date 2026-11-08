// @ts-check
// ============================================================
// RoomSession — the online room's create / join / rejoin / leave lifecycle
// ============================================================
//
// One owner for "this screen is in an online room" (#346, from #318 Step 3).
// It opens the room transport (via NetSession, the epoch stale-guard), wires
// its connect / disconnect / auth callbacks, saves the room to Recent Rooms,
// buffers the partner's room messages until the room screen listens, runs the
// stale-rejoin timer, and tears the room down. It never touches the DOM: what
// the player sees goes through the small `host` interface the lobby provides.
//
// API (the lobby calls these):
//   create()                     captain: open a new room (new code)
//   join(code, { viaUrl })       stoker: join a room by code
//   rejoin(saved)                a Recent Rooms entry { roomCode, role }: same seat, same code
//   leave({ forget })            leave the room (destroy the transport); forget = drop it from Recent Rooms
//   dropIfCurrent(net)           the room screen saw `net` drop: destroy it; leave if it is still the room
//   abandonStale()               the stale prompt's "New Room": forget the room and leave
//   queueProfiles(list) / takeQueued()   the partner's room messages heard before the room screen listened
//   pendingCreate / pendingJoinCode      "sign in, then create / join" (picked up by the lobby's login handler)
//   autoJoinCode(search)         static: the room code in a ?room= link, or null
//
// Host interface (the lobby implements these; see Lobby._roomSessionHost):
//   replaceNet()                       new transport, epoch++ (Lobby._replaceNet, which smoke:rejoin wraps)
//   media()                            { camera, audio, cameraPermitted, audioPermitted }
//   newRoom(kind)                      'create' | 'join' | 'rejoin': forget the last partner
//   status(seat, text, cls?)           seat 'host' | 'join'; cls '' | 'connected' | 'error' (undefined: keep)
//   showCode(text)                     the host step's code display
//   roomOpen(code, { rejoin })         captain: the relay has us in the room
//   partnerHere(role)                  the partner connected (immediately)
//   partnerConnected(role)             … and the room screen should open (after CONNECT_SETTLE_MS)
//   connectFailed(role, code)          stoker: the join failed (spinners, retry code)
//   onStep(name)                       is the lobby on step 'host' | 'join'?
//   staleRoom(seat)                    the rejoined room is still empty: offer "New Room"
//
// Tested in test/unit/room-session.test.mjs with fake transports.
// ============================================================

/** The partner connected: the room screen opens this long after (its messages are buffered meanwhile on a rejoin). */
export const CONNECT_SETTLE_MS = 1000;
/** A rejoined room still without the partner after this long offers "New Room". */
export const STALE_ROOM_MS = 30000;

const noop = () => {};
const NO_ANALYTICS = { trackRoomCreate: noop, trackEvent: noop, trackRoomUpdate: noop, trackConversion: noop, getSessionId: () => '' };

export class RoomSession {
  /**
   * @param {object} o
   * @param {any} o.netSession             NetSession (the live transport + epoch)
   * @param {any} o.store                  RoomStore (Recent Rooms)
   * @param {string} o.relayUrl
   * @param {any} o.auth                   { getRelayToken(code, role), ensureValidToken() }
   * @param {any} o.host                   see the host interface above
   * @param {any} [o.analytics]
   * @param {(fn: () => void, ms: number) => any} [o.setTimeout]
   * @param {(t: any) => void} [o.clearTimeout]
   */
  constructor({ netSession, store, relayUrl, auth, host, analytics, setTimeout: st, clearTimeout: ct }) {
    this._ns = netSession;
    this._store = store;
    this._relayUrl = relayUrl;
    this._auth = auth;
    this._host = host;
    this._analytics = analytics || NO_ANALYTICS;
    this._setTimeout = st || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = ct || ((t) => clearTimeout(t));
    /** @type {any[]|null} the partner's room messages heard before the room screen listened */
    this.queue = null;
    /** "sign in, then make the room" (the host step's auth refresh failed) */
    this.pendingCreate = false;
    /** @type {string|null} "sign in, then join this code" */
    this.pendingJoinCode = null;
    this._staleTimer = null;
  }

  /** The live room transport (or null). */
  get net() { return this._ns.net; }

  /** The room code in a `?room=` query (with or without TNDM-), upper-cased; null when there is none. */
  static autoJoinCode(search) {
    const roomParam = new URLSearchParams(search || '').get('room');
    if (!roomParam) return null;
    const code = roomParam.toUpperCase();
    return code.startsWith('TNDM-') ? code : 'TNDM-' + code;
  }

  _live(epoch) { return this._ns.isCurrent(epoch); }

  /** A fresh transport for this room attempt, with the relay and media settings applied. */
  _open(kind) {
    this._host.replaceNet();
    this._host.newRoom(kind);
    const epoch = this._ns.epoch;
    const net = this.net;
    const m = this._host.media();
    net._fallbackUrl = this._relayUrl;
    net.cameraEnabled = m.camera;
    net.audioEnabled = m.audio;
    return epoch;
  }

  // ── create (captain) ──────────────────────────────────────

  async create() {
    const host = this._host;
    const a = this._analytics;
    const epoch = this._open('create');
    host.status('host', 'Creating room...', '');
    host.showCode('----');

    const code = this.net.generateRoomCode();
    a.trackRoomCreate(code);
    a.trackEvent('room_create', { code });

    // Relay auth token if logged in (optional: the relay allows unauthenticated)
    const relayToken = await this._auth.getRelayToken(code, 'captain');
    if (relayToken) this.net._relayToken = relayToken;

    this.net.onRoomJoined = () => {
      if (!this._live(epoch)) return;
      host.roomOpen(code, { rejoin: false });
      host.status('host', 'Waiting for partner...');
      this._store.save(code, 'captain');   // for rejoin after a refresh
    };

    this.net.onConnected = () => {
      if (!this._live(epoch)) return;
      const m = host.media();
      host.status('host', 'Partner connected!', 'connected');
      a.trackEvent('room_connect', { type: this.net.connectionType || 'p2p' });
      a.trackRoomUpdate(code, {
        webrtc_connected: 1,
        connection_type: this.net.connectionType || 'p2p',
        video_enabled: m.camera ? 1 : 0,
        audio_enabled: m.audio ? 1 : 0,
      });
      this._setTimeout(() => {
        if (!this._live(epoch)) return;
        host.partnerConnected('captain');
      }, CONNECT_SETTLE_MS);
    };

    this.net.onDisconnected = (reason) => {
      if (!this._live(epoch)) return;
      host.status('host', reason || 'Disconnected', 'error');
    };

    // Auth error: the relay refused the token — try a silent refresh first. Acts on THIS
    // transport (the one the ride also uses), and only until it is destroyed: across the awaits
    // the live transport can be replaced or nulled (2026-11-06 diag: "Cannot set properties of
    // null (_relayToken)").
    const capNet = this.net;
    capNet.onAuthError = async () => {
      const live = () => this._live(epoch) && !capNet._destroyed;
      if (!live()) return;
      console.warn('LOBBY: Relay auth failed for captain — refreshing token');
      host.status('host', 'Session expired, refreshing...', '');
      const refreshed = await this._auth.ensureValidToken();
      if (!live()) return;
      if (refreshed) {
        const freshToken = await this._auth.getRelayToken(code, 'captain');
        if (!live()) return;
        if (freshToken) capNet._relayToken = freshToken;
        capNet.enterRoom(code, 'captain');
      } else {
        // The relay also takes a connection with no valid token (worker/relay.js), and a refused
        // socket is usually the network: keep dialling (the transport backs off). Only on the
        // host step queue "sign in, then make the room" — mid-ride that would replace the ride's
        // transport once a login lands.
        host.status('host', 'Reconnecting...');
        capNet.enterRoom(code, 'captain');
        if (host.onStep('host')) this.pendingCreate = true;
      }
    };

    this.net.enterRoom(code, 'captain');
    return code;
  }

  // ── join (stoker) ─────────────────────────────────────────

  /** @param {string} code  @param {{viaUrl?: boolean}} [opts] */
  async join(code, { viaUrl = false } = {}) {
    const host = this._host;
    const a = this._analytics;
    const epoch = this._open('join');
    host.status('join', 'Connecting...', '');

    a.trackEvent('room_join', { code, joined_via_url: viaUrl });
    a.trackRoomUpdate(code, {
      stoker_session_id: a.getSessionId(),
      stoker_joined_at: new Date().toISOString(),
      stoker_joined_via_url: viaUrl ? 1 : 0,
    });
    a.trackConversion('stoker_joined', 'room_join');
    if (viaUrl) a.trackConversion('stoker_joined_via_url', 'room_join');

    const relayToken = await this._auth.getRelayToken(code, 'stoker');
    if (relayToken) this.net._relayToken = relayToken;

    this.net.onRoomJoined = () => {
      if (!this._live(epoch)) return;
      host.status('join', 'Waiting for captain...');
      this._store.save(code, 'stoker');
    };

    this.net.onConnected = () => {
      if (!this._live(epoch)) return;
      host.partnerHere('stoker');
      host.status('join', 'Connected!', 'connected');
      a.trackEvent('room_connect', { type: this.net.connectionType || 'p2p' });
      this._setTimeout(() => {
        if (!this._live(epoch)) return;
        host.partnerConnected('stoker');
      }, CONNECT_SETTLE_MS);
    };

    this.net.onDisconnected = (reason) => {
      if (!this._live(epoch)) return;
      host.status('join', reason || 'Could not connect', 'error');
      host.connectFailed('stoker', code);
    };

    // Auth error: the relay refused the token — try a silent refresh first.
    const stoNet = this.net;
    stoNet.onAuthError = async () => {
      const live = () => this._live(epoch) && !stoNet._destroyed;
      if (!live()) return;
      console.warn('LOBBY: Relay auth failed for stoker — refreshing token');
      host.status('join', 'Session expired, refreshing...', '');
      const refreshed = await this._auth.ensureValidToken();
      if (!live()) return;
      if (refreshed) {
        const freshToken = await this._auth.getRelayToken(code, 'stoker');
        if (!live()) return;
        host.status('join', 'Reconnecting...');
        stoNet.retryWithToken(freshToken || stoNet._relayToken);
        if (!freshToken && host.onStep('join')) this.pendingJoinCode = code;
      } else {
        // As the captain's: keep dialling; queue the sign-in rejoin only on the join step.
        host.status('join', 'Reconnecting...');
        stoNet.retryWithToken(stoNet._relayToken);
        if (host.onStep('join')) this.pendingJoinCode = code;
      }
    };

    this.net.enterRoom(code, 'stoker');
  }

  // ── rejoin (a Recent Rooms entry, same seat) ──────────────

  /** @param {{roomCode: string, role: 'captain'|'stoker'}} saved */
  async rejoin(saved) {
    const host = this._host;
    const captain = saved.role === 'captain';
    const seat = captain ? 'host' : 'join';
    const role = captain ? 'captain' : 'stoker';
    const epoch = this._open('rejoin');
    host.status(seat, 'Rejoining room...', '');

    const relayToken = await this._auth.getRelayToken(saved.roomCode, role);
    if (!this._live(epoch)) return;
    if (relayToken) this.net._relayToken = relayToken;

    // Local media early, so it is ready when P2P connects
    const m = host.media();
    await this.net.acquireLocalMedia(m.cameraPermitted, m.audioPermitted);
    if (!this._live(epoch)) return;

    this.net.onRoomJoined = () => {
      if (!this._live(epoch)) return;
      if (captain) host.roomOpen(saved.roomCode, { rejoin: true });
      host.status(seat, captain ? 'Waiting for partner...' : 'Waiting for captain...');
      this._store.save(saved.roomCode, role);
      this._startStaleTimer(seat);
    };

    this.net.onConnected = () => {
      if (!this._live(epoch)) return;
      this._clearStaleTimer();
      host.status(seat, captain ? 'Partner connected!' : 'Connected!', 'connected');
      // Buffer the partner's messages during the settle delay so none are lost
      this.queue = [];
      this.net.onProfileReceived = (profile) => this.queue.push(profile);
      this._setTimeout(() => {
        if (!this._live(epoch)) return;
        host.partnerConnected(role);
      }, CONNECT_SETTLE_MS);
    };

    this.net.onDisconnected = (reason) => {
      if (!this._live(epoch)) return;
      host.status(seat, reason || (captain ? 'Disconnected' : 'Could not connect'), 'error');
    };

    // A refused socket (usually the network): keep dialling; the transport backs off.
    { const rjNet = this.net; rjNet.onAuthError = () => { if (!rjNet._destroyed) rjNet.retryWithToken(rjNet._relayToken); }; }
    this.net.enterRoom(saved.roomCode, role);
  }

  // ── stale rejoin ──────────────────────────────────────────

  _startStaleTimer(seat) {
    this._clearStaleTimer();
    this._staleTimer = this._setTimeout(() => {
      if (this.net && !this.net.connected) this._host.staleRoom(seat);
    }, STALE_ROOM_MS);
  }

  _clearStaleTimer() {
    if (this._staleTimer) {
      this._clearTimeout(this._staleTimer);
      this._staleTimer = null;
    }
  }

  /** The stale prompt's "New Room": forget the room (or every recent room) and leave it. */
  abandonStale() {
    if (this.net && this.net.roomCode) this._store.clear(this.net.roomCode);
    else this._store.clear();
    if (this.net) { this.net.destroy(); this._ns.net = null; }
  }

  // ── leave ─────────────────────────────────────────────────

  /**
   * Leave the room: destroy the transport (it says goodbye to the partner) and drop it.
   * Recent Rooms keep it for a rejoin unless `forget` (local co-op claimed the seat).
   * @param {{forget?: boolean}} [opts]
   */
  leave({ forget = false } = {}) {
    const net = this.net;
    if (!net) return;
    if (forget) { try { if (net.roomCode) this._store.clear(net.roomCode); } catch (e) { /* storage */ } }
    try { net.destroy(); } catch (e) { /* already gone */ }
    this._ns.net = null;
  }

  /**
   * The room screen saw `net` drop for good: destroy it, and leave the room if it is still the
   * live one (not a newer room opened since). Returns true when it was.
   */
  dropIfCurrent(net) {
    try { net.destroy(); } catch (e) { /* already gone */ }
    if (this.net !== net) return false;
    this._ns.net = null;
    return true;
  }

  // ── the partner's room messages ───────────────────────────

  /** Room messages heard before the room screen listened (HOST INSTEAD hands its new room's in). */
  queueProfiles(list) { this.queue = list; }

  /** The buffered room messages, once (then none). */
  takeQueued() {
    const q = this.queue;
    this.queue = null;
    return q && q.length ? q : [];
  }
}
