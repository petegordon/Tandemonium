// ============================================================
// RoomTransport — a two-seat room over a relay
// ============================================================
//
// @usersfirst/rooms (lab #137). Lifted from Tandemonium's js/net/room-transport.js
// (Tandemonium #318, #346), where it had already been separated from the game:
// it owns room join-by-code on the relay, reconnect/backoff and the HEARTBEAT
// keepalive. Two optional layers sit on top, each a mixin in its own file that
// only a game that wants it loads (lab #137):
//   p2p.js    withP2P(RoomTransport): the PeerJS P2P upgrade, its unordered
//             fast lane, and the automatic fall back to the relay
//   media.js  withMedia(withP2P(RoomTransport)): camera and microphone calls
// It sends/receives OPAQUE bytes — `send(bytes)` out, `onMessage(bytes)`
// in — and knows nothing about the game. A game extends or wraps it and adds
// its own codec + protocol. HEARTBEAT is the transport's own keepalive (the one
// reserved message type it understands; its number is the game's to choose).
//
// Everything that belongs to a game or a deployment is a constructor option
// (see RoomTransportOptions): the relay's and PeerJS server's addresses, the
// heartbeat's message type, the room-code prefix, the device id, whether
// camera/mic are allowed, and where a partner's audio plays.
//
// The two seats are named 'captain' and 'stoker' on the wire (the relay and
// the PeerJS ids use those words); 'stoker' is the side that dials.
//
// No imports: plain ESM that runs in a browser as is, and under node:test with
// a fake WebSocket.
// ============================================================

/**
 * @typedef {object} RoomTransportOptions
 * @property {number} [heartbeatType]        first byte of the transport's own keepalive frames (default 0x04)
 * @property {string} [turnCredentialsUrl]   the relay's TURN-credentials address; without it the P2P upgrade uses STUN only
 * @property {{host: string, port: number, path: string, secure: boolean}} [peerjs]  the PeerJS signalling server
 * @property {() => (string|null|undefined)} [deviceId]  this device's id, sent to the relay so a reload gets its seat back
 * @property {boolean} [mediaEnabled]        camera/mic calls allowed (default false)
 * @property {string} [codePrefix]           what generateRoomCode() puts before the 4 letters (default '')
 * @property {string} [fastChannelLabel]     label of the unordered data channel (default 'rooms-fast')
 * @property {() => (HTMLMediaElement|null|undefined)} [audioElement]  where the partner's voice plays
 * @property {(roomCode: string|null) => void} [onKeepalive]  called every 5 minutes while the relay socket is held
 */

/** 2026-11-17 · the relay closes a connection with this reason when both seats are taken. */
const ROOM_FULL_REASON = 'room-full';

/** The relay replaced our socket: re-dial once after this long… */
const REPLACED_REDIAL_MS = 3000;
/** …and a second replace within this window means the seat is taken. */
const REPLACED_REDIAL_WINDOW_MS = 30000;

