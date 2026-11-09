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
//   leave({ forget })            leave the room (every callback detached, transport destroyed,
//                                epoch++); forget = drop it from Recent Rooms
//   dropIfCurrent(net)           the room screen saw `net` drop: destroy it; leave if it is still the room
//   newRoom()                    a wait's "New Room" (captain): forget this room, open a fresh one, same seat
//   abandonStale()               forget the room and leave
//   wait                         RoomWait (js/lobby/room-wait.js): the waiting line A–E for this attempt
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
//   wait(seat, view|null)              #694 · the waiting line (who, how long, what you can do); null clears it
//   myName()                           #694 · this player's display name for the relay (optional)
//
// Every attempt captures its epoch and its transport; after each await, and in
// every callback, a superseded attempt (another create/join/rejoin, or a leave)
// does nothing. Tested in test/unit/room-session.test.mjs with fake transports.
// ============================================================

/** The partner connected: the room screen opens this long after (their messages are buffered meanwhile). */
export const CONNECT_SETTLE_MS = 1000;
// #694: the stale-rejoin timer (STALE_ROOM_MS / STALE_WAITING_MS) became RoomWait's views C/D/E,
// which say who, how long, and offer the way out on their own clocks (js/lobby/room-wait.js).
import { RoomWait, ROOM_WAIT_MS } from './room-wait.js';

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
   * @param {(fn: () => void, ms: number) => any} [o.setInterval]
   * @param {(t: any) => void} [o.clearInterval]
   * @param {() => number} [o.now]
   */
  constructor({ netSession, store, relayUrl, auth, host, analytics, setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci, now }) {
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
    this._seenTimer = null;
    this._now = now || (() => Date.now());
    /** #694 · the waiting line for the current attempt (A–E). */
    this.wait = new RoomWait({
      render: (seat, view) => { if (host.wait) host.wait(seat, view); },
      retry: (force) => this._redial(force),
      now: this._now,
      setInterval: si,
      clearInterval: ci,
    });
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
    this._stopSeen();
    this._host.replaceNet();
    this._host.newRoom(kind);
    const epoch = this._ns.epoch;
    const net = this.net;
    const m = this._host.media();
    net._fallbackUrl = this._relayUrl;
    net.cameraEnabled = m.camera;
    // #694: the relay remembers this seat by name (a signed-in player's; none for a guest)
    net._displayName = (this._host.myName && this._host.myName()) || null;
    net.audioEnabled = m.audio;
    return { epoch, net };
  }

  // ── create (captain) ──────────────────────────────────────

  /** @returns {Promise<string|null>} the room code (null when superseded before it dialled) */
  async create() {
    const host = this._host;
    const a = this._analytics;
    const { epoch, net } = this._open('create');
    host.status('host', 'Creating room...', '');
    host.showCode('----');

    const code = net.generateRoomCode();
    this.wait.begin({ seat: 'host', kind: 'create', code, role: 'captain' });
    a.trackRoomCreate(code);
    a.trackEvent('room_create', { code });

    // Relay auth token if logged in (optional: the relay allows unauthenticated)
    const relayToken = await this._auth.getRelayToken(code, 'captain');
    // #346: left, or another attempt began, while the token was on its way: this one is over.
    // (It used to go on and wire its callbacks onto, and enterRoom, the newer room's transport.)
    if (!this._live(epoch)) return null;
    if (relayToken) net._relayToken = relayToken;

    net.onRoomJoined = () => {
      if (!this._live(epoch)) return;
      host.roomOpen(code, { rejoin: false });
      host.status('host', 'Waiting for partner...');
      this._store.save(code, 'captain');   // for rejoin after a refresh
      this.wait.roomOpen();
    };
    net.onRoomWaiting = () => { if (this._live(epoch) && !net.connected) this.wait.partnerAbsent(net.roomInfo || null); };

    net.onConnected = () => {
      if (!this._live(epoch)) return;
      const m = host.media();
      this.wait.end();
      host.status('host', 'Partner connected!', 'connected');
      this._partnerSeen(epoch, net, code);
      a.trackEvent('room_connect', { type: net.connectionType || 'p2p' });
      a.trackRoomUpdate(code, {
        webrtc_connected: 1,
        connection_type: net.connectionType || 'p2p',
        video_enabled: m.camera ? 1 : 0,
        audio_enabled: m.audio ? 1 : 0,
      });
      this._settleThenOpen(epoch, net, 'captain');
    };

    net.onDisconnected = (reason) => {
      if (!this._live(epoch)) return;
      this.wait.end();
      host.status('host', reason || 'Disconnected', 'error');
    };

    // Auth error: the relay refused the token — try a silent refresh first. Acts on THIS
    // transport (the one the ride also uses), and only until it is destroyed: across the awaits
    // the live transport can be replaced or nulled (2026-11-06 diag: "Cannot set properties of
    // null (_relayToken)").
    net.onAuthError = async () => {
      const live = () => this._live(epoch) && !net._destroyed;
      if (!live()) return;
      console.warn('LOBBY: Relay auth failed for captain — refreshing token');
      host.status('host', 'Session expired, refreshing...', '');
      const refreshed = await this._auth.ensureValidToken();
      if (!live()) return;
      if (refreshed) {
        const freshToken = await this._auth.getRelayToken(code, 'captain');
        if (!live()) return;
        if (freshToken) net._relayToken = freshToken;
        net.enterRoom(code, 'captain');
      } else {
        // The relay also takes a connection with no valid token (worker/relay.js), and a refused
        // socket is usually the network: keep dialling (the transport backs off). Only on the
        // host step queue "sign in, then make the room" — mid-ride that would replace the ride's
        // transport once a login lands.
        host.status('host', 'Reconnecting...');
        net.enterRoom(code, 'captain');
        if (host.onStep('host')) this.pendingCreate = true;
      }
    };

    net.enterRoom(code, 'captain');
    return code;
  }

  // ── join (stoker) ─────────────────────────────────────────

  /** @param {string} code  @param {{viaUrl?: boolean}} [opts] */
  async join(code, { viaUrl = false } = {}) {
    const host = this._host;
    const a = this._analytics;
    const { epoch, net } = this._open('join');
    host.status('join', 'Connecting...', '');
    this.wait.begin({ seat: 'join', kind: 'join', code, role: 'stoker' });

    a.trackEvent('room_join', { code, joined_via_url: viaUrl });
    a.trackRoomUpdate(code, {
      stoker_session_id: a.getSessionId(),
      stoker_joined_at: new Date().toISOString(),
      stoker_joined_via_url: viaUrl ? 1 : 0,
    });
    a.trackConversion('stoker_joined', 'room_join');
    if (viaUrl) a.trackConversion('stoker_joined_via_url', 'room_join');

    const relayToken = await this._auth.getRelayToken(code, 'stoker');
    if (!this._live(epoch)) return;   // #346: superseded while the token was on its way (see create)
    if (relayToken) net._relayToken = relayToken;

    net.onRoomJoined = () => {
      if (!this._live(epoch)) return;
      host.status('join', 'Waiting for captain...');
      this._store.save(code, 'stoker');
      this.wait.roomOpen();
    };
    net.onRoomWaiting = () => { if (this._live(epoch) && !net.connected) this.wait.partnerAbsent(net.roomInfo || null); };

    net.onConnected = () => {
      if (!this._live(epoch)) return;
      this.wait.end();
      host.partnerHere('stoker');
      host.status('join', 'Connected!', 'connected');
      this._partnerSeen(epoch, net, code);
      a.trackEvent('room_connect', { type: net.connectionType || 'p2p' });
      this._settleThenOpen(epoch, net, 'stoker');
    };

    net.onDisconnected = (reason) => {
      if (!this._live(epoch)) return;
      this.wait.end();
      host.status('join', reason || 'Could not connect', 'error');
      host.connectFailed('stoker', code);
    };

    // Auth error: the relay refused the token — try a silent refresh first.
    net.onAuthError = async () => {
      const live = () => this._live(epoch) && !net._destroyed;
      if (!live()) return;
      console.warn('LOBBY: Relay auth failed for stoker — refreshing token');
      host.status('join', 'Session expired, refreshing...', '');
      const refreshed = await this._auth.ensureValidToken();
      if (!live()) return;
      if (refreshed) {
        const freshToken = await this._auth.getRelayToken(code, 'stoker');
        if (!live()) return;
        host.status('join', 'Reconnecting...');
        net.retryWithToken(freshToken || net._relayToken);
        if (!freshToken && host.onStep('join')) this.pendingJoinCode = code;
      } else {
        // As the captain's: keep dialling; queue the sign-in rejoin only on the join step.
        host.status('join', 'Reconnecting...');
        net.retryWithToken(net._relayToken);
        if (host.onStep('join')) this.pendingJoinCode = code;
      }
    };

    net.enterRoom(code, 'stoker');
  }

  // ── rejoin (a Recent Rooms entry, same seat) ──────────────

  /** @param {{roomCode: string, role: 'captain'|'stoker'}} saved */
  async rejoin(saved) {
    const host = this._host;
    const captain = saved.role === 'captain';
    const seat = captain ? 'host' : 'join';
    const role = captain ? 'captain' : 'stoker';
    const { epoch, net } = this._open('rejoin');
    host.status(seat, 'Rejoining room...', '');
    // #694: who was here and when (stored with the recent room) picks C ("was here 3 min ago")
    // or D ("hasn't been in room ABCD for 2 h"); a relay that never opens shows E. The clock
    // starts with the attempt, so "Rejoining room..." never stays up for good (#346).
    const known = (this._store.getRecent() || []).find((r) => r.roomCode === saved.roomCode) || saved;
    this.wait.begin({ seat, kind: 'rejoin', code: saved.roomCode, role,
      partner: { name: known.partnerName || null,
        // an entry from before #694 has a name but no time: it was saved while they were here
        seenAt: known.partnerSeenAt || (known.partnerName && known.timestamp) || null } });

    const relayToken = await this._auth.getRelayToken(saved.roomCode, role);
    if (!this._live(epoch)) return;
    if (relayToken) net._relayToken = relayToken;

    // Local media early, so it is ready when P2P connects
    const m = host.media();
    await net.acquireLocalMedia(m.cameraPermitted, m.audioPermitted);
    if (!this._live(epoch)) return;

    net.onRoomJoined = () => {
      if (!this._live(epoch)) return;
      if (captain) host.roomOpen(saved.roomCode, { rejoin: true });
      host.status(seat, captain ? 'Waiting for partner...' : 'Waiting for captain...');
      this._store.save(saved.roomCode, role);
      this.wait.roomOpen();
    };

    // #346 · the relay says the room is open but the partner is not in it.
    net.onRoomWaiting = () => {
      if (!this._live(epoch) || net.connected) return;
      this.wait.partnerAbsent(net.roomInfo || null);
    };

    net.onConnected = () => {
      if (!this._live(epoch)) return;
      this.wait.end();
      host.status(seat, captain ? 'Partner connected!' : 'Connected!', 'connected');
      this._partnerSeen(epoch, net, saved.roomCode);
      this._settleThenOpen(epoch, net, role);
    };

    net.onDisconnected = (reason) => {
      if (!this._live(epoch)) return;
      this.wait.end();
      host.status(seat, reason || (captain ? 'Disconnected' : 'Could not connect'), 'error');
    };

    // A refused socket (usually the network): keep dialling; the transport backs off.
    net.onAuthError = () => { if (!net._destroyed) net.retryWithToken(net._relayToken); };
    net.enterRoom(saved.roomCode, role);
  }

  /**
   * The partner connected: hold their room messages and open the room screen (which replays
   * them) CONNECT_SETTLE_MS later. #346: create and join buffer too now; it was rejoin only, and
   * a create/join dropped whatever the partner sent in that second (camera state, bike, a
   * "dressing" tag).
   */
  _settleThenOpen(epoch, net, role) {
    const q = this.queue = [];
    net.onProfileReceived = (profile) => q.push(profile);
    this._setTimeout(() => {
      if (!this._live(epoch)) return;
      this._host.partnerConnected(role);
    }, CONNECT_SETTLE_MS);
  }

  // ── partner last seen (#694) ──────────────────────────────

  /**
   * The partner is here: remember when, with the recent room (C vs D on a later rejoin), and
   * keep it fresh every ROOM_WAIT_MS.seenEvery while they stay (a refresh mid-ride still knows).
   */
  _partnerSeen(epoch, net, code) {
    this._markSeen(code);
    this._stopSeen();
    const again = () => {
      this._seenTimer = this._setTimeout(() => {
        this._seenTimer = null;
        if (!this._live(epoch) || !net.connected) return;
        this._markSeen(code);
        again();
      }, ROOM_WAIT_MS.seenEvery);
    };
    again();
  }

  _markSeen(code) {
    try { if (code && this._store.markSeen) this._store.markSeen(code); } catch (e) { /* storage */ }
  }

  _stopSeen() {
    if (this._seenTimer) { this._clearTimeout(this._seenTimer); this._seenTimer = null; }
  }

  /**
   * E · dial the room server again. `force` = the Retry button. The automatic retry leaves a
   * socket that is still opening alone (on a slow link the handshake can take longer than the
   * 5 s retry period, and re-dialling would cut it off every time); the transport's own backoff
   * covers sockets that fail.
   */
  _redial(force = false) {
    const n = this.net;
    if (!n || n._destroyed || !n.roomCode || n.connected) return;
    const ws = n._relayWs;
    if (!force && ws && ws.readyState === 0) return;   // WebSocket.CONNECTING
    n.retryWithToken(n._relayToken);
  }

  /**
   * A wait's "New Room" (#694; Pete: it must REALLY make a fresh room, keeping your seat): forget
   * this room and open a new one as its captain. Only the captain has a room to make; a
   * stoker's way out is another code.
   */
  newRoom() {
    if (this.net && this.net.roomCode) this._store.clear(this.net.roomCode);
    return this.create();
  }

  /** Forget the room (or every recent room) and leave it. */
  abandonStale() {
    if (this.net && this.net.roomCode) this._store.clear(this.net.roomCode);
    else this._store.clear();
    this.leave();
  }

  // ── leave ─────────────────────────────────────────────────

  /**
   * Leave the room: destroy the transport (it says goodbye to the partner) and drop it.
   * Recent Rooms keep it for a rejoin unless `forget` (local co-op claimed the seat).
   * #346: every callback is detached (the ride's too) and the epoch bumped, so nothing from this
   * room's attempt (a token on its way, "open the room screen" in a second) runs after Back.
   * @param {{forget?: boolean}} [opts]
   */
  leave({ forget = false } = {}) {
    this.wait.end();
    this._stopSeen();
    const net = this.net;
    if (!net) return;
    if (net.connected && !forget) this._markSeen(net.roomCode);   // #694: they were here until now
    if (forget) { try { if (net.roomCode) this._store.clear(net.roomCode); } catch (e) { /* storage */ } }
    this._ns.clear();
  }

  /**
   * The room screen saw `net` drop for good: destroy it, and leave the room if it is still the
   * live one (not a newer room opened since). Returns true when it was.
   */
  dropIfCurrent(net) {
    if (net && net.roomCode) this._markSeen(net.roomCode);   // #694: they were here until the drop
    if (this.net !== net) {
      try { net.destroy(); } catch (e) { /* already gone */ }
      return false;
    }
    this.leave();
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
