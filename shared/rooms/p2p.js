// ============================================================
// withP2P — the optional PeerJS P2P upgrade for a RoomTransport (lab #137)
// ============================================================
//
//   import { RoomTransport } from './room-transport.js';
//   import { withP2P } from './p2p.js';
//   class GameNet extends withP2P(RoomTransport) { … }
//
// Once both seats are on the relay this layer tries a direct PeerJS connection
// (ids carry the room's P2P key, which the relay gives only to the two seat
// holders). When it opens, traffic moves to it and the relay stays as a hot
// standby; when it drops, traffic falls back to the relay and the upgrade is
// tried again later. It also opens the unordered fast lane and samples WebRTC
// quality stats. It needs the PeerJS library on `window.Peer`; without it the
// room simply stays on the relay.
//
// Options it reads (see RoomTransportOptions): turnCredentialsUrl, peerjs,
// fastChannelLabel. A media call that arrives is refused here; media.js answers.
//
// Lifted from Tandemonium's room transport with the method bodies unchanged.
// ============================================================

// Fast lane for high-rate, latest-wins traffic (bike STATE / LEAN). A second
// data channel on the same RTCPeerConnection, unordered with no retransmits,
// so one lost packet never holds up the ones behind it the way the reliable,
// ordered PeerJS channel does (issue #390). Both sides create it with the same
// pre-agreed id (negotiated: no signaling needed). It's only used once the
// partner has proved it speaks it (any message received on it), so a peer on
// an older build keeps getting everything on the main channel.
const FAST_CHANNEL_ID = 1000;       // clear of PeerJS's auto-assigned ids
const FAST_CHANNEL_MAX_BUFFERED = 16 * 1024; // bytes queued before we fall back

/**
 * @template {new (...args: any[]) => import('./room-transport.js').RoomTransport} T
 * @param {T} Base
 */
/** TURN credentials are reused for this long (they last an hour at the relay). */
const ICE_SERVERS_REUSE_MS = 50 * 60 * 1000;