export class RoomTransport {
  /** @param {RoomTransportOptions} [options] */
  constructor(options = {}) {
    /** @type {RoomTransportOptions} */
    this.options = options;
    this._hb = options.heartbeatType ?? 0x04;
    this.role = null; // 'captain' | 'stoker'
    this.roomCode = null;
    this.connected = false;
    this.transport = 'none'; // 'p2p' | 'relay' | 'none'
    this.lastPingTime = 0;
    this.pingMs = 0;
    // Opaque inbound payload callback — set by the game adapter. Receives every
    // non-keepalive frame as raw bytes; the transport never interprets them.
    this.onMessage = null;
    this.onConnected = null;
    this.onDisconnected = null;
    this.onReconnecting = null;
    this.onRoomJoined = null; // fires when relay WebSocket opens (room entered, waiting for partner)
    this.onRoomWaiting = null; // #346: the relay says the room is open and the partner is NOT in it
    this.partnerAbsent = false; // #346: last relay word was "waiting" (cleared by partner-ready)
    this.roomInfo = null; // #694: what the relay remembers about the room (on "waiting"), or null
    this.partnerName = null; // #694: the name the partner gave the relay (on "partner-ready"), or null
    this.onAuthError = null; // fires when relay rejects connection (401/403 auth failure)
    this._heartbeatInterval = null;
    this._reconnectAttempts = 0;
    this._fastReconnectAttempts = 5;   // phase 1: exponential backoff (1s,2s,4s,8s,16s)
    this._maxReconnectAttempts = 25;   // phase 2: 20 more at fixed 16s intervals
    this._relayWs = null;
    this._fallbackUrl = null;
    this._relayToken = null;
    this._relayPartnerReady = false;
    this._reconnectTimeout = null;
    this._enterRoomCallback = null;
    this._relayReconnectAttempts = 0;
    this._relayKeepaliveInterval = null;
    this._relayDidOpen = false; // tracks if relay WS ever opened (false = auth rejection)

    // Tab/network resume → force a fresh reconnect when the partner could
    // have silently dropped while we were backgrounded or offline. Stored so
    // destroy() can detach.
    this._onVisibilityChange = () => {
      if (document.visibilityState === 'visible') this._maybeRecoverFromIdle('visible');
    };
    this._onOnline = () => this._maybeRecoverFromIdle('online');
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this._onOnline);
    }
  }

  /** '&device=<id>' for the relay, or '' when the game gave no device id (or reading it failed). */
  _deviceParam() {
    try { const d = this.options.deviceId ? this.options.deviceId() : null; return d ? '&device=' + encodeURIComponent(d) : ''; } catch (e) { return ''; }
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = this.options.codePrefix || '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  async enterRoom(roomCode, role, callback) {
    this.role = role;
    this.roomCode = roomCode;

    // Fetch relay auth token (non-blocking, stored for relay connection)
    // Token is expected to be set by caller before or after this call

    // Connect to relay immediately
    this._connectRelay();

    // Store the callback for status updates
    this._enterRoomCallback = callback;
  }

  _handleMessage(data) {
    if (this._destroyed) return;
    let bytes;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else {
      try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        if (parsed.type === 'relay') {
          bytes = new Uint8Array(parsed.data);
        } else if (parsed.type === 'partner-ready') {
          // Relay: partner has connected — now safe to start heartbeat
          this._relayPartnerReady = true;
          this.partnerAbsent = false;
          // #694: a relay from this change on names the partner (an older one doesn't).
          if (typeof parsed.name === 'string' && parsed.name) this.partnerName = parsed.name.slice(0, 32);
          // 2026-11-17: the room's proof of who rode (for the score post), its P2P key, and a
          // guest partner's key (their pair record is found by it, never by their device id).
          if (typeof parsed.pair === 'string') this.pairProof = parsed.pair;
          if (typeof parsed.p2p === 'string') this.p2pKey = parsed.p2p;
          this.partnerGuestKey = typeof parsed.partnerGuest === 'string' ? parsed.partnerGuest : null;
          if (this.transport === 'relay' && !this._heartbeatInterval) {
            this._startHeartbeat();
          }
          if (!this.connected) {
            this.connected = true;
            if (this.onConnected) this.onConnected();
          }
          // Attempt P2P upgrade now that both peers are on relay
          this._attemptP2PUpgrade();
          return;
        } else if (parsed.type === 'waiting') {
          // Relay confirms room is valid, waiting for partner (#346: say so — a rejoin into a
          // room whose partner is gone offers "New Room" sooner)
          this.partnerAbsent = true;
          // #694: a relay from #694 on also says what the room remembers (an older one doesn't:
          // roomInfo stays null and the client falls back to its own history).
          this.roomInfo = 'fresh' in parsed ? {
            fresh: !!parsed.fresh,
            lastUsedAt: Number(parsed.lastUsedAt) || null,
            partnerSeenAt: Number(parsed.partnerSeenAt) || null,
            partnerName: typeof parsed.partnerName === 'string' ? parsed.partnerName.slice(0, 32) : null,
          } : null;
          if (this.onRoomWaiting) this.onRoomWaiting(this.roomInfo);
          return;
        } else if (parsed.type === 'disconnect') {
          // Relay: partner disconnected — immediate notification
          this._handleDisconnect();
          return;
        } else return;
      } catch (e) { return; }
    }

    if (bytes.length === 0) return;

    // HEARTBEAT is the transport's own keepalive (connection health + reconnect
    // reset + ping echo) — handle it here and don't surface it as game data.
    if (bytes[0] === this._hb) {
      this._lastRemoteHeartbeat = performance.now();
      // Verified data exchange — safe to reset reconnect counter
      this._reconnectAttempts = 0;
      if (bytes.length >= 2 && bytes[1] === 0x01) {
        this.pingMs = performance.now() - this.lastPingTime;
      } else {
        this._send(new Uint8Array([this._hb, 0x01]));
      }
      return;
    }

    // Everything else is opaque payload — hand it to the game adapter.
    if (this.onMessage) this.onMessage(bytes);
  }

  // If we've been silent (tab hidden / network offline) the partner's
  // WebSocket may have been killed by a carrier/proxy or NAT. When the tab
  // resumes or we come back online, force a reconnect cycle if the last
  // heartbeat is stale — `_relayWs.readyState` can lie OPEN locally even
  // after the server-side socket is gone.
  _maybeRecoverFromIdle(reason) {
    if (!this.roomCode) return; // not in a room
    const since = this._lastRemoteHeartbeat
      ? performance.now() - this._lastRemoteHeartbeat
      : Infinity;
    if (since < 3000 && this.connected) return; // healthy
    console.log('NET: idle recovery (' + reason + '), heartbeat age=' + Math.round(since) + 'ms');
    try { this.retryConnection(); } catch (e) { console.warn('NET: retry on resume failed:', e); }
  }

  // Latest-wins traffic. The relay has one lane, so this is _send; the P2P layer
  // overrides it with its unordered fast channel.
  _sendFast(data) {
    this._send(data);
  }

  _send(data) {
    if (this._relayWs && this._relayWs.readyState === WebSocket.OPEN) {
      try { this._relayWs.send(data); } catch (e) { console.warn('NET: Relay send failed:', e); }
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._lastRemoteHeartbeat = performance.now();
    this._heartbeatInterval = setInterval(() => {
      this.lastPingTime = performance.now();
      this._send(new Uint8Array([this._hb, 0x00]));
      if (performance.now() - this._lastRemoteHeartbeat > 8000) {
        this._handleDisconnect();
      }
    }, 1000);
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  _startRelayKeepalive() {
    this._stopRelayKeepalive();
    this._relayKeepaliveInterval = setInterval(() => {
      if (this._relayWs && this._relayWs.readyState === WebSocket.OPEN) {
        // Send a ping to keep the Durable Object alive
        try { this._relayWs.send(new Uint8Array([this._hb, 0x02])); } catch (e) {}
      }
      // The game's own 5-minute chore (Tandemonium refreshes its stored room's timestamp)
      if (this.options.onKeepalive) { try { this.options.onKeepalive(this.roomCode); } catch (e) {} }
    }, 5 * 60 * 1000); // every 5 minutes
  }

  _stopRelayKeepalive() {
    if (this._relayKeepaliveInterval) {
      clearInterval(this._relayKeepaliveInterval);
      this._relayKeepaliveInterval = null;
    }
  }

  _handleDisconnect() {
    clearTimeout(this._reconnectTimeout);
    if (this._destroyed) return;
    this.connected = false;
    this._stopHeartbeat();
    // Another connection holds this room seat (see the 'replaced' close): re-dialling would take
    // it back and start a tug of war. Only an explicit retry (retryConnection) dials again.
    if (this._evicted) return;

    if (this._reconnectAttempts < this._maxReconnectAttempts) {
      this._reconnectAttempts++;
      if (this.onReconnecting) this.onReconnecting(this._reconnectAttempts, this._maxReconnectAttempts);
      const delay = this._reconnectAttempts <= this._fastReconnectAttempts
        ? Math.pow(2, this._reconnectAttempts - 1) * 1000
        : 16000;
      clearTimeout(this._reconnectDelayTimer);
      this._reconnectDelayTimer = setTimeout(() => {
        if (!this.connected && !this._destroyed) this._attemptReconnect();
      }, delay);
    } else {
      this._gaveUp = true;   // no reconnect pending any more: only retryConnection dials again
      if (this.onDisconnected) this.onDisconnected('Connection lost');
    }
  }

  // Public: reset retry counter and start a fresh reconnection cycle
  retryConnection() {
    if (this._destroyed) return;
    this._evicted = false;
    this._gaveUp = false;
    this._lastReplacedAt = 0;
    this._reconnectAttempts = 0;
    this._ensureBrokerConnection();
    this._handleDisconnect();
  }

  _attemptReconnect() {
    if (this._destroyed || this._evicted) return;
    if (this.onReconnecting) this.onReconnecting(this._reconnectAttempts, this._maxReconnectAttempts);

    // Close stale connections
    this._closeDirect();
    this._dropRelaySocket();

    // Reconnect via relay first (primary transport)
    if (this._fallbackUrl) {
      this._relayReconnectAttempts = 0;
      this._connectRelay();
      // Timeout: if relay doesn't reconnect within 5s, try next attempt
      this._reconnectTimeout = setTimeout(() => {
        if (!this.connected) this._handleDisconnect();
      }, 5000);
    } else {
      // No relay address: only a direct (P2P) layer can reconnect.
      this._reconnectWithoutRelay();
    }
  }

  /**
   * Close the relay socket we hold, with its handlers detached first so its close
   * cannot start a reconnect. The relay keeps ONE socket per room + role and
   * closes the older one ("replaced") when another arrives; a socket this
   * transport had already given up on, still acting on its close, re-dialled
   * and replaced the live one, whose close re-dialled in turn: an endless
   * replace loop that dropped the online ride (TV playtest 2026-11-06).
   */
  _dropRelaySocket() {
    const ws = this._relayWs;
    this._relayWs = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch (e) { /* already closed */ }
  }

  _connectRelay() {
    // Evicted: another connection holds this seat; only retryConnection (Try again) dials again.
    if (!this._fallbackUrl || this._destroyed || this._evicted) return;
    this._dropRelaySocket();
    this._relayPartnerReady = false;
    this._relayDidOpen = false;
    let url = this._fallbackUrl + '?room=' + this.roomCode + '&role=' + this.role;
    // The seat is this device's while it holds it (and for a while after it leaves): a reload or
    // re-dial gets it back; anyone else is told the room is full (worker/relay.js).
    url += this._deviceParam();
    if (this._relayToken) url += '&token=' + encodeURIComponent(this._relayToken);
    // #694: the name the room remembers this seat by ("Pete was here 3 min ago" on the partner's side)
    if (this._displayName) url += '&name=' + encodeURIComponent(String(this._displayName).slice(0, 32));
    const ws = new WebSocket(url);
    this._relayWs = ws;
    // Every handler below acts only while `ws` is still this transport's socket.
    const current = () => this._relayWs === ws && !this._destroyed;

    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (!current()) return;
      this._relayDidOpen = true;
      this._relayReconnectAttempts = 0;
      this._relayAuthFailures = 0;
      clearTimeout(this._authRetryTimer);
      this.transport = 'relay';

      // Room joined — notify caller
      if (this.onRoomJoined) this.onRoomJoined();
      if (this._enterRoomCallback) {
        this._enterRoomCallback({ status: 'waiting' });
        this._enterRoomCallback = null;
      }
    };
    ws.onmessage = (e) => {
      if (!current()) return;
      this._handleMessage(e.data);
    };
    ws.onerror = (err) => {
      if (!current()) return;
      console.warn('NET: Relay WebSocket error:', err);
    };
    ws.onclose = (ev) => {
      if (!current()) return;
      this._relayWs = null;
      // Both seats belong to other riders: stop, and say so. Re-dialling can't help.
      if (ev && ev.reason === ROOM_FULL_REASON) {
        console.warn('NET: Relay says the room is full');
        this._evicted = true;
        this.roomFull = true;
        clearTimeout(this._reconnectTimeout);
        clearTimeout(this._authRetryTimer);
        clearTimeout(this._relayRetryTimer);
        if (this.connected) { this.connected = false; this._stopHeartbeat(); }
        if (this.onDisconnected) this.onDisconnected('That room is full. Check the code with your partner, or make a new room.');
        return;
      }
      // The relay replaced this socket with a newer one for the same room + role:
      // another connection holds the seat now. Re-dialling would replace it back.
      if (ev && ev.reason === 'replaced') {
        // Our own re-dials never get here (the old socket's handlers are detached first), so
        // another connection took this seat: usually a dial of ours that raced this socket to
        // the relay, sometimes the same room opened elsewhere. Take the seat back once, a moment
        // later; replaced again soon after means it is really taken — stop and say so rather
        // than tug the seat back and forth.
        const now = Date.now();
        if (now - (this._lastReplacedAt || 0) > REPLACED_REDIAL_WINDOW_MS) {
          this._lastReplacedAt = now;
          console.warn('NET: Relay socket replaced by another connection — re-dialling once');
          clearTimeout(this._replacedRedialTimer);
          this._replacedRedialTimer = setTimeout(() => { if (!this._destroyed && !this._relayWs && !this._evicted) this._connectRelay(); }, REPLACED_REDIAL_MS);
          return;
        }
        console.warn('NET: Relay seat taken by another connection again — giving it up');
        this._evicted = true;
        clearTimeout(this._reconnectTimeout);
        clearTimeout(this._authRetryTimer);
        clearTimeout(this._relayRetryTimer);
        // Let go of the P2P side too: its peer id belongs to whoever holds the seat now.
        this._releaseDirect();
        if (this.connected) { this.connected = false; this._stopHeartbeat(); }
        if (this.onDisconnected) this.onDisconnected('This room was opened somewhere else');
        return;
      }
      // If P2P is active, silently ignore relay failures (it's just a hot standby)
      if (this.transport === 'p2p' && this.connected) {
        if (this._relayDidOpen) {
          this._reconnectRelayBackground();
        }
        // Don't fire auth errors or disconnect while P2P is working
        return;
      }

      // If WebSocket never opened, the relay rejected the connection (401/403)
      if (!this._relayDidOpen) {
        console.warn('NET: Relay rejected connection (likely auth error — missing or invalid token)');
        // Fire auth error callback instead of futile reconnect loop. Backed off
        // (1 s, 2 s, 4 s … 15 s): the handler re-dials at once, and a relay that
        // keeps refusing was being hit several times a second.
        if (this.onAuthError) {
          const n = this._relayAuthFailures = (this._relayAuthFailures || 0) + 1;
          const wait = n <= 1 ? 0 : Math.min(15000, 1000 * Math.pow(2, n - 2));
          clearTimeout(this._authRetryTimer);
          this._authRetryTimer = setTimeout(() => { if (!this._destroyed && !this._relayWs && this.onAuthError) this.onAuthError(); }, wait);
        } else {
          // No auth error handler — surface as disconnect with clear message
          if (this.onDisconnected) this.onDisconnected('Authentication failed');
        }
        return;
      }
      if (this.transport === 'relay' || this.transport === 'none') {
        // The relay was carrying a live connection and its socket closed (a
        // server or network drop): we are no longer connected. Without this
        // the redial below was skipped (it checks !this.connected) and the
        // drop waited for the 8 s heartbeat timeout, while the partner,
        // told by the relay, paused (#472).
        if (this.connected) {
          this.connected = false;
          this._stopHeartbeat();
        }
        // Try relay reconnection with backoff before falling back to disconnect
        if (this._relayReconnectAttempts < 3) {
          this._relayReconnectAttempts++;
          const delay = Math.pow(2, this._relayReconnectAttempts - 1) * 1000; // 1s, 2s, 4s
          console.warn('NET: Relay closed, retrying in ' + delay + 'ms (attempt ' + this._relayReconnectAttempts + '/3)');
          clearTimeout(this._relayRetryTimer);
          this._relayRetryTimer = setTimeout(() => {
            // Only when nothing else has dialled meanwhile (a retry, an auth refresh).
            if (!this.connected && !this._relayWs && !this._destroyed && !this._evicted) {
              this._connectRelay();
            }
          }, delay);
        } else {
          this._relayReconnectAttempts = 0;
          this._handleDisconnect();
        }
      }
    };
  }

  // Retry relay connection with a fresh token
  retryWithToken(token) {
    this._relayToken = token;
    this._relayReconnectAttempts = 0;
    this._connectRelay();
  }

  _reconnectRelayBackground() {
    // Silently reconnect relay as hot standby while P2P is active
    setTimeout(() => {
      if (this.connected && this.transport === 'p2p' && !this._relayWs && !this._destroyed) {
        this._relayReconnectAttempts = 0;
        this._connectRelay();
      }
    }, 2000);
  }

  // ── What a direct (P2P) layer adds. The relay alone does nothing here. ──

  /** Both seats are on the relay: a direct layer may now try its upgrade. */
  _attemptP2PUpgrade() {}
  /** A retry is starting: a direct layer re-registers with its signalling server. */
  _ensureBrokerConnection() {}
  /** A reconnect is starting: a direct layer closes its stale connection. */
  _closeDirect() {}
  /** The seat went to another connection: a direct layer lets go of its peer. */
  _releaseDirect() {}
  /** A reconnect with no relay address: only a direct layer can do it. */
  _reconnectWithoutRelay() {}

  destroy() {
    this._destroyed = true;   // pending relay retries and late socket events stop here
    clearTimeout(this._authRetryTimer);
    clearTimeout(this._reconnectDelayTimer);
    clearTimeout(this._replacedRedialTimer);
    clearTimeout(this._relayRetryTimer);
    this._stopHeartbeat();
    clearTimeout(this._reconnectTimeout);
    this._stopRelayKeepalive();
    // Detach resume listeners
    if (typeof document !== 'undefined' && this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    if (typeof window !== 'undefined' && this._onOnline) {
      window.removeEventListener('online', this._onOnline);
    }
    this._dropRelaySocket();
    this.connected = false;
  }
}
