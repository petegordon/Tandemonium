// ============================================================
// GAME — orchestrator + boot (entry point)
// ============================================================

import * as THREE from 'three';
import { isMobile, EVT_COUNTDOWN, EVT_START, EVT_RESET } from './config.js';
import { InputManager } from './input-manager.js';
import { PedalController } from './pedal-controller.js';
import { SharedPedalController } from './shared-pedal-controller.js';
import { BalanceController } from './balance-controller.js';
import { BikeModel } from './bike-model.js';
import { RemoteBikeState } from './remote-bike-state.js';
import { ChaseCamera } from './chase-camera.js';
import { World } from './world.js';
import { HUD } from './hud.js';
import { GrassParticles } from './grass-particles.js';
import { Lobby } from './lobby.js';

class Game {
  constructor() {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.prepend(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x7ec8e3);
    this.scene.fog = new THREE.FogExp2(0x7ec8e3, 0.006);

    // Camera (FOV 70 for portrait)
    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 500
    );

    // Components
    this.input = new InputManager();
    this.pedalCtrl = new PedalController(this.input);
    this.balanceCtrl = new BalanceController(this.input);
    this.world = new World(this.scene);
    this.bike = new BikeModel(this.scene);
    this.bike.roadPath = this.world.roadPath;
    this.chaseCamera = new ChaseCamera(this.camera);
    this.hud = new HUD(this.input);
    this.grassParticles = new GrassParticles(this.scene);

    // Mode
    this.mode = 'solo'; // 'solo' | 'captain' | 'stoker'
    this.net = null;
    this.sharedPedal = null;
    this.remoteBikeState = null;
    this.remoteLean = 0;
    this._remoteLastFoot = null;
    this._remoteLastTapTime = 0;
    this._stateSendTimer = 0;
    this._stateSendInterval = 1 / 20; // 20Hz
    this._leanSendTimer = 0;
    this._leanSendInterval = 1 / 20; // 20Hz
    this._mpPrevUp = false;
    this._mpPrevDown = false;

    // D-pad edge detection for gameplay buttons
    this._dpadPrevUp = false;
    this._dpadPrevDown = false;
    this._dpadPrevLeft = false;
    this._dpadPrevRight = false;

    // Safety mode (on by default)
    this.safetyMode = true;
    this.safetyBtn = document.getElementById('safety-btn');
    this.safetyBtn.addEventListener('click', () => {
      this.safetyMode = !this.safetyMode;
      this.safetyBtn.className = 'side-btn ' + (this.safetyMode ? 'safety-on' : 'safety-off');
      this.safetyBtn.textContent = 'SAFETY\n' + (this.safetyMode ? 'ON' : 'OFF');
    });

    // Speed mode (off by default)
    this.autoSpeed = false;
    this.speedBtn = document.getElementById('speed-btn');
    this.speedBtn.addEventListener('click', () => {
      this.autoSpeed = !this.autoSpeed;
      this.speedBtn.className = 'side-btn ' + (this.autoSpeed ? 'speed-on' : 'speed-off');
      this.speedBtn.textContent = this.autoSpeed ? 'ON\nSPEED' : 'SPEED';
    });

    // Reset button
    document.getElementById('reset-btn').addEventListener('click', () => {
      this._resetGame();
    });

    // Lobby button
    document.getElementById('lobby-btn').addEventListener('click', () => {
      this._returnToLobby();
    });

    // Try Again from disconnect overlay
    document.getElementById('btn-try-reconnect').addEventListener('click', () => {
      document.getElementById('disconnect-overlay').style.display = 'none';
      if (this.net) this.net.retryConnection();
    });

    // Return to lobby from disconnect overlay
    document.getElementById('btn-return-lobby').addEventListener('click', () => {
      document.getElementById('disconnect-overlay').style.display = 'none';
      this._returnToLobby();
    });

    // Game state
    this.state = 'lobby'; // 'lobby' | 'instructions' | 'countdown' | 'playing'
    this.countdownTimer = 0;
    this._lastCountNum = 3;
    this.instructionsEl = document.getElementById('instructions');
    this.audioCtx = null;