export const withP2P = (Base) => class P2PRoomTransport extends Base {
  constructor(...args) {
    super(...args);
    this._fastHello = new Uint8Array([this._hb, 0x03]);
    this.peer = null;
    this.conn = null;
    this.onP2PUpgrade = null; // fires when P2P transport is established (for media calls)
    this._activeConn = null; // tracks which conn is current to ignore stale close events
    this._iceServers = null; // cached TURN + STUN servers
    this._p2pUpgradeTimeout = null;
    this._p2pUpgradeRetryTimeout = null;
    this._fastChannel = null;       // RTCDataChannel (unordered, no retransmits)
    this._fastPeerSeen = false;     // partner has sent on it → safe to use
    this._fastHelloInterval = null;
    // WebRTC quality stats
    this._statsInterval = null;
    this._statsSamples = []; // { rtt, packetsLost, packetsSent, bytesReceived, bytesSent, timestamp }
  }

  _defaultIceServers() {
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
  }

  async _fetchIceServers() {
    // TURN credentials expire (the relay gives them an hour): a later connection asks again.
    if (this._iceServers && Date.now() < (this._iceServersUntil || 0)) return this._iceServers;
    this._iceServers = null;
    try {
      // Only a connection holding a seat in this room gets TURN credentials (the relay checks).
      const q = '?room=' + encodeURIComponent(this.roomCode || '') + '&role=' + encodeURIComponent(this.role || '') + this._deviceParam();
      if (!this.options.turnCredentialsUrl) return this._defaultIceServers();   // no TURN: STUN only
      const resp = await fetch(this.options.turnCredentialsUrl + q);
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
        // Refused or empty (the partner may have just left): STUN for now, ask again next time.
        return this._defaultIceServers();
      }
      this._iceServersUntil = Date.now() + ICE_SERVERS_REUSE_MS;
    } catch (e) {
      console.warn('NET: Failed to fetch TURN credentials, using STUN only', e);
      return this._defaultIceServers();
    }
    return this._iceServers;
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
      this._openFastChannel(conn);
      if (this.onConnected) this.onConnected();
    });

    conn.on('data', (data) => {
      this._handleMessage(data, true);
    });

    conn.on('close', () => {
      // Ignore close events from stale connections
      if (conn !== this._activeConn) return;
      this._closeFastChannel();
      this._handleDisconnect();
    });

    conn.on('error', (err) => {
      console.warn('NET: Connection error:', err);
    });
  }

  // Latest-wins traffic: the unordered fast channel when the partner speaks
  // it, otherwise the normal path. Messages sent here may be dropped or
  // arrive out of order — receivers order them by their send time.
  _sendFast(data) {
    const ch = this._fastChannel;
    if (this.transport === 'p2p' && this._fastPeerSeen && ch &&
        ch.readyState === 'open' && ch.bufferedAmount < FAST_CHANNEL_MAX_BUFFERED) {
      try { ch.send(data); return; } catch (e) { /* fall through */ }
    }
    this._send(data);
  }

  _openFastChannel(conn) {
    this._closeFastChannel();
    const pc = conn && conn.peerConnection;
    if (!pc || typeof pc.createDataChannel !== 'function') return;
    let ch;
    try {
      ch = pc.createDataChannel(this.options.fastChannelLabel || 'rooms-fast', {
        negotiated: true, id: FAST_CHANNEL_ID, ordered: false, maxRetransmits: 0
      });
    } catch (e) {
      console.warn('NET: fast channel unavailable:', e);
      return;
    }
    ch.binaryType = 'arraybuffer';
    this._fastChannel = ch;
    this._fastPeerSeen = false;
    const hello = () => {
      if (ch.readyState === 'open') { try { ch.send(this._fastHello); } catch (e) {} }
    };
    ch.onopen = hello;
    ch.onmessage = (e) => {
      if (ch !== this._fastChannel) return;
      if (!this._fastPeerSeen) {
        this._fastPeerSeen = true;
        hello(); // make sure the partner hears us too, then stop announcing
        clearInterval(this._fastHelloInterval);
        this._fastHelloInterval = null;
        console.log('NET: fast channel active');
      }
      const bytes = new Uint8Array(e.data);
      if (bytes.length && bytes[0] === this._hb) return; // hello only
      this._handleMessage(bytes, true);
    };
    ch.onclose = () => {
      if (ch === this._fastChannel) this._fastPeerSeen = false;
    };
    // Keep announcing until the partner answers (an older build never will).
    this._fastHelloInterval = setInterval(hello, 1000);
  }

  _closeFastChannel() {
    clearInterval(this._fastHelloInterval);
    this._fastHelloInterval = null;
    const ch = this._fastChannel;
    this._fastChannel = null;
    this._fastPeerSeen = false;
    if (ch) { try { ch.close(); } catch (e) {} }
  }

  _send(data) {
    if (this.transport === 'p2p' && this.conn && this.conn.open) {
      try { this.conn.send(data); } catch (e) { console.warn('NET: P2P send failed:', e); }
      return;
    }
    super._send(data);
  }

  // Re-register with PeerJS signaling server if the broker WebSocket dropped
  _ensureBrokerConnection() {
    if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
      try { this.peer.reconnect(); } catch (e) { console.warn('NET: Broker reconnect failed:', e); }
    }
  }

  _closeDirect() {
    if (this.conn) { try { this.conn.close(); } catch (e) {} }
  }

  _releaseDirect() {
    this._activeConn = null;
    if (this.conn) { try { this.conn.close(); } catch (e2) { /* closed */ } this.conn = null; }
    this._closeFastChannel();
    if (this.peer) { try { this.peer.destroy(); } catch (e2) { /* gone */ } this.peer = null; }
  }

  _reconnectWithoutRelay() {
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

  _attemptP2PUpgrade() {
    if (!this.roomCode || !this.role) return;
    if (this.transport === 'p2p') return; // already on P2P
    // PeerJS comes from a CDN; when it didn't load (blocked, offline) stay on
    // the relay instead of throwing on every upgrade attempt (#472).
    if (typeof window === 'undefined' || typeof window.Peer !== 'function') {
      if (!this._peerMissingWarned) { this._peerMissingWarned = true; console.warn('NET: PeerJS not loaded; staying on the relay'); }
      return;
    }

    // Destroy stale peer from previous session to free the ID on the signaling server
    if (this.peer) {
      this._activeConn = null; // prevent close handler from triggering disconnect
      this.conn = null;
      this._closeFastChannel();
      try { this.peer.destroy(); } catch (e) {}
      this.peer = null;
    }

    // Peer ids carry the room's P2P key (the relay gives it only to the two seat holders), so
    // nobody who just knows the room code can find, or pose as, either peer. No key (an older
    // relay): stay on the relay.
    if (!this.p2pKey) return;
    const peerId = this.roomCode + '-' + this.p2pKey + '-' + this.role;
    const partnerPeerId = this.roomCode + '-' + this.p2pKey + '-' + (this.role === 'captain' ? 'stoker' : 'captain');

    this._fetchIceServers().then(iceServers => {
      // Destroyed while the TURN fetch was in flight: a Peer made now would never be destroyed,
      // hold this room's peer id ("peer ID in use") and could take the partner's connection.
      if (this._destroyed || this._evicted) return;
      // Two upgrade attempts close together both reach here: keep one Peer, never leak the
      // other (a leaked Peer holds this room's id: "peer ID in use").
      if (this.peer) { try { this.peer.destroy(); } catch (e) { /* gone */ } this.peer = null; }
      this.peer = new window.Peer(peerId, {
        ...(this.options.peerjs || {}),
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
        // Only the partner's peer id (see above); anyone else is refused.
        if (conn.peer !== partnerPeerId) { try { conn.close(); } catch (e) { /* gone */ } return; }
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
      this._openFastChannel(conn);
      // Notify listeners (game.js uses this to start media calls)
      if (this.onP2PUpgrade) this.onP2PUpgrade();
    });

    conn.on('data', (data) => {
      this._handleMessage(data, true);
    });

    conn.on('close', () => {
      if (conn !== this._activeConn) return;
      // P2P dropped — fall back to relay silently if relay is alive
      this._stopStatsPolling();
      this._closeFastChannel();
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
        this._closeFastChannel();
        if (this.peer) { try { this.peer.destroy(); } catch (e) {} this.peer = null; }
        this._attemptP2PUpgrade();
      }
    }, 30000);
  }

  /** A media call arrived. Without the media layer it is refused, so no MediaConnection opens. */
  _handleIncomingCall(call) {
    try { call.close(); } catch (e) {}
  }

  destroy() {
    this._destroyed = true;
    this._stopStatsPolling();
    clearTimeout(this._p2pUpgradeTimeout);
    clearTimeout(this._p2pUpgradeRetryTimeout);
    this._closeFastChannel();
    if (this.conn) { try { this.conn.close(); } catch (e) {} }
    if (this.peer) { try { this.peer.destroy(); } catch (e) {} }
    super.destroy();
    this.conn = null;
    this.peer = null;
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
};
