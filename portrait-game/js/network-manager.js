// ============================================================
// NETWORK MANAGER — PeerJS P2P + Cloudflare Worker relay
// ============================================================

import {
  MSG_PEDAL, MSG_STATE, MSG_EVENT, MSG_HEARTBEAT, MSG_LEAN
} from './config.js';

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
    this._heartbeatInterval = null;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 3;
    this._relayWs = null;
    this._fallbackUrl = null;
    this._relayPartnerReady = false;
    this._p2pFallbackDelay = 60000; // 60 seconds before relay fallback
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'TNDM-';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  createRoom(callback) {
    this.role = 'captain';
    this.roomCode = this.generateRoomCode();

    this.peer = new window.Peer(this.roomCode, {
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    this.peer.on('open', (id) => {
      if (callback) callback(this.roomCode);
      // Fallback to relay if no P2P connection within timeout
      this._p2pTimeout = setTimeout(() => {
        if (!this.connected && this._fallbackUrl) {
          this._connectRelay();
        }
      }, this._p2pFallbackDelay);
    });

    this.peer.on('connection', (conn) => {
      this.conn = conn;
      this._setupConnection();
    });

    this.peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        this.roomCode = this.generateRoomCode();
        this.peer.destroy();
        this.createRoom(callback);
      }
    });
  }

  joinRoom(roomCode, callback) {
    this.role = 'stoker';
    this.roomCode = roomCode.toUpperCase();

    this.peer = new window.Peer(null, {
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    this.peer.on('open', () => {
      this.conn = this.peer.connect(this.roomCode, { reliable: false, serialization: 'binary' });
      this._setupConnection();
      if (callback) callback();

      // Fallback timer starts AFTER peer broker registration (inside on-open)
      this._p2pTimeout = setTimeout(() => {
        if (!this.connected && this._fallbackUrl) {
          this._connectRelay();
        }
      }, this._p2pFallbackDelay);
    });

    this.peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        if (this.onDisconnected) this.onDisconnected('Room not found');
      }
    });
  }

  _setupConnection() {
    this.conn.on('open', () => {
      this.connected = true;
      this.transport = 'p2p';
      this._reconnectAttempts = 0;
      clearTimeout(this._p2pTimeout);
      this._startHeartbeat();
      if (this.onConnected) this.onConnected();
    });

    this.conn.on('data', (data) => {
      this._handleMessage(data);
    });

    this.conn.on('close', () => {
      this._handleDisconnect();
    });

    this.conn.on('error', (err) => {
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
      if (bytes.length >= 2 && bytes[1] === 0x01) {
        this.pingMs = performance.now() - this.lastPingTime;
      } else {
        this._send(new Uint8Array([MSG_HEARTBEAT, 0x01]));
      }
    }
  }

  sendPedal(foot) {
    this._send(new Uint8Array([MSG_PEDAL, foot === 'down' ? 0x01 : 0x00]));
  }

  sendLean(leanValue) {
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint8(0, MSG_LEAN);
    view.setFloat32(1, leanValue, true);
    this._send(new Uint8Array(buf));
  }

  sendState(bike) {
    const buf = new ArrayBuffer(38);
    const view = new DataView(buf);
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
    let flags = 0;
    if (bike.fallen) flags |= 1;
    if (bike._braking) flags |= 2;
    view.setUint8(37, flags);
    this._send(new Uint8Array(buf));
  }

  sendEvent(eventType) {
    this._send(new Uint8Array([MSG_EVENT, eventType]));
  }

  _decodeState(bytes) {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const view = new DataView(buf);
    return {
      x: view.getFloat32(1, true),
      y: view.getFloat32(5, true),
      z: view.getFloat32(9, true),
      heading: view.getFloat32(13, true),
      lean: view.getFloat32(17, true),
      leanVelocity: view.getFloat32(21, true),
      speed: view.getFloat32(25, true),
      crankAngle: view.getFloat32(29, true),
      distanceTraveled: view.getFloat32(33, true),
      flags: view.getUint8(37)
    };
  }

  _send(data) {
    if (this.conn && this.conn.open) {
      try { this.conn.send(data); } catch (e) { /* silent */ }
    } else if (this._relayWs && this._relayWs.readyState === WebSocket.OPEN) {
      this._relayWs.send(data);
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._lastRemoteHeartbeat = performance.now();
    this._heartbeatInterval = setInterval(() => {
      this.lastPingTime = performance.now();
      this._send(new Uint8Array([MSG_HEARTBEAT, 0x00]));
      if (performance.now() - this._lastRemoteHeartbeat > 3000) {
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

  _handleDisconnect() {
    this.connected = false;
    this._stopHeartbeat();
    if (this.onDisconnected) this.onDisconnected('Connection lost');

    if (this._reconnectAttempts < this._maxReconnectAttempts) {
      this._reconnectAttempts++;
      const delay = Math.pow(2, this._reconnectAttempts - 1) * 1000;
      setTimeout(() => {
        if (!this.connected) this._attemptReconnect();
      }, delay);
    }
  }

  _attemptReconnect() {
    if (this.role === 'stoker' && this.roomCode) {
      // Stoker reconnects by re-opening a data channel to captain's peer
      if (this.peer && !this.peer.destroyed) {
        this.conn = this.peer.connect(this.roomCode, { reliable: false, serialization: 'binary' });
        this._setupConnection();
      }
    } else if (this.role === 'captain') {
      // Captain: peer is still registered and listening for connections.
      // If the stoker reconnects, peer.on('connection') will fire.
      // Also try relay fallback if available.
      if (this._fallbackUrl && (!this._relayWs || this._relayWs.readyState !== WebSocket.OPEN)) {
        this._relayPartnerReady = false;
        this._connectRelay();
      }
    }
  }

  _connectRelay() {
    if (!this._fallbackUrl) return;
    this._relayPartnerReady = false;
    this._relayWs = new WebSocket(this._fallbackUrl + '?room=' + this.roomCode + '&role=' + this.role);

    this._relayWs.binaryType = 'arraybuffer';
    this._relayWs.onopen = () => {
      this.transport = 'relay';
      clearTimeout(this._p2pTimeout);
      // Don't call onConnected or start heartbeat yet —
      // wait for 'partner-ready' message from relay
    };
    this._relayWs.onmessage = (e) => {
      this._handleMessage(e.data);
    };
    this._relayWs.onclose = () => {
      if (this.transport === 'relay') this._handleDisconnect();
    };
  }

  destroy() {
    this._stopHeartbeat();
    clearTimeout(this._p2pTimeout);
    if (this.conn) { try { this.conn.close(); } catch (e) {} }
    if (this.peer) { try { this.peer.destroy(); } catch (e) {} }
    if (this._relayWs) { try { this._relayWs.close(); } catch (e) {} }
    this.connected = false;
    this.conn = null;
    this.peer = null;
    this._relayWs = null;
  }
}