    // Lobby
    this.lobby = new Lobby({
      onSolo: () => this._onSolo(),
      onMultiplayerReady: (net, mode) => this._onMultiplayerReady(net, mode),
      input: this.input
    });

    // Resize
    window.addEventListener('resize', () => this._onResize());

    // Start loop
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }

  // ============================================================
  // LOBBY CALLBACKS
  // ============================================================

  _onSolo() {
    this.mode = 'solo';
    this.state = 'instructions';
    this.instructionsEl.classList.remove('hidden');
    this._setupStartHandler();
  }

  _onMultiplayerReady(net, mode) {
    this.mode = mode;
    this.net = net;

    // Setup shared pedal controller
    this.sharedPedal = new SharedPedalController();

    // Setup remote bike state for stoker
    if (mode === 'stoker') {
      this.remoteBikeState = new RemoteBikeState();
    }

    // Network callbacks
    this.net.onPedalReceived = (source, foot) => {
      // Track remote pedal for HUD flash
      this._remoteLastFoot = foot;
      this._remoteLastTapTime = performance.now();
      // Captain feeds stoker taps into shared pedal physics
      if (this.mode === 'captain' && this.sharedPedal) {
        this.sharedPedal.receiveTap(source, foot);
      }
    };

    this.net.onStateReceived = (state) => {
      if (this.mode === 'stoker' && this.remoteBikeState) {
        this.remoteBikeState.pushState(state);
      }
    };

    this.net.onLeanReceived = (leanValue) => {
      this.remoteLean = leanValue;
    };

    this.net.onEventReceived = (eventType) => {
      if (eventType === EVT_COUNTDOWN) {
        this._startCountdown();
      } else if (eventType === EVT_START) {
        // Stoker receives GO from captain
        this.state = 'playing';
        const statusEl = document.getElementById('status');
        statusEl.textContent = 'GO!';
        statusEl.style.color = '#44ff66';
        this._playBeep(800, 0.4);
        setTimeout(() => {
          if (this.state === 'playing') {
            statusEl.textContent = '';
            statusEl.style.fontSize = '';
          }
        }, 800);
      } else if (eventType === EVT_RESET) {
        this._resetGame();
      }
    };

    this.net.onReconnecting = (attempt, max) => {
      if (this.state !== 'lobby') {
        this._showReconnecting();
      }
    };

    this.net.onConnected = () => {
      this._hideReconnecting();
      document.getElementById('disconnect-overlay').style.display = 'none';
    };

    this.net.onDisconnected = (reason) => {
      this._hideReconnecting();
      if (this.state !== 'lobby') {
        this._showDisconnect(reason);
      }
    };

    // Update partner gauge label to show partner's role
    const partnerTitle = document.querySelector('#partner-gauge .gauge-title');
    if (partnerTitle) partnerTitle.textContent = mode === 'captain' ? 'STOKER' : 'CAPTAIN';

    // Show partner gauge + pedal indicators immediately
    document.getElementById('partner-gauge').style.display = '';
    document.getElementById('partner-pedal-up').style.display = 'flex';
    document.getElementById('partner-pedal-down').style.display = 'flex';

    // Hide side buttons for stoker (only captain/solo control safety/speed/reset)
    if (mode === 'stoker') {
      document.getElementById('side-buttons').style.display = 'none';
    }

    // Show connection badge
    document.getElementById('conn-badge').style.display = 'block';

    // Show instructions
    this.state = 'instructions';
    this.instructionsEl.classList.remove('hidden');
    this._setupStartHandler();
  }

  // ============================================================
  // START / COUNTDOWN
  // ============================================================

  _setupStartHandler() {
    let started = false;
    const doStart = async () => {
      if (this.state !== 'instructions' || started) return;
      started = true;

      // Request iOS motion permission on first tap
      if (this.input.needsMotionPermission) {
        await this.input.requestMotionPermission();
      }

      // In multiplayer, only captain initiates countdown
      // Stoker waits for EVT_COUNTDOWN from captain
      if (this.mode === 'stoker') {
        // Stoker just dismisses instructions and waits
        this.instructionsEl.classList.add('hidden');
        const statusEl = document.getElementById('status');
        statusEl.textContent = 'Waiting for captain...';
        statusEl.style.color = '#ffffff';
        statusEl.style.fontSize = '';
        return;
      }

      this._startCountdown();
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('click', handler);
    };

    const handler = (e) => {
      e.preventDefault();
      doStart();
    };
    document.addEventListener('touchstart', handler, { passive: false });
    document.addEventListener('click', handler);

    // Gamepad button polling to start
    const pollGamepadStart = () => {
      if (this.state !== 'instructions' || started) return;
      if (this.input.gamepadConnected) {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        const gp = gamepads[this.input.gamepadIndex];
        if (gp) {
          for (let i = 0; i < gp.buttons.length; i++) {
            if (gp.buttons[i].pressed) {
              doStart();
              return;
            }
          }
        }
      }
      requestAnimationFrame(pollGamepadStart);
    };
    requestAnimationFrame(pollGamepadStart);
  }

  _startCountdown() {
    this.state = 'countdown';
    this.countdownTimer = 3.0;
    this.instructionsEl.classList.add('hidden');

    const statusEl = document.getElementById('status');
    statusEl.style.color = '#ffffff';
    statusEl.style.fontSize = '48px';
    statusEl.textContent = '3';
    this._lastCountNum = 3;

    // Init audio
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      this._playBeep(400, 0.15);
    } catch (e) {}

    // Captain notifies stoker
    if (this.mode === 'captain' && this.net) {
      this.net.sendEvent(EVT_COUNTDOWN);
    }
  }

  _updateCountdown(dt) {
    this.countdownTimer -= dt;
    const statusEl = document.getElementById('status');

    if (this.countdownTimer <= 0) {
      statusEl.textContent = 'GO!';
      statusEl.style.color = '#44ff66';
      this.state = 'playing';
      this._playBeep(800, 0.4);

      // Captain sends EVT_START to stoker
      if (this.mode === 'captain' && this.net) {
        this.net.sendEvent(EVT_START);
      }

      setTimeout(() => {
        if (this.state === 'playing') {
          statusEl.textContent = '';
          statusEl.style.fontSize = '';
        }
      }, 800);
      return;
    }

    const num = Math.ceil(this.countdownTimer);
    if (num !== this._lastCountNum) {
      statusEl.textContent = '' + num;
      this._lastCountNum = num;
      this._playBeep(400, 0.15);
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

  // ============================================================
  // RESET / DISCONNECT / RETURN TO LOBBY
  // ============================================================

  _resetGame() {
    this.bike.fullReset();
    this.grassParticles.clear();

    if (this.mode === 'solo') {
      this.pedalCtrl = new PedalController(this.input);
    } else if (this.sharedPedal) {
      this.sharedPedal = new SharedPedalController();
    }

    this.chaseCamera.initialized = false;

    if (this.input.motionEnabled) {
      this.input.motionOffset = this.input.rawGamma;
    }

    if (this.mode === 'captain' && this.net) {
      this.net.sendEvent(EVT_RESET);
    }

    this._startCountdown();
  }

  _showReconnecting() {
    const overlay = document.getElementById('reconnect-overlay');
    overlay.style.display = 'flex';
    if (!this._reconnectTimerStart) {
      this._reconnectTimerStart = performance.now();
      const timerEl = document.getElementById('reconnect-timer');
      this._reconnectInterval = setInterval(() => {
        const elapsed = Math.floor((performance.now() - this._reconnectTimerStart) / 1000);
        timerEl.textContent = elapsed + 's';
      }, 1000);
    }
  }

  _hideReconnecting() {
    const overlay = document.getElementById('reconnect-overlay');
    overlay.style.display = 'none';
    if (this._reconnectInterval) {
      clearInterval(this._reconnectInterval);
      this._reconnectInterval = null;
    }
    this._reconnectTimerStart = null;
    document.getElementById('reconnect-timer').textContent = '0s';
  }

  _showDisconnect(reason) {
    const overlay = document.getElementById('disconnect-overlay');
    const msg = document.getElementById('disconnect-msg');
    overlay.style.display = 'flex';
    msg.textContent = reason || 'Partner disconnected';
  }

  _returnToLobby() {
    if (this.net) { this.net.destroy(); this.net = null; }
    this.mode = 'solo';
    this.sharedPedal = null;
    this.remoteBikeState = null;
    this.remoteLean = 0;
    this._remoteLastFoot = null;
    this._remoteLastTapTime = 0;
    this._mpPrevUp = false;
    this._mpPrevDown = false;
    this._stateSendTimer = 0;
    this._leanSendTimer = 0;
    document.getElementById('conn-badge').style.display = 'none';
    document.getElementById('side-buttons').style.display = '';
    const partnerTitle = document.querySelector('#partner-gauge .gauge-title');
    if (partnerTitle) partnerTitle.textContent = 'PARTNER';

    this.bike.fullReset();
    this.chaseCamera.initialized = false;
    this.pedalCtrl = new PedalController(this.input);

    this.state = 'lobby';
    this.lobby.show();
  }

  _pollDpad() {
    if (!this.input.gamepadConnected) return;
    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.input.gamepadIndex];
    if (!gp) return;

    const up = (gp.buttons[12] && gp.buttons[12].pressed) || false;
    const down = (gp.buttons[13] && gp.buttons[13].pressed) || false;
    const left = (gp.buttons[14] && gp.buttons[14].pressed) || false;
    const right = (gp.buttons[15] && gp.buttons[15].pressed) || false;

    if (up && !this._dpadPrevUp) this.safetyBtn.click();
    if (down && !this._dpadPrevDown) this.speedBtn.click();
    if (right && !this._dpadPrevRight) document.getElementById('reset-btn').click();
    if (left && !this._dpadPrevLeft) this._returnToLobby();

    this._dpadPrevUp = up;
    this._dpadPrevDown = down;
    this._dpadPrevLeft = left;
    this._dpadPrevRight = right;
  }

  _updateConnBadge() {
    if (!this.net) return;
    const typeEl = document.getElementById('conn-type');
    const pingEl = document.getElementById('conn-ping');
    if (typeEl) typeEl.textContent = this.net.transport === 'relay' ? 'RELAY' : 'P2P';
    if (pingEl) pingEl.textContent = Math.round(this.net.pingMs) + 'ms';
  }

  // ============================================================
  // MAIN LOOP
  // ============================================================

  _loop(timestamp) {
    requestAnimationFrame((t) => this._loop(t));

    // Poll gamepad every frame before reading any input
    this.input.pollGamepad();

    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
    this.lastTime = timestamp;

    const roadPath = this.world.roadPath;

    // Lobby: just render the scene (background)
    if (this.state === 'lobby') {
      this.world.update(this.bike.position, this.bike.roadD);
      this.chaseCamera.update(this.bike, dt, roadPath);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // Countdown
    if (this.state === 'countdown') {
      this._updateCountdown(dt);
      this.world.update(this.bike.position, this.bike.roadD);
      this.chaseCamera.update(this.bike, dt, roadPath);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // Instructions / waiting: render static scene
    if (this.state !== 'playing') {
      this.world.update(this.bike.position, this.bike.roadD);
      this.chaseCamera.update(this.bike, dt, roadPath);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // D-pad actions (safety/speed/reset/lobby)
    this._pollDpad();

    // Playing state — dispatch by mode
    if (this.mode === 'solo') {
      this._updateSolo(dt);
    } else if (this.mode === 'captain') {
      this._updateCaptain(dt);
    } else if (this.mode === 'stoker') {
      this._updateStoker(dt);
    }
  }

  // ============================================================
  // SOLO UPDATE
  // ============================================================

  _updateSolo(dt) {
    const pedalResult = this.pedalCtrl.update(dt);
    const balanceResult = this.balanceCtrl.update();

    this.bike.update(pedalResult, balanceResult, dt, this.safetyMode, this.autoSpeed);
    this.grassParticles.update(this.bike, dt);
    this.world.update(this.bike.position, this.bike.roadD);
    this.chaseCamera.update(this.bike, dt, this.world.roadPath);

    // Camera shake on crash
    if (this.bike.fallen && this.bike.fallTimer > 1.8) {
      this.chaseCamera.shakeAmount = 0.15;
    }

    this.hud.update(this.bike, this.input, this.pedalCtrl, dt);
    this.renderer.render(this.scene, this.camera);
  }

  // ============================================================
  // CAPTAIN UPDATE — runs physics, sends state
  // ============================================================

  _updateCaptain(dt) {
    // Edge-detect pedals → shared pedal controller + send to stoker
    const upHeld = this.input.isPressed('ArrowUp');
    const downHeld = this.input.isPressed('ArrowDown');
    if (upHeld && !this._mpPrevUp) {
      this.sharedPedal.receiveTap('captain', 'up');
      if (this.net) this.net.sendPedal('up');
    }
    if (downHeld && !this._mpPrevDown) {
      this.sharedPedal.receiveTap('captain', 'down');
      if (this.net) this.net.sendPedal('down');
    }
    this._mpPrevUp = upHeld;
    this._mpPrevDown = downHeld;

    // Use shared pedal controller
    const pedalResult = this.sharedPedal.update(dt);
    const balanceResult = this.balanceCtrl.update();

    // Capture captain's own lean before merging
    const captainLean = balanceResult.leanInput;

    // Merge lean: captain + stoker averaged
    balanceResult.leanInput = Math.max(-1, Math.min(1,
      (balanceResult.leanInput + this.remoteLean) * 0.5
    ));

    this.bike.update(pedalResult, balanceResult, dt, this.safetyMode, this.autoSpeed);
    this.grassParticles.update(this.bike, dt);

    // Send state + lean to stoker at 20Hz
    this._stateSendTimer += dt;
    if (this._stateSendTimer >= this._stateSendInterval && this.net && this.net.connected) {
      this._stateSendTimer = 0;
      this.net.sendState(this.bike);
      this.net.sendLean(captainLean);
    }

    this.world.update(this.bike.position, this.bike.roadD);
    this.chaseCamera.update(this.bike, dt, this.world.roadPath);

    if (this.bike.fallen && this.bike.fallTimer > 1.8) {
      this.chaseCamera.shakeAmount = 0.15;
    }

    this._updateConnBadge();
    const remoteData = { remoteLean: this.remoteLean, remoteLastFoot: this._remoteLastFoot, remoteLastTapTime: this._remoteLastTapTime };
    this.hud.update(this.bike, this.input, this.sharedPedal, dt, remoteData);
    this.renderer.render(this.scene, this.camera);
  }

  // ============================================================
  // STOKER UPDATE — receives state, interpolates, renders
  // ============================================================

  _updateStoker(dt) {
    // Edge-detect pedals → send over network
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

    // Update local pedal controller for HUD button feedback only
    // (physics are handled by captain's shared pedal controller)
    this.pedalCtrl.update(dt);

    // Interpolate remote state
    const state = this.remoteBikeState ? this.remoteBikeState.getInterpolated() : null;
    if (state) {
      this.bike.applyRemoteState(state);
    }
    this.grassParticles.update(this.bike, dt);

    // Send lean to captain at 20Hz
    this._leanSendTimer += dt;
    if (this._leanSendTimer >= this._leanSendInterval && this.net && this.net.connected) {
      this._leanSendTimer = 0;
      const balanceResult = this.balanceCtrl.update();
      this.net.sendLean(balanceResult.leanInput);
    }

    this.world.update(this.bike.position, this.bike.roadD);
    this.chaseCamera.update(this.bike, dt, this.world.roadPath);

    if (this.bike.speed > 8) {
      this.chaseCamera.shakeAmount = Math.max(
        this.chaseCamera.shakeAmount, (this.bike.speed - 8) * 0.008);
    }
    if (this.bike.fallen) this.chaseCamera.shakeAmount = 0.15;

    this._updateConnBadge();
    const remoteData = { remoteLean: this.remoteLean, remoteLastFoot: this._remoteLastFoot, remoteLastTapTime: this._remoteLastTapTime };
    this.hud.update(this.bike, this.input, this.pedalCtrl, dt, remoteData);
    this.renderer.render(this.scene, this.camera);
  }

  // ============================================================
  // RESIZE
  // ============================================================

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

// ============================================================
// BOOT
// ============================================================
const game = new Game();
window._game = game;
