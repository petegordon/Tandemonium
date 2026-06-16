// ============================================================
// NETWORK MANAGER — PeerJS P2P + Cloudflare Worker relay
// ============================================================

import {
  MSG_HEARTBEAT,
  TURN_CREDENTIALS_URL, PEERJS_HOST, PEERJS_PORT, PEERJS_PATH, PEERJS_SECURE
} from './config.js';
import { BikeCodec } from './net/bike-codec.js';

const PEERJS_CONFIG = {
  host: PEERJS_HOST,
  port: PEERJS_PORT,
  path: PEERJS_PATH,
  secure: PEERJS_SECURE,
};

export class NetworkManager {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.role = null; // 'captain' | 'stoker'
    this.roomCode = null;
    this.connected = false;
    this.transport = 'none'; // 'p2p' | 'relay' | 'none'
    this.lastPingTime = 0;
    this.pingMs = 0;
    this.onPedalReceived = null;
    this.onStateReceived = null;
    this.onEventReceived = null;
    this.onLeanReceived = null;
    this.onConnected = null;
    this.onDisconnected = null;
    this.onReconnecting = null;
    this.onRemoteStream = null;
    this.onProfileReceived = null;
    this.onRoomJoined = null; // fires when relay WebSocket opens (room entered, waiting for partner)
    this.onP2PUpgrade = null; // fires when P2P transport is established (for media calls)
    this.onAuthError = null; // fires when relay rejects connection (401/403 auth failure)
    this.cameraEnabled = true; // set false to suppress local camera in calls
    this.audioEnabled = false; // set true to include microphone in calls
    this._mediaCall = null;
    this._localMediaStream = null;
    this._heartbeatInterval = null;
    this._reconnectAttempts = 0;
    this._fastReconnectAttempts = 5;   // phase 1: exponential backoff (1s,2s,4s,8s,16s)
    this._maxReconnectAttempts = 25;   // phase 2: 20 more at fixed 16s intervals
    this._relayWs = null;
    this._fallbackUrl = null;
    this._relayToken = null;
    this._relayPartnerReady = false;
    this._reconnectTimeout = null;
    this._activeConn = null; // tracks which conn is current to ignore stale close events
    this._iceServers = null; // cached TURN + STUN servers
    this._enterRoomCallback = null;
    this._relayReconnectAttempts = 0;
    this._relayKeepaliveInterval = null;
    this._relayDidOpen = false; // tracks if relay WS ever opened (false = auth rejection)
    this._p2pUpgradeTimeout = null;
    this._p2pUpgradeRetryTimeout = null;

    // WebRTC quality stats
    this._statsInterval = null;
    this._statsSamples = []; // { rtt, packetsLost, packetsSent, bytesReceived, bytesSent, timestamp }

    // Game-specific message codec (bike state/lean/pedal/event/profile). The
    // transport below sends/receives opaque bytes; the codec owns the schema,
    // the pre-allocated 60Hz send buffers, AND the inbound dispatch. (#318 Step 2)
    this._codec = new BikeCodec();
    // Inbound routing table handed to the codec — maps decoded game messages
    // back to this adapter's public callbacks. Built once; reads the (possibly
    // reassigned) on*Received fields at call time. Role-flip for pedal lives
    // here (session state), not in the codec.
    this._msgHandlers = {
      onState:   (s) => { if (this.onStateReceived) this.onStateReceived(s); },
      onPedal:   (foot) => { if (this.onPedalReceived) this.onPedalReceived(this.role === 'captain' ? 'stoker' : 'captain', foot); },
      onEvent:   (b) => { if (this.onEventReceived) this.onEventReceived(b); },
      onLean:    (v) => { if (this.onLeanReceived) this.onLeanReceived(v); },
      onProfile: (p) => { if (this.onProfileReceived) this.onProfileReceived(p); },
    };

    // Pending retries for sendEventReliable (eventByte → setTimeout id list)
    this._reliableEventTimers = [];

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

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'TNDM-';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  _defaultIceServers() {
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
  }

