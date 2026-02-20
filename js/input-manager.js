// ============================================================
// INPUT MANAGER — keyboard + touch + device motion + gamepad
// ============================================================

import { isMobile } from './config.js';

export class InputManager {
  constructor() {
    this.keys = {};
    this.touchLeft = false;
    this.touchRight = false;
    this.motionLean = 0;
    this.motionEnabled = false;
    this.motionReady = false;
    this.rawGamma = 0;
    this.motionOffset = null;
    this.motionRawRelative = 0;

    // Gamepad state
    this.gamepadIndex = null;
    this.gamepadConnected = false;
    this.gamepadLean = 0;
    this._gpTriggerLeftVal = 0;
    this._gpTriggerRightVal = 0;
    this._gpTriggerLeftPressed = false;
    this._gpTriggerRightPressed = false;

    this._setupKeyboard();
    this._setupGamepad();
    if (isMobile) {
      this._setupTouch();
      this._setupMotion();
      this._setupCalibration();
    }
  }

  _setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp','ArrowDown','KeyA','KeyD'].includes(e.code)) e.preventDefault();
      this.keys[e.code] = true;
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
  }

  _setupTouch() {
    const leftBtn = document.getElementById('touch-left');
    const rightBtn = document.getElementById('touch-right');

    const bind = (el, side, pressed) => {
      el.addEventListener(pressed ? 'touchstart' : 'touchend', (e) => {
        e.preventDefault();
        if (side === 'left') this.touchLeft = pressed;
        else this.touchRight = pressed;
      }, { passive: false });
    };
    bind(leftBtn, 'left', true);
    bind(leftBtn, 'left', false);
    bind(rightBtn, 'right', true);
    bind(rightBtn, 'right', false);

    leftBtn.addEventListener('touchcancel', () => { this.touchLeft = false; });
    rightBtn.addEventListener('touchcancel', () => { this.touchRight = false; });

    leftBtn.addEventListener('touchmove', (e) => {
      const t = e.touches[0], r = leftBtn.getBoundingClientRect();
      if (t.clientX < r.left || t.clientX > r.right || t.clientY < r.top || t.clientY > r.bottom) this.touchLeft = false;
    }, { passive: false });
    rightBtn.addEventListener('touchmove', (e) => {
      const t = e.touches[0], r = rightBtn.getBoundingClientRect();
      if (t.clientX < r.left || t.clientX > r.right || t.clientY < r.top || t.clientY > r.bottom) this.touchRight = false;
    }, { passive: false });
  }

  _setupMotion() {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      this.needsMotionPermission = true;
    } else if (typeof DeviceMotionEvent !== 'undefined') {
      this._startMotionListening();
    }
  }

  async requestMotionPermission() {
    if (this.motionEnabled) return;
    this.needsMotionPermission = false;
    if (typeof DeviceMotionEvent === 'undefined' ||
        typeof DeviceMotionEvent.requestPermission !== 'function') return;
    try {
      const response = await DeviceMotionEvent.requestPermission();
      if (response === 'granted') this._startMotionListening();
    } catch (e) {
      console.warn('Motion permission error:', e);
    }
  }

  _startMotionListening() {
    this.motionReady = true;
    this._useAccel = false;
    this._gx = 0; this._gy = 0; this._gz = 0;
    this._gravityInit = false;

    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      this._useAccel = true;
      this.motionEnabled = true;

      const k = 0.3;
      if (!this._gravityInit) {
        this._gx = a.x; this._gy = a.y; this._gz = a.z;
        this._gravityInit = true;
      } else {
        this._gx += (a.x - this._gx) * k;
        this._gy += (a.y - this._gy) * k;
        this._gz += (a.z - this._gz) * k;
      }

      const orient = screen.orientation ? screen.orientation.angle : (window.orientation || 0);
      let rollRad;
      if (orient === 90) rollRad = Math.atan2(this._gy, -this._gx);
      else if (orient === 270 || orient === -90) rollRad = Math.atan2(-this._gy, this._gx);
      else rollRad = Math.atan2(this._gx, this._gy);

      this._applyTilt(-rollRad * 180 / Math.PI);
    });

    window.addEventListener('deviceorientation', (e) => {
      if (this._useAccel) return;
      const orient = screen.orientation ? screen.orientation.angle : (window.orientation || 0);
      let rawTilt;
      if (orient === 90) rawTilt = e.beta;
      else if (orient === 270 || orient === -90) rawTilt = -e.beta;
      else rawTilt = e.gamma;

      if (rawTilt != null) {
        this.motionEnabled = true;
        this._applyTilt(rawTilt);
      }
    });
  }

  _applyTilt(rawTilt) {
    this.rawGamma = rawTilt;
    if (this.motionOffset === null) this.motionOffset = this.rawGamma;

    let relative = this.rawGamma - this.motionOffset;
    if (relative > 180) relative -= 360;
    else if (relative < -180) relative += 360;
    this.motionRawRelative = relative;

    const deadZone = 2;
    if (Math.abs(relative) < deadZone) {
      relative = 0;
    } else {
      relative = relative - Math.sign(relative) * deadZone;
    }
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
      if (flash) { flash.style.display = 'block'; setTimeout(() => { flash.style.display = 'none'; }, 800); }
    };
    gauge.addEventListener('touchstart', doCalibrate, { passive: false });
    gauge.addEventListener('click', doCalibrate);
  }

  _setupGamepad() {
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.gamepadConnected = true;
      console.log('Gamepad connected:', e.gamepad.id);
      const badge = document.getElementById('gamepad-badge');
      if (badge) badge.style.display = 'block';
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.gamepadIndex === e.gamepad.index) {
        this.gamepadIndex = null;
        this.gamepadConnected = false;
        this.gamepadLean = 0;
        this._gpTriggerLeftVal = 0;
        this._gpTriggerRightVal = 0;
        this._gpTriggerLeftPressed = false;
        this._gpTriggerRightPressed = false;
        console.log('Gamepad disconnected');
        const badge = document.getElementById('gamepad-badge');
        if (badge) badge.style.display = 'none';
      }
    });
  }

  pollGamepad() {
    // Polling fallback: detect gamepads even without events
    if (this.gamepadIndex === null) {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (let i = 0; i < gamepads.length; i++) {
        if (gamepads[i]) {
          this.gamepadIndex = i;
          this.gamepadConnected = true;
          const badge = document.getElementById('gamepad-badge');
          if (badge) badge.style.display = 'block';
          break;
        }
      }
    }

    if (this.gamepadIndex === null) return;

    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gamepads[this.gamepadIndex];
    if (!gp) return;

    // Left stick X — deadzone 0.08
    const rawX = gp.axes[0] || 0;
    this.gamepadLean = Math.abs(rawX) < 0.08 ? 0 : rawX;

    // Triggers: buttons[6] = LT, buttons[7] = RT
    const THRESHOLD = 0.5;
    this._gpTriggerLeftVal = gp.buttons[6] ? gp.buttons[6].value : 0;
    this._gpTriggerRightVal = gp.buttons[7] ? gp.buttons[7].value : 0;
    this._gpTriggerLeftPressed = this._gpTriggerLeftVal >= THRESHOLD;
    this._gpTriggerRightPressed = this._gpTriggerRightVal >= THRESHOLD;
  }

  getGamepadLean() {
    return this.gamepadConnected ? this.gamepadLean : 0;
  }

  isPressed(code) {
    if (code === 'ArrowUp') return !!this.keys[code] || this.touchLeft || this._gpTriggerLeftPressed;
    if (code === 'ArrowDown') return !!this.keys[code] || this.touchRight || this._gpTriggerRightPressed;
    return !!this.keys[code];
  }

  getMotionLean() {
    return this.motionEnabled ? this.motionLean : 0;
  }
}
