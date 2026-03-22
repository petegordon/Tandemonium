// ============================================================
// NETWORK MANAGER — PeerJS P2P + Cloudflare Worker relay
// ============================================================

import {
  MSG_PEDAL, MSG_STATE, MSG_EVENT, MSG_HEARTBEAT, MSG_LEAN, MSG_PROFILE,
  TURN_CREDENTIALS_URL, PEERJS_HOST, PEERJS_PORT, PEERJS_PATH, PEERJS_SECURE
} from './config.js';

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

    // Pre-allocated send buffers (avoid per-send allocations)
    this._stateBuf = new ArrayBuffer(46);
    this._stateView = new DataView(this._stateBuf);
    this._stateBytes = new Uint8Array(this._stateBuf);
    this._leanBuf = new ArrayBuffer(5);
    this._leanView = new DataView(this._leanBuf);
    this._leanBytes = new Uint8Array(this._leanBuf);
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
    const type = bytes[0];

    if (type === MSG_PEDAL) {
      const foot = (bytes.length >= 2 && bytes[1] === 0x01) ? 'down' : 'up';
      if (this.onPedalReceived) this.onPedalReceived(this.role === 'captain' ? 'stoker' : 'captain', foot);
    } else if (type === MSG_STATE) {
      const state = this._decodeState(bytes);
      if (this.onStateReceived) this.onStateReceived(state);
    } else if (type === MSG_EVENT) {
      if (bytes.length >= 2 && this.onEventReceived) {
        this.onEventReceived(bytes[1]);
      }
    } else if (type === MSG_LEAN) {
      if (bytes.length >= 5) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const leanValue = view.getFloat32(1, true);
        if (this.onLeanReceived) this.onLeanReceived(leanValue);
      }
    } else if (type === MSG_HEARTBEAT) {
      this._lastRemoteHeartbeat = performance.now();
      // Verified data exchange — safe to reset reconnect counter
      this._reconnectAttempts = 0;
      if (bytes.length >= 2 && bytes[1] === 0x01) {
        this.pingMs = performance.now() - this.lastPingTime;
      } else {
        this._send(new Uint8Array([MSG_HEARTBEAT, 0x01]));
      }
    } else if (type === MSG_PROFILE) {
      try {
        const json = new TextDecoder().decode(bytes.slice(1));
        const profile = JSON.parse(json);
        if (this.onProfileReceived) this.onProfileReceived(profile);
      } catch (e) { /* ignore malformed profile */ }
    }
  }

  sendPedal(foot) {
    this._send(new Uint8Array([MSG_PEDAL, foot === 'down' ? 0x01 : 0x00]));
  }

  sendLean(leanValue) {
    const view = this._leanView;
    view.setUint8(0, MSG_LEAN);
    view.setFloat32(1, leanValue, true);
    this._send(this._leanBytes);
  }

  sendState(bike, timerRemaining) {
    const view = this._stateView;
    view.setUint8(0, MSG_STATE);
    view.setFloat32(1, bike.position.x, true);
    view.setFloat32(5, bike.position.y, true);
    view.setFloat32(9, bike.position.z, true);
    view.setFloat32(13, bike.heading, true);
    view.setFloat32(17, bike.lean, true);
    view.setFloat32(21, bike.leanVelocity, true);
    view.setFloat32(25, bike.speed, true);
    view.setFloat32(29, bike.crankAngle || 0, true);
    view.setFloat32(33, bike.distanceTraveled, true);
    view.setFloat32(37, bike.roadD, true);
    let flags = 0;
    if (bike.fallen) flags |= 1;
    if (bike._braking) flags |= 2;
    view.setUint8(41, flags);
    view.setFloat32(42, timerRemaining >= 0 ? timerRemaining : -1, true);
    this._send(this._stateBytes);
  }

  sendEvent(eventType) {
    this._send(new Uint8Array([MSG_EVENT, eventType]));
  }

  sendProfile(data) {
    const json = JSON.stringify(data);
    const encoded = new TextEncoder().encode(json);
    const msg = new Uint8Array(1 + encoded.length);
    msg[0] = MSG_PROFILE;
    msg.set(encoded, 1);
    this._send(msg);
  }

  _decodeState(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const state = {
      x: view.getFloat32(1, true),
      y: view.getFloat32(5, true),
      z: view.getFloat32(9, true),
      heading: view.getFloat32(13, true),
      lean: view.getFloat32(17, true),
      leanVelocity: view.getFloat32(21, true),
      speed: view.getFloat32(25, true),
      crankAngle: view.getFloat32(29, true),
      distanceTraveled: view.getFloat32(33, true),
      roadD: view.getFloat32(37, true),
      flags: view.getUint8(41)
    };
    // Timer field added in 46-byte messages; absent in legacy 42-byte messages
    if (bytes.byteLength >= 46) {
      state.timerRemaining = view.getFloat32(42, true);
    }
    return state;
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
      const raw = localStorage.getItem('tandemonium-room');
      if (raw) {
        const data = JSON.parse(raw);
        data.timestamp = Date.now();
        localStorage.setItem('tandemonium-room', JSON.stringify(data));
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
    const call = this.peer.call(remotePeerId, localStream);
    if (call) {
      call.on('stream', (remoteStream) => {
        this._playRemoteAudio(remoteStream);
        if (this.onRemoteStream) this.onRemoteStream(remoteStream);
      });
    }
  }

  destroy() {
    this._stopHeartbeat();
    clearTimeout(this._reconnectTimeout);
    clearTimeout(this._p2pUpgradeTimeout);
    clearTimeout(this._p2pUpgradeRetryTimeout);
    this._stopRelayKeepalive();
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
}