  async _fetchIceServers() {
    if (this._iceServers) return this._iceServers;
    try {
      const resp = await fetch(TURN_CREDENTIALS_URL);
      const data = await resp.json();
      if (data.iceServers && data.iceServers.urls) {
        // CF returns { iceServers: { urls: [...], username, credential } }
        // PeerJS expects an array of server objects
        this._iceServers = [
          ...this._defaultIceServers(),
          data.iceServers
        ];
      } else if (Array.isArray(data.iceServers)) {
        this._iceServers = [...this._defaultIceServers(), ...data.iceServers];
      } else {
        this._iceServers = this._defaultIceServers();
      }
    } catch (e) {
      console.warn('NET: Failed to fetch TURN credentials, using STUN only', e);
      this._iceServers = this._defaultIceServers();
    }
    return this._iceServers;
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

  _setupConnection() {
    const conn = this.conn;
    this._activeConn = conn;

    conn.on('open', () => {
      clearTimeout(this._reconnectTimeout);
      this.connected = true;
      this.transport = 'p2p';
      // Don't reset _reconnectAttempts here — a flaky connection that
      // opens briefly then closes would reset the counter and loop forever.
      // Instead, reset in the heartbeat ACK handler after a verified round-trip.

      this._startHeartbeat();
      if (this.onConnected) this.onConnected();
    });

    conn.on('data', (data) => {
      this._handleMessage(data);
    });

    conn.on('close', () => {
      // Ignore close events from stale connections
      if (conn !== this._activeConn) return;
      this._handleDisconnect();
    });

    conn.on('error', (err) => {
      console.warn('NET: Connection error:', err);
    });
  }

  _handleMessage(data) {
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
          // Relay confirms room is valid, waiting for partner
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
    if (bytes[0] === MSG_HEARTBEAT) {
      this._lastRemoteHeartbeat = performance.now();
      // Verified data exchange — safe to reset reconnect counter
      this._reconnectAttempts = 0;
      if (bytes.length >= 2 && bytes[1] === 0x01) {
        this.pingMs = performance.now() - this.lastPingTime;
      } else {
        this._send(new Uint8Array([MSG_HEARTBEAT, 0x01]));
      }
      return;
    }

    // Everything else is opaque game payload — the codec owns what it means.
    this._codec.dispatch(bytes, this._msgHandlers);
  }

  sendPedal(foot) {
    this._send(this._codec.encodePedal(foot));
  }

  sendLean(leanValue) {
    this._send(this._codec.encodeLean(leanValue));
  }

  sendState(bike, timerRemaining) {
    this._send(this._codec.encodeState(bike, timerRemaining));
  }

  sendEvent(eventType) {
    this._send(this._codec.encodeEvent(eventType));
  }

  // Send a one-shot terminal event (FINISH, GAMEOVER) with retries so a
  // single dropped packet at the relay/WebRTC boundary doesn't strand the
  // partner waiting forever. Receiver-side handlers must be idempotent
  // (state-guarded) — they already are for FINISH and GAMEOVER.
  sendEventReliable(eventType, attempts = 3, intervalMs = 200) {
    const msg = this._codec.encodeEvent(eventType);
    this._send(msg);
    for (let i = 1; i < attempts; i++) {
      const t = setTimeout(() => {
        this._send(msg);
        // Drop the timer id from the list once it fires
        const idx = this._reliableEventTimers.indexOf(t);
        if (idx >= 0) this._reliableEventTimers.splice(idx, 1);
      }, intervalMs * i);
      this._reliableEventTimers.push(t);
    }
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

  sendProfile(data) {
    this._send(this._codec.encodeProfile(data));
  }

  _send(data) {
    if (this.transport === 'p2p' && this.conn && this.conn.open) {
      try { this.conn.send(data); } catch (e) { console.warn('NET: P2P send failed:', e); }
    } else if (this._relayWs && this._relayWs.readyState === WebSocket.OPEN) {
      try { this._relayWs.send(data); } catch (e) { console.warn('NET: Relay send failed:', e); }
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._lastRemoteHeartbeat = performance.now();
    this._heartbeatInterval = setInterval(() => {
      this.lastPingTime = performance.now();
      this._send(new Uint8Array([MSG_HEARTBEAT, 0x00]));
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
        try { this._relayWs.send(new Uint8Array([MSG_HEARTBEAT, 0x02])); } catch (e) {}
      }
      // Refresh localStorage room timestamp
      this._refreshRoomTimestamp();
    }, 5 * 60 * 1000); // every 5 minutes
  }

  _stopRelayKeepalive() {
    if (this._relayKeepaliveInterval) {
      clearInterval(this._relayKeepaliveInterval);
      this._relayKeepaliveInterval = null;
    }
  }

  _refreshRoomTimestamp() {
    try {
      const raw = localStorage.getItem('tandemonium-rooms');
      if (raw) {
        const rooms = JSON.parse(raw);
        const entry = rooms.find(r => r.roomCode === this.roomCode);
        if (entry) {
          entry.timestamp = Date.now();
          localStorage.setItem('tandemonium-rooms', JSON.stringify(rooms));
        }
      }
    } catch (e) {}
  }

  _handleDisconnect() {
    clearTimeout(this._reconnectTimeout);
    this.connected = false;
    this._stopHeartbeat();

    if (this._reconnectAttempts < this._maxReconnectAttempts) {
      this._reconnectAttempts++;
      if (this.onReconnecting) this.onReconnecting(this._reconnectAttempts, this._maxReconnectAttempts);
      const delay = this._reconnectAttempts <= this._fastReconnectAttempts
        ? Math.pow(2, this._reconnectAttempts - 1) * 1000
        : 16000;
      setTimeout(() => {
        if (!this.connected) this._attemptReconnect();
      }, delay);
    } else {
      if (this.onDisconnected) this.onDisconnected('Connection lost');
    }
  }

  // Public: reset retry counter and start a fresh reconnection cycle
  retryConnection() {
    this._reconnectAttempts = 0;
    this._ensureBrokerConnection();
    this._handleDisconnect();
  }

  // Re-register with PeerJS signaling server if the broker WebSocket dropped
  _ensureBrokerConnection() {
    if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
      try { this.peer.reconnect(); } catch (e) { console.warn('NET: Broker reconnect failed:', e); }
    }
  }

  _attemptReconnect() {
    if (this.onReconnecting) this.onReconnecting(this._reconnectAttempts, this._maxReconnectAttempts);

    // Close stale connections
    if (this.conn) { try { this.conn.close(); } catch (e) {} }
    if (this._relayWs) { try { this._relayWs.close(); } catch (e) {} this._relayWs = null; }

    // Reconnect via relay first (primary transport)
    if (this._fallbackUrl) {
      this._relayReconnectAttempts = 0;
      this._connectRelay();
      // Timeout: if relay doesn't reconnect within 5s, try next attempt
      this._reconnectTimeout = setTimeout(() => {
        if (!this.connected) this._handleDisconnect();
      }, 5000);
    } else {
      // Fallback to PeerJS-only reconnection
      this._ensureBrokerConnection();
      if (this.role === 'stoker' && this.roomCode) {
        if (this.peer && !this.peer.destroyed) {
          this.conn = this.peer.connect(this.roomCode, { reliable: true, serialization: 'binary' });
          this._setupConnection();
          this._reconnectTimeout = setTimeout(() => {
            if (!this.connected) {
              if (this.conn) { try { this.conn.close(); } catch (e) {} }
              this._handleDisconnect();
            }
          }, 5000);
        }
      } else if (this.role === 'captain') {
        this._reconnectTimeout = setTimeout(() => {
          if (!this.connected) this._handleDisconnect();
        }, 5000);
      }
    }
  }

  _handleIncomingCall(call) {
    // Close previous media call to prevent duplicate streams
    if (this._mediaCall) {
      try { this._mediaCall.close(); } catch (e) {}
    }
    this._mediaCall = call;
    // Answer immediately with pre-acquired stream (from game.js _acquireLocalMedia)
    // to avoid async getUserMedia delay that causes call timeouts on mobile
    if (this._localMediaStream) {
      call.answer(this._localMediaStream);
      this._answeredWithoutMedia = false;
    } else {
      call.answer();
      this._answeredWithoutMedia = true;
    }

    call.on('stream', (remoteStream) => {
      this._playRemoteAudio(remoteStream);
      if (this.onRemoteStream) this.onRemoteStream(remoteStream);
    });
  }

  _playRemoteAudio(stream) {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;
    const audioEl = document.getElementById('partner-audio');
    if (!audioEl) return;
    audioEl.srcObject = stream;
    audioEl.play().catch(() => {});
  }

  _connectRelay() {
    if (!this._fallbackUrl) return;
    this._relayPartnerReady = false;
    this._relayDidOpen = false;
    let url = this._fallbackUrl + '?room=' + this.roomCode + '&role=' + this.role;
    if (this._relayToken) url += '&token=' + encodeURIComponent(this._relayToken);
    this._relayWs = new WebSocket(url);

    this._relayWs.binaryType = 'arraybuffer';
    this._relayWs.onopen = () => {
      this._relayDidOpen = true;
      this._relayReconnectAttempts = 0;
      this.transport = 'relay';

      // Room joined — notify caller
      if (this.onRoomJoined) this.onRoomJoined();
      if (this._enterRoomCallback) {
        this._enterRoomCallback({ status: 'waiting' });
        this._enterRoomCallback = null;
      }
    };
    this._relayWs.onmessage = (e) => {
      this._handleMessage(e.data);
    };
    this._relayWs.onerror = (err) => {
      console.warn('NET: Relay WebSocket error:', err);
    };
    this._relayWs.onclose = () => {
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
        // Fire auth error callback instead of futile reconnect loop
        if (this.onAuthError) {
          this.onAuthError();
        } else {
          // No auth error handler — surface as disconnect with clear message
          if (this.onDisconnected) this.onDisconnected('Authentication failed');
        }
        return;
      }
      if (this.transport === 'relay' || this.transport === 'none') {
        // Try relay reconnection with backoff before falling back to disconnect
        if (this._relayReconnectAttempts < 3) {
          this._relayReconnectAttempts++;
          const delay = Math.pow(2, this._relayReconnectAttempts - 1) * 1000; // 1s, 2s, 4s
          console.warn('NET: Relay closed, retrying in ' + delay + 'ms (attempt ' + this._relayReconnectAttempts + '/3)');
          setTimeout(() => {
            if (!this.connected) {
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
    if (this._relayWs) { try { this._relayWs.close(); } catch (e) {} this._relayWs = null; }
    this._connectRelay();
  }

  _reconnectRelayBackground() {
    // Silently reconnect relay as hot standby while P2P is active
    setTimeout(() => {
      if (this.connected && this.transport === 'p2p') {
        this._relayReconnectAttempts = 0;
        this._connectRelay();
      }
    }, 2000);
  }

  _attemptP2PUpgrade() {
    if (!this.roomCode || !this.role) return;
    if (this.transport === 'p2p') return; // already on P2P

    // Destroy stale peer from previous session to free the ID on the signaling server
    if (this.peer) {
      this._activeConn = null; // prevent close handler from triggering disconnect
      this.conn = null;
      try { this.peer.destroy(); } catch (e) {}
      this.peer = null;
    }

    const peerId = this.roomCode + '-' + this.role;
    const partnerPeerId = this.roomCode + '-' + (this.role === 'captain' ? 'stoker' : 'captain');

    this._fetchIceServers().then(iceServers => {
      this.peer = new window.Peer(peerId, {
        ...PEERJS_CONFIG,
        config: { iceServers }
      });

      this.peer.on('open', () => {
        if (this.role === 'stoker') {
          // Stoker initiates data channel to captain
          this.conn = this.peer.connect(partnerPeerId, { reliable: true, serialization: 'binary' });
          this._setupP2PUpgradeConnection();
        }
        // Captain waits for incoming connection
      });

      this.peer.on('connection', (conn) => {
        this.conn = conn;
        this._setupP2PUpgradeConnection();
      });

      this.peer.on('call', (call) => this._handleIncomingCall(call));

      this.peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          // Peer ID already taken — skip P2P upgrade
          console.warn('NET: P2P upgrade skipped — peer ID in use');
          return;
        }
        if (err.type === 'peer-unavailable') {
          // Partner not registered yet — retry later
          this._scheduleP2PRetry();
          return;
        }
        console.warn('NET: P2P upgrade error:', err);
      });

      // Timeout: if P2P doesn't connect within 15s, stay on relay
      this._p2pUpgradeTimeout = setTimeout(() => {
        if (this.transport !== 'p2p') {
          console.log('NET: P2P upgrade timed out, staying on relay');
          this._scheduleP2PRetry();
        }
      }, 15000);
    });
  }

  _setupP2PUpgradeConnection() {
    const conn = this.conn;
    conn.on('open', () => {
      clearTimeout(this._p2pUpgradeTimeout);
      this.transport = 'p2p';
      this._activeConn = conn;
      console.log('NET: Upgraded to P2P transport');
      // Start WebRTC quality stats polling
      this._startStatsPolling();
      // Start relay keepalive to keep it as hot standby
      this._startRelayKeepalive();
      // Notify listeners (game.js uses this to start media calls)
      if (this.onP2PUpgrade) this.onP2PUpgrade();
    });

    conn.on('data', (data) => {
      this._handleMessage(data);
    });

    conn.on('close', () => {
      if (conn !== this._activeConn) return;
      // P2P dropped — fall back to relay silently if relay is alive
      this._stopStatsPolling();
      if (this._relayWs && this._relayWs.readyState === WebSocket.OPEN) {
        console.log('NET: P2P dropped, falling back to relay');
        this.transport = 'relay';
        // Retry P2P upgrade later
        this._scheduleP2PRetry();
      } else {
        this._handleDisconnect();
      }
    });

    conn.on('error', (err) => {
      console.warn('NET: P2P connection error:', err);
    });
  }

  _scheduleP2PRetry() {
    clearTimeout(this._p2pUpgradeRetryTimeout);
    this._p2pUpgradeRetryTimeout = setTimeout(() => {
      if (this.connected && this.transport !== 'p2p') {
        // Clean up old peer before retrying
        if (this.peer) { try { this.peer.destroy(); } catch (e) {} this.peer = null; }
        this._attemptP2PUpgrade();
      }
    }, 30000);
  }

  async acquireLocalMedia(cameraEnabled, audioEnabled) {
    // If stream already has all requested tracks, nothing to do
    if (this._localMediaStream) {
      const hasVideo = this._localMediaStream.getVideoTracks().length > 0;
      const hasAudio = this._localMediaStream.getAudioTracks().length > 0;
      if ((!cameraEnabled || hasVideo) && (!audioEnabled || hasAudio)) return;
      // Need to add missing tracks to the existing stream
      const constraints = {};
      if (cameraEnabled && !hasVideo) constraints.video = { facingMode: 'user', width: 240, height: 240 };
      if (audioEnabled && !hasAudio) constraints.audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (Object.keys(constraints).length === 0) return;
      try {
        const extra = await navigator.mediaDevices.getUserMedia(constraints);
        for (const track of extra.getTracks()) {
          this._localMediaStream.addTrack(track);
        }
      } catch (e) { /* denied — continue without */ }
      return;
    }
    const constraints = {};
    if (cameraEnabled) constraints.video = { facingMode: 'user', width: 240, height: 240 };
    if (audioEnabled) constraints.audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!constraints.video && !constraints.audio) return;
    try {
      this._localMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Camera/mic denied — continue without media
    }
  }

  initiateCall() {
    if (!this.peer || !this.conn) return;
    const localStream = this._localMediaStream || new MediaStream();
    const remotePeerId = this.conn.peer;
    if (!remotePeerId) return;
    // Close previous outgoing call to prevent duplicate streams
    if (this._mediaCall) {
      try { this._mediaCall.close(); } catch (e) {}
    }
    const call = this.peer.call(remotePeerId, localStream);
    if (call) {
      this._mediaCall = call;
      call.on('stream', (remoteStream) => {
        this._playRemoteAudio(remoteStream);
        if (this.onRemoteStream) this.onRemoteStream(remoteStream);
      });
    }
  }

  destroy() {
    this._stopHeartbeat();
    this._stopStatsPolling();
    clearTimeout(this._reconnectTimeout);
    clearTimeout(this._p2pUpgradeTimeout);
    clearTimeout(this._p2pUpgradeRetryTimeout);
    this._stopRelayKeepalive();
    // Cancel any pending reliable-event retries
    for (const t of this._reliableEventTimers) clearTimeout(t);
    this._reliableEventTimers.length = 0;
    // Detach resume listeners
    if (typeof document !== 'undefined' && this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    if (typeof window !== 'undefined' && this._onOnline) {
      window.removeEventListener('online', this._onOnline);
    }
    // Stop local media tracks
    if (this._localMediaStream) {
      this._localMediaStream.getTracks().forEach(t => t.stop());
      this._localMediaStream = null;
    }
    // Close media call
    if (this._mediaCall) {
      try { this._mediaCall.close(); } catch (e) {}
      this._mediaCall = null;
    }
    // Stop remote audio playback
    const audioEl = document.getElementById('partner-audio');
    if (audioEl) { audioEl.srcObject = null; }
    if (this.conn) { try { this.conn.close(); } catch (e) {} }
    if (this.peer) { try { this.peer.destroy(); } catch (e) {} }
    if (this._relayWs) { try { this._relayWs.close(); } catch (e) {} }
    this.connected = false;
    this.conn = null;
    this.peer = null;
    this._relayWs = null;
  }

  // ---- WebRTC Quality Stats ----

  _startStatsPolling() {
    this._stopStatsPolling();
    this._statsSamples = [];
    this._statsInterval = setInterval(() => this._sampleStats(), 5000);
  }

  _stopStatsPolling() {
    if (this._statsInterval) {
      clearInterval(this._statsInterval);
      this._statsInterval = null;
    }
  }

  async _sampleStats() {
    if (this.transport !== 'p2p' || !this.conn) return;
    // PeerJS exposes the underlying RTCPeerConnection via conn.peerConnection
    const pc = this.conn.peerConnection;
    if (!pc || !pc.getStats) return;

    try {
      const stats = await pc.getStats();
      let rtt = null, packetsLost = 0, packetsSent = 0, bytesReceived = 0, bytesSent = 0;

      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rtt = report.currentRoundTripTime != null ? Math.round(report.currentRoundTripTime * 1000) : null;
        }
        if (report.type === 'inbound-rtp') {
          packetsLost += report.packetsLost || 0;
          bytesReceived += report.bytesReceived || 0;
        }
        if (report.type === 'outbound-rtp') {
          packetsSent += report.packetsSent || 0;
          bytesSent += report.bytesSent || 0;
        }
      });

      this._statsSamples.push({ rtt, packetsLost, packetsSent, bytesReceived, bytesSent, timestamp: Date.now() });
    } catch (e) {
      console.warn('NET: Stats sampling failed:', e);
    }
  }

  getQualityStats() {
    const samples = this._statsSamples;
    if (samples.length === 0) return null;

    const rtts = samples.map(s => s.rtt).filter(r => r != null);
    const avgRtt = rtts.length > 0 ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null;
    const maxRtt = rtts.length > 0 ? Math.max(...rtts) : null;

    // Packet loss: compare last and first samples for cumulative diff
    const first = samples[0];
    const last = samples[samples.length - 1];
    const totalLost = last.packetsLost - first.packetsLost;
    const totalSent = last.packetsSent - first.packetsSent;
    const lossRate = totalSent > 0 ? Math.round((totalLost / totalSent) * 10000) / 100 : 0;

    return {
      avg_rtt_ms: avgRtt,
      max_rtt_ms: maxRtt,
      packet_loss_pct: lossRate,
      samples: samples.length,
      duration_sec: Math.round((last.timestamp - first.timestamp) / 1000),
    };
  }
}
