// ============================================================
// TANDEMONIUM - Tandem Bicycle Physics Game
// ============================================================
// Architecture: Components separated for future multiplayer
// - PedalController: Rhythmic pedaling (assignable to Player 2)
// - BalanceController: Lean/balance (assignable to Player 1)
// - RiderComponent: Visual rider (front/rear independent)
// - TandemBike: Physics entity + visuals
// - ChaseCamera: Smooth third-person camera
// - World: Environment
// - HUD: On-screen display
// - Game: Main loop orchestration
// ============================================================

(function () {
    'use strict';

    // ============================================================
    // MOBILE DETECTION
    // ============================================================
    const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1);

    if (isMobile) {
        document.body.classList.add('is-mobile');
    }

    // ============================================================
    // DEBUG CONSOLE (on-screen for mobile)
    // ============================================================
    const _debugLines = [];
    const _debugMax = 30;
    let _debugEl = null;
    let _debugReady = false;
    let _debugThrottle = {};
    function dbg(msg, throttleKey) {
        if (throttleKey) {
            const now = Date.now();
            if (_debugThrottle[throttleKey] && now - _debugThrottle[throttleKey] < 500) return;
            _debugThrottle[throttleKey] = now;
        }
        _debugLines.push(msg);
        if (_debugLines.length > _debugMax) _debugLines.shift();
        if (_debugReady && _debugEl) {
            _debugEl.textContent = _debugLines.join('\n');
            _debugEl.scrollTop = _debugEl.scrollHeight;
        }
    }
    function _initDebug() {
        _debugEl = document.getElementById('debug-console');
        const btn = document.getElementById('debug-btn');
        _debugReady = true;
        if (btn && _debugEl) {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                _debugEl.classList.toggle('visible');
            });
        }
        // Flush buffered messages
        if (_debugEl && _debugLines.length > 0) {
            _debugEl.textContent = _debugLines.join('\n');
        }
    }

    // ============================================================
    // INPUT MANAGER
    // Unified input: keyboard + touch + device motion
    // ============================================================
    class InputManager {
        constructor() {
            this.keys = {};
            this.touchLeft = false;
            this.touchRight = false;
            this.motionLean = 0;       // -1 to 1 from device tilt
            this.motionEnabled = false;
            this.motionReady = false;   // true after iOS permission granted
            this.rawGamma = 0;         // raw gamma from device orientation
            this.motionOffset = null;  // calibration offset (null = not calibrated)
            this._setupKeyboard();
            if (isMobile) {
                this._setupTouch();
                this._setupMotion();
                this._setupCalibration();
            }
        }

        _setupKeyboard() {
            window.addEventListener('keydown', (e) => {
                if (['ArrowUp', 'ArrowDown', 'KeyA', 'KeyD'].includes(e.code)) {
                    e.preventDefault();
                }
                this.keys[e.code] = true;
            });
            window.addEventListener('keyup', (e) => {
                this.keys[e.code] = false;
            });
        }

        _setupTouch() {
            const leftBtn = document.getElementById('touch-left');
            const rightBtn = document.getElementById('touch-right');

            const setTouch = (el, side, pressed) => {
                el.addEventListener(pressed ? 'touchstart' : 'touchend', (e) => {
                    e.preventDefault();
                    if (side === 'left') this.touchLeft = pressed;
                    else this.touchRight = pressed;
                }, { passive: false });
            };

            setTouch(leftBtn, 'left', true);
            setTouch(leftBtn, 'left', false);
            setTouch(rightBtn, 'right', true);
            setTouch(rightBtn, 'right', false);

            // Handle touchcancel (finger slides off)
            leftBtn.addEventListener('touchcancel', () => { this.touchLeft = false; });
            rightBtn.addEventListener('touchcancel', () => { this.touchRight = false; });

            // Handle finger leaving the button area
            leftBtn.addEventListener('touchmove', (e) => {
                const touch = e.touches[0];
                const rect = leftBtn.getBoundingClientRect();
                if (touch.clientX < rect.left || touch.clientX > rect.right ||
                    touch.clientY < rect.top || touch.clientY > rect.bottom) {
                    this.touchLeft = false;
                }
            }, { passive: false });
            rightBtn.addEventListener('touchmove', (e) => {
                const touch = e.touches[0];
                const rect = rightBtn.getBoundingClientRect();
                if (touch.clientX < rect.left || touch.clientX > rect.right ||
                    touch.clientY < rect.top || touch.clientY > rect.bottom) {
                    this.touchRight = false;
                }
            }, { passive: false });
        }

        _setupMotion() {
            dbg('setupMotion: DME=' + (typeof DeviceMotionEvent !== 'undefined') +
                ' reqPerm=' + (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function'));
            // Check if we need iOS 13+ permission
            if (typeof DeviceMotionEvent !== 'undefined' &&
                typeof DeviceMotionEvent.requestPermission === 'function') {
                // iOS 13+ - defer permission request to first user gesture (tap to start)
                this.needsMotionPermission = true;
                dbg('setupMotion: iOS path, needsPermission=true');
            } else if (typeof DeviceMotionEvent !== 'undefined') {
                // Android / older iOS - just start listening
                dbg('setupMotion: non-iOS path, start listening');
                this._startMotionListening();
            } else {
                dbg('setupMotion: no DeviceMotionEvent support');
            }
        }

        async requestMotionPermission() {
            dbg('reqPerm: motionEnabled=' + this.motionEnabled);
            if (this.motionEnabled) return; // already working
            this.needsMotionPermission = false;
            if (typeof DeviceMotionEvent === 'undefined' ||
                typeof DeviceMotionEvent.requestPermission !== 'function') {
                dbg('reqPerm: no requestPermission fn, skip');
                return;
            }
            try {
                dbg('reqPerm: calling requestPermission...');
                const response = await DeviceMotionEvent.requestPermission();
                dbg('reqPerm: response=' + response);
                if (response === 'granted') {
                    this._startMotionListening();
                } else {
                    this._showMotionDenied();
                }
            } catch (e) {
                dbg('reqPerm: error=' + e.message);
                console.warn('Motion permission error:', e);
                this._showMotionDenied();
            }
        }

        _showMotionDenied() {
            const status = document.getElementById('status');
            if (status) {
                status.textContent = 'Motion denied — tap aA in Safari address bar → Website Settings → Motion';
                status.style.color = '#ffaa22';
                status.style.fontSize = '14px';
                setTimeout(() => {
                    if (status.textContent.includes('Motion denied')) {
                        status.textContent = '';
                        status.style.fontSize = '';
                    }
                }, 8000);
            }
        }

        _startMotionListening() {
            dbg('startMotionListening called');
            this.motionReady = true;
            this.motionRawRelative = 0;
            this._useAccel = false;
            this._dmCount = 0;
            this._doCount = 0;

            // Smoothed gravity vector (for accelerometer path)
            this._gx = 0;
            this._gy = 0;
            this._gz = 0;
            this._gravityInit = false;

            // --- PRIMARY: devicemotion (accelerometer, no Euler cross-talk) ---
            window.addEventListener('devicemotion', (e) => {
                this._dmCount++;
                const a = e.accelerationIncludingGravity;
                if (!a || a.x == null) {
                    dbg('devicemotion: no data a=' + JSON.stringify(a), 'dm-nodata');
                    return;
                }

                if (this._dmCount <= 3) {
                    dbg('devicemotion #' + this._dmCount + ': x=' + a.x.toFixed(2) + ' y=' + a.y.toFixed(2) + ' z=' + a.z.toFixed(2));
                }

                this._useAccel = true;
                this.motionEnabled = true;

                // Low-pass filter
                const k = 0.3;
                if (!this._gravityInit) {
                    this._gx = a.x; this._gy = a.y; this._gz = a.z;
                    this._gravityInit = true;
                } else {
                    this._gx += (a.x - this._gx) * k;
                    this._gy += (a.y - this._gy) * k;
                    this._gz += (a.z - this._gz) * k;
                }

                // Roll from gravity projected onto screen plane
                const orient = screen.orientation ? screen.orientation.angle
                    : (window.orientation || 0);
                let rollRad;
                if (orient === 90) {
                    rollRad = Math.atan2(this._gy, -this._gx);
                } else if (orient === 270 || orient === -90) {
                    rollRad = Math.atan2(-this._gy, this._gx);
                } else {
                    rollRad = Math.atan2(this._gx, this._gy);
                }

                this._applyTilt(-rollRad * 180 / Math.PI);
            });

            // --- FALLBACK: deviceorientation (Euler angles, has pitch cross-talk
            //     but works on devices where devicemotion gives no data) ---
            window.addEventListener('deviceorientation', (e) => {
                this._doCount++;
                if (this._useAccel) return; // accelerometer is working, ignore this

                if (this._doCount <= 3) {
                    dbg('deviceorientation #' + this._doCount + ': a=' + (e.alpha && e.alpha.toFixed(1)) +
                        ' b=' + (e.beta && e.beta.toFixed(1)) + ' g=' + (e.gamma && e.gamma.toFixed(1)));
                }

                const orient = screen.orientation ? screen.orientation.angle
                    : (window.orientation || 0);
                let rawTilt;
                if (orient === 90) {
                    rawTilt = e.beta;
                } else if (orient === 270 || orient === -90) {
                    rawTilt = -e.beta;
                } else {
                    rawTilt = e.gamma;
                }

                if (rawTilt != null) {
                    this.motionEnabled = true;
                    this._applyTilt(rawTilt);
                }
            });

            // Log event counts after 3 seconds to see what's firing
            setTimeout(() => {
                dbg('after 3s: dmEvents=' + this._dmCount + ' doEvents=' + this._doCount +
                    ' useAccel=' + this._useAccel + ' motionEnabled=' + this.motionEnabled);
            }, 3000);
        }

        _applyTilt(rawTilt) {
            this.rawGamma = rawTilt;

            if (this.motionOffset === null) {
                this.motionOffset = this.rawGamma;
            }

            let relative = this.rawGamma - this.motionOffset;
            // Normalize to [-180, 180] to handle atan2 wraparound at ±180°
            // Without this, crossing the boundary causes a 360° jump
            if (relative > 180) relative -= 360;
            else if (relative < -180) relative += 360;
            this.motionRawRelative = relative;

            // Dead zone: ignore tiny tilts (under ~2 degrees)
            const deadZone = 2;
            if (Math.abs(relative) < deadZone) {
                relative = 0;
            } else {
                relative = relative - Math.sign(relative) * deadZone;
            }

            // ~40 degrees beyond dead zone = full lean input
            this.motionLean = Math.max(-1, Math.min(1, relative / 40));
        }

        _setupCalibration() {
            const gauge = document.getElementById('phone-gauge');
            const flash = document.getElementById('calibrate-flash');

            const doCalibrate = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.motionOffset = this.rawGamma;
                this.motionLean = 0;

                // Visual feedback
                if (flash) {
                    flash.style.display = 'block';
                    setTimeout(() => { flash.style.display = 'none'; }, 800);
                }
            };

            gauge.addEventListener('touchstart', doCalibrate, { passive: false });
            gauge.addEventListener('click', doCalibrate);
        }

        isPressed(code) {
            if (code === 'ArrowUp') return !!this.keys[code] || this.touchLeft;
            if (code === 'ArrowDown') return !!this.keys[code] || this.touchRight;
            return !!this.keys[code];
        }

        getMotionLean() {
            if (!this.motionEnabled) return 0;
            return this.motionLean;
        }
    }

    // ============================================================
    // NETWORK MANAGER
    // PeerJS P2P with Cloudflare Worker fallback
    // ============================================================
    const MSG_PEDAL = 0x01;
    const MSG_STATE = 0x02;
    const MSG_EVENT = 0x03;
    const MSG_HEARTBEAT = 0x04;
    const MSG_LEAN = 0x05;

    const EVT_COUNTDOWN = 0x01;
    const EVT_START = 0x02;
    const EVT_CRASH = 0x03;
    const EVT_RESET = 0x04;

    class NetworkManager {
        constructor() {
            this.peer = null;
            this.conn = null;
            this.role = null; // 'captain' | 'stoker'
            this.roomCode = null;
            this.connected = false;
            this.transport = 'none'; // 'p2p' | 'relay' | 'none'
            this.lastPingTime = 0;
            this.pingMs = 0;
            this.onPedalReceived = null;  // callback(source, foot)
            this.onStateReceived = null;  // callback(stateObj)
            this.onEventReceived = null;  // callback(eventType)
            this.onLeanReceived = null;   // callback(leanValue)
            this.onConnected = null;      // callback()
            this.onDisconnected = null;   // callback()
            this._heartbeatInterval = null;
            this._reconnectAttempts = 0;
            this._maxReconnectAttempts = 3;
            this._relayWs = null;
            this._fallbackUrl = null; // set if Cloudflare Worker URL is configured
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
            dbg('NET: Creating room ' + this.roomCode);

            this.peer = new Peer(this.roomCode, {
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' }
                    ]
                }
            });

            this.peer.on('open', (id) => {
                dbg('NET: Peer open as ' + id);
                if (callback) callback(this.roomCode);
                // Fallback to relay if no P2P connection within timeout
                this._p2pTimeout = setTimeout(() => {
                    if (!this.connected && this._fallbackUrl) {
                        dbg('NET: Captain P2P timeout, trying relay');
                        this._connectRelay();
                    }
                }, this._p2pFallbackDelay);
            });

            this.peer.on('connection', (conn) => {
                dbg('NET: Incoming connection from ' + conn.peer);
                this.conn = conn;
                this._setupConnection();
            });

            this.peer.on('error', (err) => {
                dbg('NET: Peer error: ' + err.type + ' ' + err.message);
                if (err.type === 'unavailable-id') {
                    // Room code collision — regenerate
                    this.roomCode = this.generateRoomCode();
                    this.peer.destroy();
                    this.createRoom(callback);
                }
            });
        }

        joinRoom(roomCode, callback) {
            this.role = 'stoker';
            this.roomCode = roomCode.toUpperCase();
            dbg('NET: Joining room ' + this.roomCode);

            this.peer = new Peer(null, {
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' }
                    ]
                }
            });

            this.peer.on('open', () => {
                dbg('NET: Stoker peer open, connecting to ' + this.roomCode);
                this.conn = this.peer.connect(this.roomCode, { reliable: false, serialization: 'binary' });
                this._setupConnection();
                if (callback) callback();

                // Fallback timer starts AFTER peer broker registration (inside on-open)
                this._p2pTimeout = setTimeout(() => {
                    if (!this.connected && this._fallbackUrl) {
                        dbg('NET: P2P timeout, trying relay');
                        this._connectRelay();
                    }
                }, this._p2pFallbackDelay);
            });

            this.peer.on('error', (err) => {
                dbg('NET: Join error: ' + err.type + ' ' + err.message);
                if (err.type === 'peer-unavailable') {
                    if (this.onDisconnected) this.onDisconnected('Room not found');
                }
            });
        }

        _setupConnection() {
            this.conn.on('open', () => {
                dbg('NET: Connection open! transport=p2p');
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
                dbg('NET: Connection closed');
                this._handleDisconnect();
            });

            this.conn.on('error', (err) => {
                dbg('NET: Connection error: ' + err);
            });
        }

        _handleMessage(data) {
            // Handle both ArrayBuffer and Uint8Array
            let bytes;
            if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data);
            } else if (data instanceof Uint8Array) {
                bytes = data;
            } else {
                // Fallback: try to handle as string for relay
                try {
                    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                    if (parsed.type === 'relay') {
                        bytes = new Uint8Array(parsed.data);
                    } else if (parsed.type === 'partner-ready') {
                        dbg('NET: Relay partner ready');
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
                        dbg('NET: Relay partner disconnected');
                        this._handleDisconnect();
                        return;
                    } else return;
                } catch (e) { return; }
            }

            if (bytes.length === 0) return;
            const type = bytes[0];

            if (type === MSG_PEDAL) {
                const foot = (bytes.length >= 2 && bytes[1] === 0x01) ? 'down' : 'up';
                if (this.onPedalReceived) this.onPedalReceived('stoker', foot);
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
                // Check for timeout
                if (performance.now() - this._lastRemoteHeartbeat > 3000) {
                    dbg('NET: Heartbeat timeout');
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

            // Auto-reconnect
            if (this._reconnectAttempts < this._maxReconnectAttempts) {
                this._reconnectAttempts++;
                const delay = Math.pow(2, this._reconnectAttempts - 1) * 1000;
                dbg('NET: Reconnecting in ' + delay + 'ms (attempt ' + this._reconnectAttempts + ')');
                setTimeout(() => {
                    if (!this.connected) this._attemptReconnect();
                }, delay);
            }
        }

        _attemptReconnect() {
            if (this.role === 'stoker' && this.roomCode) {
                dbg('NET: Attempting stoker reconnect to ' + this.roomCode);
                if (this.peer && !this.peer.destroyed) {
                    this.conn = this.peer.connect(this.roomCode, { reliable: false, serialization: 'binary' });
                    this._setupConnection();
                }
            } else if (this.role === 'captain') {
                dbg('NET: Captain attempting relay reconnect');
                if (this._fallbackUrl && (!this._relayWs || this._relayWs.readyState !== WebSocket.OPEN)) {
                    this._relayPartnerReady = false;
                    this._connectRelay();
                }
            }
        }

        _connectRelay() {
            if (!this._fallbackUrl) return;
            dbg('NET: Connecting to relay ' + this._fallbackUrl);
            this._relayPartnerReady = false;
            this._relayWs = new WebSocket(this._fallbackUrl + '?room=' + this.roomCode + '&role=' + this.role);

            this._relayWs.binaryType = 'arraybuffer';
            this._relayWs.onopen = () => {
                dbg('NET: Relay WebSocket open, waiting for partner-ready...');
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

    // ============================================================
    // PEDAL CONTROLLER
    // Processes rhythmic alternating pedal input
    // Future multiplayer: assign to Player 2
    // ============================================================
    class PedalController {
        constructor(input) {
            this.input = input;
            this.lastPedal = null;
            this.pedalPower = 0;
            this.crankAngle = 0;
            this.prevLeft = false;
            this.prevRight = false;
            this.lastPedalTime = 0;
            this.wasCorrect = false;
            this.wasWrong = false;
        }

        update(dt) {
            const now = performance.now() / 1000;
            const leftHeld = this.input.isPressed('ArrowUp');
            const rightHeld = this.input.isPressed('ArrowDown');
            const leftJust = leftHeld && !this.prevLeft;
            const rightJust = rightHeld && !this.prevRight;
            const braking = leftHeld && rightHeld;

            let acceleration = 0;
            let wobble = 0;
            this.wasCorrect = false;
            this.wasWrong = false;

            if (braking) {
                this.pedalPower *= 0.95;
                this.prevLeft = leftHeld;
                this.prevRight = rightHeld;
                return { acceleration: 0, wobble: 0, braking: true, crankAngle: this.crankAngle };
            }

            if (leftJust) {
                const gap = now - this.lastPedalTime;
                if (this.lastPedal !== 'left') {
                    this.wasCorrect = true;
                    const cadence = gap < 0.8 ? (0.8 - gap) * 0.4 : 0;
                    this.pedalPower = Math.min(this.pedalPower + 0.2 + cadence, 1.0);
                    acceleration = 0.35 + 0.6 * this.pedalPower;
                } else {
                    this.wasWrong = true;
                    this.pedalPower = Math.max(this.pedalPower - 0.15, 0);
                    acceleration = 0.06;
                    wobble = 0.5;
                }
                this.lastPedal = 'left';
                this.lastPedalTime = now;
                this.crankAngle += Math.PI / 2;
            }

            if (rightJust) {
                const gap = now - this.lastPedalTime;
                if (this.lastPedal !== 'right') {
                    this.wasCorrect = true;
                    const cadence = gap < 0.8 ? (0.8 - gap) * 0.4 : 0;
                    this.pedalPower = Math.min(this.pedalPower + 0.2 + cadence, 1.0);
                    acceleration = 0.35 + 0.6 * this.pedalPower;
                } else {
                    this.wasWrong = true;
                    this.pedalPower = Math.max(this.pedalPower - 0.15, 0);
                    acceleration = 0.06;
                    wobble = 0.5;
                }
                this.lastPedal = 'right';
                this.lastPedalTime = now;
                this.crankAngle += Math.PI / 2;
            }

            this.pedalPower *= (1 - 0.4 * dt);

            this.prevLeft = leftHeld;
            this.prevRight = rightHeld;

            return { acceleration, wobble, braking: false, crankAngle: this.crankAngle };
        }
    }

    // ============================================================
    // SHARED PEDAL CONTROLLER (Multiplayer)
    // Offset-aware two-foot tracking: captain + stoker coordinate
    // opposite feet on a shared crank (180° offset)
    // ============================================================
    class SharedPedalController {
        constructor() {
            this.pedalPower = 0;
            this.crankAngle = 0;
            this.wasCorrect = false;
            this.wasWrong = false;
            this.wasBrake = false;
            this.wasInPhase = false;
            this._pendingTaps = []; // queue of { source, foot, time }

            // Per-player tracking
            this.captainLastFoot = null;  // 'up' | 'down' | null
            this.captainLastTime = 0;
            this.stokerLastFoot = null;
            this.stokerLastTime = 0;

            // Running offset quality score (0-1)
            this.offsetScore = 0.5;
        }

        // Called when a tap is received (local or remote)
        receiveTap(source, foot) {
            this._pendingTaps.push({ source, foot, time: performance.now() / 1000 });
        }

        update(dt) {
            let acceleration = 0;
            let wobble = 0;
            this.wasCorrect = false;
            this.wasWrong = false;
            this.wasBrake = false;
            this.wasInPhase = false;

            // Check for simultaneous same-foot taps (within 100ms) = crank fight
            if (this._pendingTaps.length >= 2) {
                const t0 = this._pendingTaps[0];
                const t1 = this._pendingTaps[1];
                if (Math.abs(t0.time - t1.time) < 0.1 &&
                    t0.source !== t1.source &&
                    t0.foot === t1.foot) {
                    // Both players pressed same foot simultaneously — crank fight
                    this.wasBrake = true;
                    this.pedalPower *= 0.9;
                    this.offsetScore = Math.max(0, this.offsetScore - 0.15);
                    this._updatePlayerState(t0);
                    this._updatePlayerState(t1);
                    this._pendingTaps = [];
                    return { acceleration: 0, wobble: 0.8, braking: true, crankAngle: this.crankAngle };
                }
            }

            // Process taps one at a time
            while (this._pendingTaps.length > 0) {
                const tap = this._pendingTaps.shift();
                const playerLastFoot = tap.source === 'captain' ? this.captainLastFoot : this.stokerLastFoot;
                const otherLastFoot = tap.source === 'captain' ? this.stokerLastFoot : this.captainLastFoot;
                const gap = tap.time - (tap.source === 'captain' ? this.captainLastTime : this.stokerLastTime);

                if (playerLastFoot === tap.foot) {
                    // Player repeated their own foot — wrong foot penalty (same as solo)
                    this.wasWrong = true;
                    this.pedalPower = Math.max(this.pedalPower - 0.15, 0);
                    this.offsetScore = Math.max(0, this.offsetScore - 0.1);
                    acceleration += 0.06;
                    wobble += 0.5;
                } else if (otherLastFoot !== null && tap.foot === otherLastFoot) {
                    // Player's foot matches other player's last foot — in-phase (poor offset)
                    this.wasInPhase = true;
                    this.offsetScore = Math.max(0, this.offsetScore - 0.08);
                    const cadence = gap < 0.8 ? (0.8 - gap) * 0.3 : 0;
                    this.pedalPower = Math.min(this.pedalPower + 0.1 + cadence * 0.5, 1.0);
                    acceleration += 0.15 + 0.3 * this.pedalPower;
                    wobble += 0.2;
                } else {
                    // Player's foot is opposite other player's last foot — perfect offset!
                    // (also handles the case where otherLastFoot is null — first tap)
                    this.wasCorrect = true;
                    this.offsetScore = Math.min(1, this.offsetScore + 0.1);
                    const cadence = gap < 0.8 ? (0.8 - gap) * 0.4 : 0;
                    const offsetBonus = this.offsetScore * 0.15;
                    this.pedalPower = Math.min(this.pedalPower + 0.2 + cadence, 1.0);
                    acceleration += 0.35 + 0.6 * this.pedalPower + offsetBonus;
                }

                this._updatePlayerState(tap);
                this.crankAngle += Math.PI / 2;
            }

            // Decay
            this.pedalPower *= (1 - 0.4 * dt);
            this.offsetScore *= (1 - 0.05 * dt); // slow decay toward neutral

            return { acceleration, wobble, braking: false, crankAngle: this.crankAngle };
        }

        _updatePlayerState(tap) {
            if (tap.source === 'captain') {
                this.captainLastFoot = tap.foot;
                this.captainLastTime = tap.time;
            } else {
                this.stokerLastFoot = tap.foot;
                this.stokerLastTime = tap.time;
            }
        }
    }

    // ============================================================
    // BALANCE CONTROLLER
    // Processes lean input for balance
    // Desktop: A/D keys. Mobile: device motion tilt.
    // Future multiplayer: assign to Player 1
    // ============================================================
    class BalanceController {
        constructor(input) {
            this.input = input;
        }

        update() {
            let leanInput = 0;

            // Keyboard input (always active)
            if (this.input.isPressed('KeyA')) leanInput -= 1;
            if (this.input.isPressed('KeyD')) leanInput += 1;

            // Device motion input (mobile)
            const motion = this.input.getMotionLean();
            if (motion !== 0) {
                leanInput += motion;
            }

            // Clamp combined
            leanInput = Math.max(-1, Math.min(1, leanInput));

            return { leanInput };
        }
    }

    // ============================================================
    // RIDER COMPONENT
    // Visual rider - front and rear are separate for multiplayer
    // ============================================================
    class RiderComponent {
        constructor(seatZ, color, name) {
            this.name = name;
            this.seatZ = seatZ;
            this.group = new THREE.Group();

            const bodyMat = new THREE.MeshPhongMaterial({ color, flatShading: true });
            const skinMat = new THREE.MeshPhongMaterial({ color: 0xffcc99, flatShading: true });
            const pantsMat = new THREE.MeshPhongMaterial({ color: 0x334455, flatShading: true });
            const shoeMat = new THREE.MeshPhongMaterial({ color: 0x222222, flatShading: true });

            // Torso
            this.torso = this._box(0.35, 0.45, 0.22, bodyMat, 0, 1.32, seatZ);
            // Head
            this.head = this._box(0.2, 0.22, 0.2, skinMat, 0, 1.66, seatZ);
            // Helmet
            this._box(0.24, 0.12, 0.24, bodyMat, 0, 1.82, seatZ);

            // Left leg
            this.leftThigh = this._box(0.11, 0.3, 0.12, pantsMat, -0.1, 0.93, seatZ);
            this.leftShin = this._box(0.09, 0.25, 0.1, pantsMat, -0.1, 0.65, seatZ);
            this.leftFoot = this._box(0.09, 0.06, 0.16, shoeMat, -0.1, 0.48, seatZ + 0.03);

            // Right leg
            this.rightThigh = this._box(0.11, 0.3, 0.12, pantsMat, 0.1, 0.93, seatZ);
            this.rightShin = this._box(0.09, 0.25, 0.1, pantsMat, 0.1, 0.65, seatZ);
            this.rightFoot = this._box(0.09, 0.06, 0.16, shoeMat, 0.1, 0.48, seatZ + 0.03);
        }

        _box(w, h, d, mat, x, y, z) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
            mesh.position.set(x, y, z);
            mesh.castShadow = true;
            this.group.add(mesh);
            return mesh;
        }

        animatePedaling(crankAngle, speed) {
            const amp = Math.min(speed * 0.03, 0.14);
            const lOff = Math.sin(crankAngle) * amp;
            const rOff = Math.sin(crankAngle + Math.PI) * amp;

            this.leftThigh.position.y = 0.93 + lOff * 0.5;
            this.leftShin.position.y = 0.65 + lOff;
            this.leftFoot.position.y = 0.48 + lOff;
            this.leftFoot.position.z = this.seatZ + 0.03 + lOff * 0.3;

            this.rightThigh.position.y = 0.93 + rOff * 0.5;
            this.rightShin.position.y = 0.65 + rOff;
            this.rightFoot.position.y = 0.48 + rOff;
            this.rightFoot.position.z = this.seatZ + 0.03 + rOff * 0.3;

            this.torso.position.y = 1.32 + Math.abs(Math.sin(crankAngle * 2)) * 0.015;
        }
    }

    // ============================================================
    // TANDEM BIKE
    // Physics state + visual model
    // ============================================================
    class TandemBike {
        constructor(scene) {
            this.group = new THREE.Group();

            // Physics state
            this.position = new THREE.Vector3(0, 0, 0);
            this.heading = 0;
            this.lean = 0;
            this.leanVelocity = 0;
            this.speed = 0;
            this.distanceTraveled = 0;

            // Fall state
            this.fallen = false;
            this.fallTimer = 0;

            // Shared materials
            this.frameMat = new THREE.MeshPhongMaterial({ color: 0x22cc55, flatShading: true });
            this.metalMat = new THREE.MeshPhongMaterial({ color: 0x999999, flatShading: true });
            this.wheelMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a, flatShading: true });
            this.seatMat = new THREE.MeshPhongMaterial({ color: 0x333333, flatShading: true });

            this._buildFrame();
            this._buildWheels();

            // Riders (separate components for multiplayer)
            this.frontRider = new RiderComponent(0.5, 0x3388dd, 'front');
            this.rearRider = new RiderComponent(-0.5, 0xdd3344, 'rear');
            this.group.add(this.frontRider.group);
            this.group.add(this.rearRider.group);

            scene.add(this.group);
        }

        _addBox(w, h, d, mat, x, y, z, rx, ry, rz) {
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
            m.position.set(x, y, z);
            if (rx) m.rotation.x = rx;
            if (ry) m.rotation.y = ry;
            if (rz) m.rotation.z = rz;
            m.castShadow = true;
            this.group.add(m);
            return m;
        }

        _buildFrame() {
            this._addBox(0.06, 0.06, 2.2, this.frameMat, 0, 0.55, 0);
            this._addBox(0.05, 0.05, 1.5, this.frameMat, 0, 0.92, 0);
            this._addBox(0.05, 0.45, 0.05, this.frameMat, 0, 0.75, 0.45);
            this._addBox(0.05, 0.45, 0.05, this.frameMat, 0, 0.75, -0.45);
            this._addBox(0.2, 0.04, 0.22, this.seatMat, 0, 1.0, 0.45);
            this._addBox(0.2, 0.04, 0.22, this.seatMat, 0, 1.0, -0.45);
            this._addBox(0.04, 0.5, 0.04, this.metalMat, 0, 0.46, 1.02, 0.18);
            this._addBox(0.04, 0.5, 0.04, this.metalMat, 0, 0.46, -1.02, -0.18);
            this._addBox(0.05, 0.3, 0.05, this.metalMat, 0, 0.92, 0.82);
            this._addBox(0.5, 0.035, 0.035, this.metalMat, 0, 1.06, 0.86);
            this._addBox(0.07, 0.05, 0.05, this.seatMat, -0.26, 1.06, 0.86);
            this._addBox(0.07, 0.05, 0.05, this.seatMat, 0.26, 1.06, 0.86);
        }

        _buildWheels() {
            this.frontWheelSpin = new THREE.Group();
            this.rearWheelSpin = new THREE.Group();

            this._buildWheel(this.frontWheelSpin, 1.1);
            this._buildWheel(this.rearWheelSpin, -1.1);

            const fwg = new THREE.Group();
            fwg.position.set(0, 0.33, 1.1);
            fwg.add(this.frontWheelSpin);
            this.group.add(fwg);

            const rwg = new THREE.Group();
            rwg.position.set(0, 0.33, -1.1);
            rwg.add(this.rearWheelSpin);
            this.group.add(rwg);
        }

        _buildWheel(spinGroup, zPos) {
            const tire = new THREE.Mesh(
                new THREE.TorusGeometry(0.32, 0.045, 8, 24),
                this.wheelMat
            );
            tire.rotation.y = Math.PI / 2;
            tire.castShadow = true;
            spinGroup.add(tire);

            const hub = new THREE.Mesh(
                new THREE.CylinderGeometry(0.035, 0.035, 0.07, 8),
                this.metalMat
            );
            hub.rotation.z = Math.PI / 2;
            spinGroup.add(hub);

            for (let i = 0; i < 8; i++) {
                const spoke = new THREE.Mesh(
                    new THREE.BoxGeometry(0.012, 0.55, 0.012),
                    this.metalMat
                );
                spoke.rotation.x = (Math.PI / 8) * i;
                spinGroup.add(spoke);
            }
        }

        update(pedalResult, balanceResult, dt, safetyMode, autoSpeed) {
            if (this.fallen) {
                this.fallTimer -= dt;
                if (this.fallTimer <= 0) this._reset();
                this._applyTransform();
                return;
            }

            // --- Auto-speed: maintain a constant slow cruise ---
            if (autoSpeed && !pedalResult.braking) {
                const cruiseSpeed = 3.0;
                if (this.speed < cruiseSpeed) {
                    this.speed += 2.0 * dt;
                }
            }

            // --- Braking ---
            if (pedalResult.braking) {
                this.speed *= (1 - 2.5 * dt);
                if (this.speed < 0.05) this.speed = 0;
            }

            // --- Acceleration (impulse per pedal stroke, not continuous) ---
            this.speed += pedalResult.acceleration;

            // Friction
            this.speed *= (1 - 0.6 * dt);
            this.speed = Math.max(0, Math.min(this.speed, 16));

            // --- Balance physics ---
            const gravity = Math.sin(this.lean) * 4.0;
            const playerLean = balanceResult.leanInput * 16.0;
            const gyro = -this.lean * Math.min(this.speed * 0.6, 5.0);
            const damping = -this.leanVelocity * 2.2;

            const pedalWobble = pedalResult.wobble * (Math.random() - 0.5) * 2;

            const t = performance.now() / 1000;
            const lowSpeedWobble = Math.max(0, 1 - this.speed * 0.3) *
                (Math.sin(t * 2.7) * 0.3 + Math.sin(t * 4.3) * 0.15);

            let pedalLeanKick = 0;
            if (pedalResult.acceleration > 0 && !pedalResult.braking) {
                pedalLeanKick = (Math.random() - 0.5) * 0.2;
            }

            this.leanVelocity += (gravity + playerLean + gyro + damping +
                pedalWobble + lowSpeedWobble + pedalLeanKick) * dt;
            this.lean += this.leanVelocity * dt;

            // --- Safety mode: clamp lean so bike can never reach fall threshold ---
            if (safetyMode) {
                this.lean = Math.max(-0.9, Math.min(0.9, this.lean));
            }

            // --- Steering from lean ---
            const turnRate = -this.lean * this.speed * 0.35;
            this.heading += turnRate * dt;

            // --- Position ---
            this.position.x += Math.sin(this.heading) * this.speed * dt;
            this.position.z += Math.cos(this.heading) * this.speed * dt;
            this.distanceTraveled += this.speed * dt;

            // --- Fall detection ---
            if (Math.abs(this.lean) > 1.2) {
                this._fall();
            }

            // --- Wheel spin ---
            const spinRate = this.speed / 0.32;
            this.frontWheelSpin.rotation.x -= spinRate * dt;
            this.rearWheelSpin.rotation.x -= spinRate * dt;

            // --- Rider animation ---
            this.frontRider.animatePedaling(pedalResult.crankAngle, this.speed);
            this.rearRider.animatePedaling(pedalResult.crankAngle + Math.PI, this.speed);

            this._applyTransform();
        }

        _applyTransform() {
            this.group.position.copy(this.position);
            const q = new THREE.Quaternion();
            const qYaw = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0), this.heading
            );
            const qLean = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 0, 1), this.lean
            );
            q.multiplyQuaternions(qYaw, qLean);
            this.group.quaternion.copy(q);
        }

        _fall() {
            this.fallen = true;
            this.fallTimer = 2.0;
            this.speed = 0;
            this.lean = Math.sign(this.lean) * Math.PI / 2.2;
            this.leanVelocity = 0;
            this.position.y = -0.15;
        }

        _reset() {
            this.fallen = false;
            this.lean = 0;
            this.leanVelocity = 0;
            this.speed = 0;
            this.position.y = 0;
        }

        // Apply remote state from network (stoker-side, no physics)
        applyRemoteState(state) {
            this.position.set(state.x, state.y, state.z);
            this.heading = state.heading;
            this.lean = state.lean;
            this.leanVelocity = state.leanVelocity;
            this.speed = state.speed;
            this.distanceTraveled = state.distanceTraveled;
            this.fallen = !!(state.flags & 1);
            this._braking = !!(state.flags & 2);

            // Animate wheels
            const spinRate = this.speed / 0.32;
            const dt = 1 / 60; // approximate
            this.frontWheelSpin.rotation.x -= spinRate * dt;
            this.rearWheelSpin.rotation.x -= spinRate * dt;

            // Animate riders
            const crankAngle = state.crankAngle || 0;
            this.frontRider.animatePedaling(crankAngle, this.speed);
            this.rearRider.animatePedaling(crankAngle + Math.PI, this.speed);

            this._applyTransform();
        }
    }

    // ============================================================
    // REMOTE BIKE STATE (Stoker interpolation buffer)
    // Receives state at 20Hz, interpolates for 60fps rendering
    // ============================================================
    class RemoteBikeState {
        constructor() {
            this.prev = null;
            this.curr = null;
            this.receiveTime = 0;
            this.interpDuration = 0.05; // 50ms default, adapts to jitter
            this._lastReceiveDelta = 0.05;
        }

        pushState(state) {
            this.prev = this.curr;
            this.curr = state;
            const now = performance.now() / 1000;
            if (this.prev) {
                this._lastReceiveDelta = now - this.receiveTime;
                // Adaptive interpolation: clamp between 30-100ms
                this.interpDuration = Math.max(0.03, Math.min(0.1, this._lastReceiveDelta));
            }
            this.receiveTime = now;
        }

        getInterpolated() {
            if (!this.curr) return null;
            if (!this.prev) return this.curr;

            const now = performance.now() / 1000;
            const elapsed = now - this.receiveTime;
            const t = Math.min(1, elapsed / this.interpDuration);

            const lerp = (a, b, t) => a + (b - a) * t;
            return {
                x: lerp(this.prev.x, this.curr.x, t),
                y: lerp(this.prev.y, this.curr.y, t),
                z: lerp(this.prev.z, this.curr.z, t),
                heading: lerp(this.prev.heading, this.curr.heading, t),
                lean: lerp(this.prev.lean, this.curr.lean, t),
                leanVelocity: lerp(this.prev.leanVelocity, this.curr.leanVelocity, t),
                speed: lerp(this.prev.speed, this.curr.speed, t),
                crankAngle: lerp(this.prev.crankAngle, this.curr.crankAngle, t),
                distanceTraveled: lerp(this.prev.distanceTraveled, this.curr.distanceTraveled, t),
                flags: this.curr.flags
            };
        }
    }

    // ============================================================
    // CHASE CAMERA
    // Smooth third-person follow camera
    // ============================================================
    class ChaseCamera {
        constructor(camera) {
            this.camera = camera;
            this.smoothPos = 4.0;
            this.smoothLook = 5.0;
            this.currentPos = new THREE.Vector3(0, 3.5, -7);
            this.currentLook = new THREE.Vector3(0, 1.2, 3);
            this.shakeAmount = 0;
        }

        update(bike, dt) {
            const fwd = new THREE.Vector3(
                Math.sin(bike.heading), 0, Math.cos(bike.heading)
            );

            const desiredPos = bike.position.clone()
                .add(fwd.clone().multiplyScalar(-7))
                .add(new THREE.Vector3(0, 3.5, 0));
            desiredPos.y = Math.max(desiredPos.y, 1.5);

            const desiredLook = bike.position.clone()
                .add(fwd.clone().multiplyScalar(3))
                .add(new THREE.Vector3(0, 1.2, 0));

            const pLerp = 1 - Math.exp(-this.smoothPos * dt);
            const lLerp = 1 - Math.exp(-this.smoothLook * dt);
            this.currentPos.lerp(desiredPos, pLerp);
            this.currentLook.lerp(desiredLook, lLerp);

            const shake = new THREE.Vector3();
            if (this.shakeAmount > 0.001) {
                shake.set(
                    (Math.random() - 0.5) * this.shakeAmount,
                    (Math.random() - 0.5) * this.shakeAmount * 0.5,
                    (Math.random() - 0.5) * this.shakeAmount
                );
                this.shakeAmount *= (1 - 6 * dt);
            }

            this.camera.position.copy(this.currentPos).add(shake);
            this.camera.lookAt(this.currentLook);
        }
    }

    // ============================================================
    // Seeded PRNG (mulberry32)
    // ============================================================
    function mulberry32(seed) {
        let s = seed | 0;
        return function() {
            s = (s + 0x6D2B79F5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function seedFromString(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h + str.charCodeAt(i)) | 0;
        }
        return h;
    }

    // ============================================================
    // WORLD
    // Ground, road, environment
    // ============================================================
    class World {
        constructor(scene) {
            this.scene = scene;
            this._treeMeshes = [];
            this._buildGround();
            this._buildRoad();
            this._buildTrees();
            this._buildMarkers();
            this._buildLighting();
        }

        _buildGround() {
            const geo = new THREE.PlaneGeometry(600, 600, 1, 1);
            const mat = new THREE.MeshPhongMaterial({ color: 0x4a8a3a, flatShading: true });
            const ground = new THREE.Mesh(geo, mat);
            ground.rotation.x = -Math.PI / 2;
            ground.receiveShadow = true;
            this.scene.add(ground);

            const grid = new THREE.GridHelper(600, 300, 0x3d7530, 0x3d7530);
            grid.position.y = 0.01;
            grid.material.opacity = 0.3;
            grid.material.transparent = true;
            this.scene.add(grid);
        }

        _buildRoad() {
            const roadGeo = new THREE.PlaneGeometry(5, 600);
            const roadMat = new THREE.MeshPhongMaterial({ color: 0x555555, flatShading: true });
            const road = new THREE.Mesh(roadGeo, roadMat);
            road.rotation.x = -Math.PI / 2;
            road.position.y = 0.02;
            road.receiveShadow = true;
            this.scene.add(road);

            const dashMat = new THREE.MeshPhongMaterial({ color: 0xdddd00, flatShading: true });
            for (let z = -295; z < 300; z += 4) {
                const dash = new THREE.Mesh(
                    new THREE.PlaneGeometry(0.12, 1.8),
                    dashMat
                );
                dash.rotation.x = -Math.PI / 2;
                dash.position.set(0, 0.03, z);
                this.scene.add(dash);
            }

            const edgeMat = new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true });
            for (const xOff of [-2.3, 2.3]) {
                const edge = new THREE.Mesh(
                    new THREE.PlaneGeometry(0.1, 600),
                    edgeMat
                );
                edge.rotation.x = -Math.PI / 2;
                edge.position.set(xOff, 0.03, 0);
                this.scene.add(edge);
            }
        }

        _buildTrees(rng) {
            const rand = rng || Math.random;
            const trunkMat = new THREE.MeshPhongMaterial({ color: 0x7a5230, flatShading: true });
            const leafMat = new THREE.MeshPhongMaterial({ color: 0x2d8a2d, flatShading: true });
            const leafMat2 = new THREE.MeshPhongMaterial({ color: 0x1f7a1f, flatShading: true });

            for (let i = 0; i < 80; i++) {
                const side = rand() > 0.5 ? 1 : -1;
                const x = side * (5 + rand() * 50);
                const z = (rand() - 0.5) * 500;
                const scale = 0.7 + rand() * 0.8;

                const trunk = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.12 * scale, 0.18 * scale, 2.0 * scale, 6),
                    trunkMat
                );
                trunk.position.set(x, scale, z);
                trunk.castShadow = true;
                this.scene.add(trunk);
                this._treeMeshes.push(trunk);

                const mat = rand() > 0.5 ? leafMat : leafMat2;
                const canopy = new THREE.Mesh(
                    new THREE.SphereGeometry(1.0 * scale, 6, 5),
                    mat
                );
                canopy.position.set(x, 2.3 * scale, z);
                canopy.castShadow = true;
                this.scene.add(canopy);
                this._treeMeshes.push(canopy);
            }
        }

        rebuildTrees(seed) {
            // Remove old trees
            for (const mesh of this._treeMeshes) {
                this.scene.remove(mesh);
                mesh.geometry.dispose();
            }
            this._treeMeshes = [];
            // Rebuild with seeded PRNG
            this._buildTrees(mulberry32(seed));
        }

        _buildMarkers() {
            const markerMat = new THREE.MeshPhongMaterial({ color: 0xcc4444, flatShading: true });
            const poleMat = new THREE.MeshPhongMaterial({ color: 0xdddddd, flatShading: true });

            for (let z = 50; z <= 250; z += 50) {
                for (const xSide of [-3.5, 3.5]) {
                    const pole = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.04, 0.04, 1.5, 6),
                        poleMat
                    );
                    pole.position.set(xSide, 0.75, z);
                    pole.castShadow = true;
                    this.scene.add(pole);

                    const sign = new THREE.Mesh(
                        new THREE.BoxGeometry(0.6, 0.35, 0.05),
                        markerMat
                    );
                    sign.position.set(xSide, 1.6, z);
                    sign.castShadow = true;
                    this.scene.add(sign);
                }
            }
        }

        _buildLighting() {
            const ambient = new THREE.AmbientLight(0x5566aa, 0.5);
            this.scene.add(ambient);

            this.sun = new THREE.DirectionalLight(0xffffdd, 1.1);
            this.sun.position.set(30, 40, 20);
            this.sun.castShadow = true;
            this.sun.shadow.mapSize.width = isMobile ? 1024 : 2048;
            this.sun.shadow.mapSize.height = isMobile ? 1024 : 2048;
            this.sun.shadow.camera.near = 1;
            this.sun.shadow.camera.far = 120;
            this.sun.shadow.camera.left = -35;
            this.sun.shadow.camera.right = 35;
            this.sun.shadow.camera.top = 35;
            this.sun.shadow.camera.bottom = -35;
            this.scene.add(this.sun);
            this.scene.add(this.sun.target);

            const hemi = new THREE.HemisphereLight(0x99bbff, 0x44aa44, 0.35);
            this.scene.add(hemi);
        }

        updateSun(bikePos) {
            this.sun.position.set(bikePos.x + 30, 40, bikePos.z + 20);
            this.sun.target.position.copy(bikePos);
            this.sun.target.updateMatrixWorld();
        }
    }

    // ============================================================
    // HUD
    // On-screen display (desktop + mobile)
    // ============================================================
    class HUD {
        constructor(input) {
            this.input = input;
            this.speedEl = document.getElementById('speed');
            this.distanceEl = document.getElementById('distance');
            this.statusEl = document.getElementById('status');
            this.pedalL = document.getElementById('pedal-l');
            this.pedalR = document.getElementById('pedal-r');
            this.crashOverlay = document.getElementById('crash-overlay');
            this.instructions = document.getElementById('instructions');
            this.instructionsVisible = true;
            this.crashFlash = 0;

            // Dual gauges
            this.phoneNeedle = document.getElementById('phone-needle');
            this.phoneLabel = document.getElementById('phone-label');
            this.phoneGauge = document.getElementById('phone-gauge');
            this.bikeNeedle = document.getElementById('bike-needle');
            this.bikeLabel = document.getElementById('bike-label');

            // Hide phone gauge on desktop (no device motion)
            if (!isMobile) {
                this.phoneGauge.style.display = 'none';
            }

            // Mobile touch button elements
            this.touchLeftEl = document.getElementById('touch-left');
            this.touchRightEl = document.getElementById('touch-right');
        }

        update(bike, input, pedalCtrl, dt) {
            const kmh = Math.round(bike.speed * 3.6);
            this.speedEl.textContent = 'Speed: ' + kmh + ' km/h';
            this.distanceEl.textContent = 'Distance: ' + Math.round(bike.distanceTraveled) + ' m';

            const leftHeld = input.isPressed('ArrowUp');
            const rightHeld = input.isPressed('ArrowDown');
            const braking = leftHeld && rightHeld;

            // Desktop pedal indicators
            this.pedalL.className = 'pedal-key';
            this.pedalR.className = 'pedal-key';

            if (braking) {
                this.pedalL.className = 'pedal-key brake';
                this.pedalR.className = 'pedal-key brake';
            } else {
                if (leftHeld) {
                    this.pedalL.className = 'pedal-key ' + (pedalCtrl.wasWrong ? 'wrong' : 'active');
                }
                if (rightHeld) {
                    this.pedalR.className = 'pedal-key ' + (pedalCtrl.wasWrong ? 'wrong' : 'active');
                }
            }

            // Mobile touch button feedback
            if (isMobile && this.touchLeftEl && this.touchRightEl) {
                let lClass = 'touch-pedal touch-pedal-left';
                let rClass = 'touch-pedal touch-pedal-right';

                if (braking) {
                    lClass += ' brake';
                    rClass += ' brake';
                } else {
                    if (leftHeld) lClass += (pedalCtrl.wasWrong ? ' wrong' : ' pressed');
                    if (rightHeld) rClass += (pedalCtrl.wasWrong ? ' wrong' : ' pressed');
                }

                this.touchLeftEl.className = lClass;
                this.touchRightEl.className = rClass;
            }

            // Phone gauge — raw device tilt input
            if (isMobile) {
                const rawRel = input.motionRawRelative || 0;
                const phoneDeg = Math.max(-90, Math.min(90, rawRel));
                this.phoneNeedle.setAttribute('transform', 'rotate(' + phoneDeg.toFixed(1) + ', 60, 60)');
                this.phoneLabel.textContent = Math.abs(rawRel).toFixed(1) + '\u00B0';
            }

            // Bike gauge — actual lean angle
            const tiltDeg = (bike.lean * 180 / Math.PI);
            const bikeDeg = Math.max(-90, Math.min(90, tiltDeg));
            const danger = Math.abs(bike.lean) / 1.2;
            this.bikeNeedle.setAttribute('transform', 'rotate(' + bikeDeg.toFixed(1) + ', 60, 60)');
            this.bikeLabel.textContent = Math.abs(tiltDeg).toFixed(1) + '\u00B0';
            if (danger > 0.75) {
                this.bikeLabel.style.color = '#ff4444';
            } else if (danger > 0.5) {
                this.bikeLabel.style.color = '#ffaa22';
            } else {
                this.bikeLabel.style.color = '#ffffff';
            }

            // Status text
            if (bike.fallen) {
                this.statusEl.textContent = 'CRASHED! Resetting...';
                this.statusEl.style.color = '#ff4444';
            } else if (bike.speed < 0.3 && bike.distanceTraveled > 0.5) {
                this.statusEl.textContent = isMobile ? 'Tap \u2191 \u2193 to pedal!' : 'Pedal! Alternate \u2191 \u2193';
                this.statusEl.style.color = '#ffdd44';
            } else {
                this.statusEl.textContent = '';
            }

            // Crash flash
            if (bike.fallen && this.crashFlash === 0) {
                this.crashFlash = 1;
                this.crashOverlay.style.background = 'rgba(255, 0, 0, 0.35)';
            }
            if (this.crashFlash > 0) {
                this.crashFlash -= dt * 2;
                if (this.crashFlash <= 0) {
                    this.crashFlash = 0;
                    this.crashOverlay.style.background = 'rgba(255, 0, 0, 0)';
                }
            }

            // Instructions hiding is handled by the Game countdown state
        }
    }

    // ============================================================
    // GAME
    // Main loop orchestration — solo + multiplayer modes
    // ============================================================
    class Game {
        constructor() {
            _initDebug();
            dbg('Game init, isMobile=' + isMobile);
            this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile });
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            document.body.appendChild(this.renderer.domElement);

            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(0x7ec8e3);
            this.scene.fog = new THREE.FogExp2(0x7ec8e3, 0.006);

            this.camera = new THREE.PerspectiveCamera(
                60, window.innerWidth / window.innerHeight, 0.1, 500
            );

            this.input = new InputManager();
            this.pedalCtrl = new PedalController(this.input);
            this.balanceCtrl = new BalanceController(this.input);
            this.world = new World(this.scene);
            this.bike = new TandemBike(this.scene);
            this.chaseCamera = new ChaseCamera(this.camera);
            this.hud = new HUD(this.input);

            // Mode: 'solo' | 'captain' | 'stoker'
            this.mode = 'solo';
            this.net = null;
            this.sharedPedal = null;
            this.remoteBikeState = null;
            this.remoteLean = 0;  // stoker's lean input received by captain
            this._stateSendTimer = 0;
            this._stateSendInterval = 1 / 20; // 20Hz
            this._leanSendTimer = 0;
            this._leanSendInterval = 1 / 20; // 20Hz

            // Safety mode
            this.safetyMode = true;
            this.safetyBtn = document.getElementById('safety-btn');
            if (this.safetyBtn) {
                this.safetyBtn.addEventListener('click', () => {
                    this.safetyMode = !this.safetyMode;
                    this.safetyBtn.textContent = 'SAFETY: ' + (this.safetyMode ? 'ON' : 'OFF');
                    this.safetyBtn.className = this.safetyMode ? '' : 'off';
                });
            }

            // Auto-speed mode
            this.autoSpeed = false;
            this.speedBtn = document.getElementById('speed-btn');
            if (this.speedBtn) {
                this.speedBtn.addEventListener('click', () => {
                    this.autoSpeed = !this.autoSpeed;
                    this.speedBtn.textContent = 'SPEED: ' + (this.autoSpeed ? 'ON' : 'OFF');
                    this.speedBtn.className = this.autoSpeed ? '' : 'off';
                });
            }

            // Countdown / game state
            this.state = 'lobby';  // 'lobby' | 'waiting' | 'countdown' | 'playing'
            this.countdownTimer = 0;
            this.countdownOverlay = document.getElementById('countdown-overlay');
            this.countdownNumber = document.getElementById('countdown-number');
            this.countdownLabel = document.getElementById('countdown-label');
            this.lastCountdownNum = 0;

            // Audio context for countdown beeps (created on first user interaction)
            this.audioCtx = null;

            this.lastTime = performance.now();

            window.addEventListener('resize', () => this._onResize());

            // Edge-detection state for multiplayer pedal input
            this._mpPrevUp = false;
            this._mpPrevDown = false;

            // Setup lobby UI
            this._setupLobby();

            // Tap anywhere to start (dismiss intro card + request iOS motion permission)
            const startHandler = (e) => {
                if (this.state === 'waiting') {
                    e.preventDefault();
                    dbg('startHandler: needsPerm=' + this.input.needsMotionPermission +
                        ' motionEnabled=' + this.input.motionEnabled);
                    if (this.input.needsMotionPermission && !this.input.motionEnabled &&
                        typeof DeviceMotionEvent !== 'undefined' &&
                        typeof DeviceMotionEvent.requestPermission === 'function') {
                        this.input.needsMotionPermission = false;
                        dbg('calling requestPermission (sync)...');
                        DeviceMotionEvent.requestPermission().then((response) => {
                            dbg('permission response=' + response);
                            if (response === 'granted') {
                                this.input._startMotionListening();
                            } else {
                                this.input._showMotionDenied();
                            }
                        }).catch((err) => {
                            dbg('permission error=' + err.message);
                            this.input._showMotionDenied();
                        });
                    }
                    this._startCountdown();
                }
            };
            document.getElementById('instructions').addEventListener('click', startHandler);
            document.getElementById('instructions').addEventListener('touchstart', startHandler, { passive: false });

            // Reset button
            document.getElementById('reset-btn').addEventListener('click', () => {
                if (isMobile && !this.input.motionEnabled &&
                    typeof DeviceMotionEvent !== 'undefined' &&
                    typeof DeviceMotionEvent.requestPermission === 'function') {
                    DeviceMotionEvent.requestPermission().then((response) => {
                        if (response === 'granted') this.input._startMotionListening();
                    }).catch(() => {});
                }
                this._resetGame();
            });

            if (isMobile && screen.orientation && screen.orientation.lock) {
                screen.orientation.lock('landscape').catch(() => {});
            }

            this._loop();
        }

        // ============================================================
        // LOBBY SETUP
        // ============================================================
        _setupLobby() {
            const lobby = document.getElementById('lobby');
            const modeStep = document.getElementById('lobby-mode');
            const roleStep = document.getElementById('lobby-role');
            const hostStep = document.getElementById('lobby-host');
            const joinStep = document.getElementById('lobby-join');

            const showStep = (step) => {
                [modeStep, roleStep, hostStep, joinStep].forEach(s => s.style.display = 'none');
                step.style.display = 'block';
            };

            // SOLO
            document.getElementById('btn-solo').addEventListener('click', () => {
                this.mode = 'solo';
                lobby.style.display = 'none';
                this._startSoloMode();
            });

            // RIDE TOGETHER
            document.getElementById('btn-together').addEventListener('click', () => {
                showStep(roleStep);
            });

            // Back buttons
            document.getElementById('btn-back-mode').addEventListener('click', () => {
                showStep(modeStep);
            });
            document.getElementById('btn-back-role-host').addEventListener('click', () => {
                if (this.net) { this.net.destroy(); this.net = null; }
                showStep(roleStep);
            });
            document.getElementById('btn-back-role-join').addEventListener('click', () => {
                if (this.net) { this.net.destroy(); this.net = null; }
                showStep(roleStep);
            });

            // CAPTAIN
            document.getElementById('btn-captain').addEventListener('click', () => {
                this.mode = 'captain';
                showStep(hostStep);
                this._createRoom();
            });

            // STOKER
            document.getElementById('btn-stoker').addEventListener('click', () => {
                this.mode = 'stoker';
                showStep(joinStep);
                document.getElementById('room-code-input').focus();
            });

            // JOIN
            document.getElementById('btn-join').addEventListener('click', () => {
                const code = document.getElementById('room-code-input').value.trim().toUpperCase();
                if (code.length >= 4) {
                    this._joinRoom(code);
                }
            });

            // Enter key on room code input
            document.getElementById('room-code-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    document.getElementById('btn-join').click();
                }
            });

            // Disconnect overlay — return to lobby
            document.getElementById('btn-return-lobby').addEventListener('click', () => {
                document.getElementById('disconnect-overlay').style.display = 'none';
                this._returnToLobby();
            });
        }

        _createRoom() {
            this.net = new NetworkManager();
            this.net._fallbackUrl = 'wss://tandemonium-relay.pete-872.workers.dev';
            const statusEl = document.getElementById('host-status');
            const codeEl = document.getElementById('room-code-display');

            statusEl.textContent = 'Creating room...';
            statusEl.className = 'conn-status';

            this.net.createRoom((code) => {
                codeEl.textContent = code;
                statusEl.textContent = 'Waiting for partner...';
            });

            this.net.onConnected = () => {
                statusEl.textContent = 'Partner connected!';
                statusEl.className = 'conn-status connected';
                setTimeout(() => this._startMultiplayerGame(), 1000);
            };

            this.net.onDisconnected = (reason) => {
                if (this.state === 'lobby') {
                    statusEl.textContent = reason || 'Disconnected';
                    statusEl.className = 'conn-status error';
                } else {
                    this._showDisconnect(reason);
                }
            };
        }

        _joinRoom(code) {
            this.net = new NetworkManager();
            this.net._fallbackUrl = 'wss://tandemonium-relay.pete-872.workers.dev';
            const statusEl = document.getElementById('join-status');

            statusEl.textContent = 'Connecting...';
            statusEl.className = 'conn-status';

            this.net.joinRoom(code, () => {
                statusEl.textContent = 'Connecting to room...';
            });

            this.net.onConnected = () => {
                statusEl.textContent = 'Connected!';
                statusEl.className = 'conn-status connected';
                setTimeout(() => this._startMultiplayerGame(), 1000);
            };

            this.net.onDisconnected = (reason) => {
                if (this.state === 'lobby') {
                    statusEl.textContent = reason || 'Could not connect';
                    statusEl.className = 'conn-status error';
                } else {
                    this._showDisconnect(reason);
                }
            };
        }

        _startMultiplayerGame() {
            const lobby = document.getElementById('lobby');
            lobby.style.display = 'none';
            document.body.classList.add('mp-mode');

            // Rebuild trees with deterministic seed from room code
            if (this.net && this.net.roomCode) {
                const seed = seedFromString(this.net.roomCode);
                this.world.rebuildTrees(seed);
            }

            // Setup shared pedal controller
            this.sharedPedal = new SharedPedalController();

            // Setup remote bike state for stoker
            if (this.mode === 'stoker') {
                this.remoteBikeState = new RemoteBikeState();
            }

            // Setup network callbacks
            this.net.onPedalReceived = (source, foot) => {
                if (this.mode === 'captain' && this.sharedPedal) {
                    this.sharedPedal.receiveTap('stoker', foot);
                }
            };

            this.net.onStateReceived = (state) => {
                if (this.mode === 'stoker' && this.remoteBikeState) {
                    this.remoteBikeState.pushState(state);
                }
            };

            this.net.onLeanReceived = (leanValue) => {
                if (this.mode === 'captain') {
                    this.remoteLean = leanValue;
                }
            };

            this.net.onEventReceived = (eventType) => {
                if (eventType === EVT_COUNTDOWN) {
                    this._startCountdown();
                } else if (eventType === EVT_START) {
                    this.state = 'playing';
                    // Dismiss countdown overlay (stoker receives this from captain)
                    this.countdownNumber.textContent = 'GO!';
                    this.countdownNumber.className = 'go';
                    this.countdownLabel.textContent = '';
                    this.countdownNumber.style.animation = 'none';
                    void this.countdownNumber.offsetHeight;
                    this.countdownNumber.style.animation = 'countdown-pop 0.6s ease-out';
                    this._playBeep(800, 0.4);
                    setTimeout(() => { this.countdownOverlay.classList.remove('active'); }, 700);
                } else if (eventType === EVT_RESET) {
                    this._resetGame();
                }
            };

            // Show connection badge
            document.getElementById('conn-badge').style.display = 'block';

            // Update instructions for multiplayer
            this._showMpInstructions();

            // Show instructions (waiting for tap to start)
            this.state = 'waiting';
        }

        _showMpInstructions() {
            const inst = document.getElementById('instructions');
            inst.style.display = 'flex';
            inst.style.opacity = '1';

            // Hide solo controls, show mp controls
            const desktopCtrl = inst.querySelector('.desktop-controls');
            const mobileCtrl = inst.querySelector('.mobile-controls');
            const mpCtrl = inst.querySelector('.mp-controls');

            if (desktopCtrl) desktopCtrl.style.display = 'none';
            if (mobileCtrl) mobileCtrl.style.display = 'none';
            if (mpCtrl) mpCtrl.style.display = 'block';

            const roleLabel = document.getElementById('mp-role-label');
            if (this.mode === 'captain') {
                roleLabel.textContent = 'You are the CAPTAIN (front seat)';
                roleLabel.className = 'role-label-hud captain';
            } else {
                roleLabel.textContent = 'You are the STOKER (back seat)';
                roleLabel.className = 'role-label-hud stoker';
            }
        }

        _startSoloMode() {
            // Show instructions as in original
            const inst = document.getElementById('instructions');
            inst.style.display = 'flex';
            inst.style.opacity = '1';

            // Make sure solo controls are visible
            const desktopCtrl = inst.querySelector('.desktop-controls');
            const mobileCtrl = inst.querySelector('.mobile-controls');
            const mpCtrl = inst.querySelector('.mp-controls');
            if (desktopCtrl) desktopCtrl.style.display = isMobile ? 'none' : 'block';
            if (mobileCtrl) mobileCtrl.style.display = isMobile ? 'block' : 'none';
            if (mpCtrl) mpCtrl.style.display = 'none';

            this.state = 'waiting';
        }

        _showDisconnect(reason) {
            const overlay = document.getElementById('disconnect-overlay');
            const msg = document.getElementById('disconnect-msg');
            overlay.style.display = 'flex';
            msg.textContent = reason || 'Partner disconnected';

            // If stoker, auto-pedal kicks in on captain side (nothing to do here)
            // If captain, stoker's pedal stops — captain can still play solo-ish
        }

        _returnToLobby() {
            if (this.net) { this.net.destroy(); this.net = null; }
            this.mode = 'solo';
            this.sharedPedal = null;
            this.remoteBikeState = null;
            this.remoteLean = 0;
            document.body.classList.remove('mp-mode');
            document.getElementById('conn-badge').style.display = 'none';

            // Reset bike
            this.bike._reset();
            this.bike.position.set(0, 0, 0);
            this.bike.heading = 0;
            this.bike.distanceTraveled = 0;
            this.bike._applyTransform();

            // Show lobby
            const lobby = document.getElementById('lobby');
            lobby.style.display = 'flex';
            document.getElementById('lobby-mode').style.display = 'block';
            document.getElementById('lobby-role').style.display = 'none';
            document.getElementById('lobby-host').style.display = 'none';
            document.getElementById('lobby-join').style.display = 'none';

            // Hide instructions and game overlays
            document.getElementById('instructions').style.display = 'none';
            this.countdownOverlay.classList.remove('active');

            this.state = 'lobby';
        }

        // ============================================================
        // COUNTDOWN / AUDIO / RESET
        // ============================================================
        _startCountdown() {
            this.state = 'countdown';
            this.countdownTimer = 3.0;
            this.lastCountdownNum = 4;
            this.countdownOverlay.classList.add('active');
            this.countdownNumber.className = '';
            this.countdownNumber.textContent = '3';
            this.countdownLabel.textContent = 'Get Ready';

            // Hide instructions
            const inst = document.getElementById('instructions');
            if (inst) {
                inst.style.opacity = '0';
                setTimeout(() => { inst.style.display = 'none'; }, 800);
            }

            // Init audio context
            try {
                if (!this.audioCtx) {
                    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                }
                this._playBeep(400, 0.15);
            } catch (e) {
                console.warn('Audio not available:', e);
            }

            // Captain notifies stoker
            if (this.mode === 'captain' && this.net) {
                this.net.sendEvent(EVT_COUNTDOWN);
            }
        }

        _playBeep(freq, duration) {
            try {
                if (!this.audioCtx) return;
                const ctx = this.audioCtx;
                if (ctx.state === 'suspended') ctx.resume();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = freq;
                osc.type = 'square';
                gain.gain.setValueAtTime(0.12, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + duration);
            } catch (e) {}
        }

        _resetGame() {
            this.bike._reset();
            this.bike.position.set(0, 0, 0);
            this.bike.heading = 0;
            this.bike.distanceTraveled = 0;
            this.bike._applyTransform();

            if (this.mode === 'solo') {
                this.pedalCtrl.lastPedal = null;
                this.pedalCtrl.pedalPower = 0;
                this.pedalCtrl.crankAngle = 0;
                this.pedalCtrl.prevLeft = false;
                this.pedalCtrl.prevRight = false;
            } else if (this.sharedPedal) {
                this.sharedPedal.captainLastFoot = null;
                this.sharedPedal.captainLastTime = 0;
                this.sharedPedal.stokerLastFoot = null;
                this.sharedPedal.stokerLastTime = 0;
                this.sharedPedal.pedalPower = 0;
                this.sharedPedal.crankAngle = 0;
                this.sharedPedal.offsetScore = 0.5;
                this.sharedPedal._pendingTaps = [];
            }

            if (this.input.motionEnabled) {
                this.input.motionOffset = this.input.rawGamma;
            }

            // Captain notifies stoker of reset
            if (this.mode === 'captain' && this.net) {
                this.net.sendEvent(EVT_RESET);
            }

            this._startCountdown();
        }

        _onResize() {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        }

        // ============================================================
        // MAIN LOOP
        // ============================================================
        _loop() {
            requestAnimationFrame(() => this._loop());

            const now = performance.now();
            let dt = (now - this.lastTime) / 1000;
            this.lastTime = now;
            dt = Math.min(dt, 0.05);

            // --- Lobby: just render the scene ---
            if (this.state === 'lobby') {
                this.chaseCamera.update(this.bike, dt);
                this.world.updateSun(this.bike.position);
                this.renderer.render(this.scene, this.camera);
                return;
            }

            // --- Waiting state ---
            if (this.state === 'waiting') {
                if (this.mode === 'solo') {
                    if (this.input.isPressed('ArrowUp') || this.input.isPressed('ArrowDown')) {
                        this._startCountdown();
                    }
                }
                // In multiplayer, waiting for captain to tap start on instructions
                this.chaseCamera.update(this.bike, dt);
                this.world.updateSun(this.bike.position);
                this.hud.update(this.bike, this.input, this.pedalCtrl, dt);
                this.renderer.render(this.scene, this.camera);
                return;
            }

            // --- Countdown state ---
            if (this.state === 'countdown') {
                this.countdownTimer -= dt;
                const num = Math.ceil(this.countdownTimer);

                if (this.countdownTimer <= 0) {
                    this.state = 'playing';
                    this.bike.lean = 0;
                    this.bike.leanVelocity = 0;
                    this.bike._applyTransform();
                    this.countdownNumber.textContent = 'GO!';
                    this.countdownNumber.className = 'go';
                    this.countdownLabel.textContent = '';
                    this.countdownNumber.style.animation = 'none';
                    void this.countdownNumber.offsetHeight;
                    this.countdownNumber.style.animation = 'countdown-pop 0.6s ease-out';
                    this._playBeep(800, 0.4);
                    setTimeout(() => { this.countdownOverlay.classList.remove('active'); }, 700);

                    if (this.mode === 'captain' && this.net) {
                        this.net.sendEvent(EVT_START);
                    }
                } else if (num !== this.lastCountdownNum) {
                    this.lastCountdownNum = num;
                    this.countdownNumber.textContent = String(num);
                    this.countdownNumber.className = '';
                    this.countdownLabel.textContent = num === 1 ? 'Go!' : 'Get Ready';
                    this.countdownNumber.style.animation = 'none';
                    void this.countdownNumber.offsetHeight;
                    this.countdownNumber.style.animation = 'countdown-pop 0.6s ease-out';
                    this._playBeep(400, 0.15);
                }

                // Let captain practice tilt during countdown
                if (this.mode !== 'stoker') {
                    const previewBalance = this.balanceCtrl.update();
                    const previewLean = previewBalance.leanInput * 11.0;
                    const previewDamp = -this.bike.leanVelocity * 3.5;
                    this.bike.leanVelocity += (previewLean + previewDamp) * dt;
                    this.bike.lean += this.bike.leanVelocity * dt;
                    this.bike.lean = Math.max(-0.9, Math.min(0.9, this.bike.lean));
                    this.bike._applyTransform();
                }

                this.chaseCamera.update(this.bike, dt);
                this.world.updateSun(this.bike.position);
                this.hud.update(this.bike, this.input, this.pedalCtrl, dt);
                this.renderer.render(this.scene, this.camera);
                return;
            }

            // --- Playing state ---
            if (this.mode === 'solo') {
                this._updateSolo(dt);
            } else if (this.mode === 'captain') {
                this._updateCaptain(dt);
            } else if (this.mode === 'stoker') {
                this._updateStoker(dt);
            }
        }

        // ============================================================
        // SOLO UPDATE (unchanged from original)
        // ============================================================
        _updateSolo(dt) {
            const wasFallen = this.bike.fallen;
            const pedalResult = this.pedalCtrl.update(dt);
            const balanceResult = this.balanceCtrl.update();
            this.bike.update(pedalResult, balanceResult, dt, this.safetyMode, this.autoSpeed);

            if (wasFallen && !this.bike.fallen && this.input.motionEnabled) {
                this.input.motionOffset = this.input.rawGamma;
            }
            if (this.bike.speed > 8) {
                this.chaseCamera.shakeAmount = Math.max(
                    this.chaseCamera.shakeAmount, (this.bike.speed - 8) * 0.008);
            }
            if (this.bike.fallen) this.chaseCamera.shakeAmount = 0.15;

            this.chaseCamera.update(this.bike, dt);
            this.world.updateSun(this.bike.position);
            this.hud.update(this.bike, this.input, this.pedalCtrl, dt);
            this.renderer.render(this.scene, this.camera);
        }

        // ============================================================
        // CAPTAIN UPDATE (runs physics, sends state)
        // ============================================================
        _updateCaptain(dt) {
            const wasFallen = this.bike.fallen;

            // Edge detection: detect ArrowUp/ArrowDown rising edges
            const upHeld = this.input.isPressed('ArrowUp');
            const downHeld = this.input.isPressed('ArrowDown');
            if (upHeld && !this._mpPrevUp) {
                this.sharedPedal.receiveTap('captain', 'up');
            }
            if (downHeld && !this._mpPrevDown) {
                this.sharedPedal.receiveTap('captain', 'down');
            }
            this._mpPrevUp = upHeld;
            this._mpPrevDown = downHeld;

            // Use shared pedal controller instead of solo
            const pedalResult = this.sharedPedal.update(dt);
            const balanceResult = this.balanceCtrl.update();

            // Merge stoker's lean input — both riders affect balance
            // Captain's lean + stoker's lean, averaged (each rider has equal weight)
            balanceResult.leanInput = Math.max(-1, Math.min(1,
                (balanceResult.leanInput + this.remoteLean) * 0.5
            ));

            // Track crank angle on bike for state sending
            this.bike.crankAngle = this.sharedPedal.crankAngle;
            this.bike._braking = pedalResult.braking;

            this.bike.update(pedalResult, balanceResult, dt, this.safetyMode, this.autoSpeed);

            if (wasFallen && !this.bike.fallen && this.input.motionEnabled) {
                this.input.motionOffset = this.input.rawGamma;
            }
            if (this.bike.speed > 8) {
                this.chaseCamera.shakeAmount = Math.max(
                    this.chaseCamera.shakeAmount, (this.bike.speed - 8) * 0.008);
            }
            if (this.bike.fallen) this.chaseCamera.shakeAmount = 0.15;

            // Send state to stoker at 20Hz
            this._stateSendTimer += dt;
            if (this._stateSendTimer >= this._stateSendInterval && this.net && this.net.connected) {
                this._stateSendTimer = 0;
                this.net.sendState(this.bike);
            }

            // Update connection badge
            this._updateConnBadge();

            // Update MP pedal button feedback
            this._updateMpPedalFeedback(pedalResult);

            this.chaseCamera.update(this.bike, dt);
            this.world.updateSun(this.bike.position);
            this.hud.update(this.bike, this.input, this.sharedPedal, dt);
            this.renderer.render(this.scene, this.camera);
        }

        // ============================================================
        // STOKER UPDATE (receives state, interpolates, renders)
        // ============================================================
        _updateStoker(dt) {
            // Edge detection: detect ArrowUp/ArrowDown rising edges → send over network
            const upHeld = this.input.isPressed('ArrowUp');
            const downHeld = this.input.isPressed('ArrowDown');
            if (upHeld && !this._mpPrevUp && this.net) {
                this.net.sendPedal('up');
            }
            if (downHeld && !this._mpPrevDown && this.net) {
                this.net.sendPedal('down');
            }
            this._mpPrevUp = upHeld;
            this._mpPrevDown = downHeld;

            const state = this.remoteBikeState ? this.remoteBikeState.getInterpolated() : null;

            if (state) {
                this.bike.applyRemoteState(state);
            }

            // Send stoker's lean input to captain at 20Hz
            this._leanSendTimer += dt;
            if (this._leanSendTimer >= this._leanSendInterval && this.net && this.net.connected) {
                this._leanSendTimer = 0;
                const balanceResult = this.balanceCtrl.update();
                this.net.sendLean(balanceResult.leanInput);
            }

            if (this.bike.speed > 8) {
                this.chaseCamera.shakeAmount = Math.max(
                    this.chaseCamera.shakeAmount, (this.bike.speed - 8) * 0.008);
            }
            if (this.bike.fallen) this.chaseCamera.shakeAmount = 0.15;

            // Update connection badge
            this._updateConnBadge();

            this.chaseCamera.update(this.bike, dt);
            this.world.updateSun(this.bike.position);
            this.hud.update(this.bike, this.input, this.pedalCtrl, dt);
            this.renderer.render(this.scene, this.camera);
        }

        _updateConnBadge() {
            if (!this.net) return;
            const typeEl = document.getElementById('conn-type');
            const pingEl = document.getElementById('conn-ping');
            if (typeEl) typeEl.textContent = this.net.transport === 'relay' ? 'RELAY' : 'P2P';
            if (pingEl) pingEl.textContent = Math.round(this.net.pingMs) + 'ms';
        }

        _updateMpPedalFeedback(pedalResult) {
            const leftEl = document.getElementById('touch-left');
            const rightEl = document.getElementById('touch-right');
            const pedalL = document.getElementById('pedal-l');
            const pedalR = document.getElementById('pedal-r');
            const upHeld = this.input.isPressed('ArrowUp');
            const downHeld = this.input.isPressed('ArrowDown');

            // Touch button feedback
            if (leftEl && rightEl) {
                let lClass = 'touch-pedal touch-pedal-left';
                let rClass = 'touch-pedal touch-pedal-right';

                if (this.sharedPedal && this.sharedPedal.wasBrake) {
                    if (upHeld) lClass += ' brake';
                    if (downHeld) rClass += ' brake';
                } else if (this.sharedPedal && this.sharedPedal.wasWrong) {
                    if (upHeld) lClass += ' wrong';
                    if (downHeld) rClass += ' wrong';
                } else if (this.sharedPedal && this.sharedPedal.wasInPhase) {
                    if (upHeld) lClass += ' wrong';
                    if (downHeld) rClass += ' wrong';
                } else {
                    if (upHeld) lClass += ' pressed';
                    if (downHeld) rClass += ' pressed';
                }

                leftEl.className = lClass;
                rightEl.className = rClass;
            }

            // Desktop pedal indicators
            if (pedalL && pedalR) {
                pedalL.className = 'pedal-key';
                pedalR.className = 'pedal-key';

                if (this.sharedPedal && this.sharedPedal.wasBrake) {
                    if (upHeld) pedalL.className = 'pedal-key brake';
                    if (downHeld) pedalR.className = 'pedal-key brake';
                } else if (this.sharedPedal && (this.sharedPedal.wasWrong || this.sharedPedal.wasInPhase)) {
                    if (upHeld) pedalL.className = 'pedal-key wrong';
                    if (downHeld) pedalR.className = 'pedal-key wrong';
                } else {
                    if (upHeld) pedalL.className = 'pedal-key active';
                    if (downHeld) pedalR.className = 'pedal-key active';
                }
            }
        }
    }

    // ============================================================
    // START
    // ============================================================
    window.addEventListener('load', () => {
        window._game = new Game();
    });

})();
