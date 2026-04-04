// ============================================================
// APP.JS — Main entry point for 3D Controller Overlay
// ============================================================
//
// Gyro connection mirrors the Tandemonium game's lobby.js pattern:
// - Gyro toggle button appears when a gyro-capable controller connects
// - In desktop (Electron): auto-connect after 1s delay
// - In browser: click the gyro button to connect (user gesture needed)
// - Click gyro button to toggle on/off
// - L3 to recalibrate
// ============================================================

import * as THREE from 'three';
import { ControllerOverlay } from './controller-overlay.js';
import { detectControllerType, PROFILES } from './controller-profiles.js';
import { ControllerRegistry } from './controllers/controller-registry.js';

// ── DOM refs ──
const canvas = document.getElementById('canvas');
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const controllerTypeSelect = document.getElementById('controller-type');
const connectGyroBtn = document.getElementById('connect-gyro-btn');
const driftModeSelect = document.getElementById('drift-mode');
const gamepadStatusEl = document.getElementById('gamepad-status');
// Gyro status shown via the gyro toggle button (no separate text badge)
const gyroToggleBtn = document.getElementById('gyro-toggle');
const clickThroughIndicator = document.getElementById('click-through-indicator');
const noControllerSplash = document.getElementById('no-controller');

// ── State ──
let overlay = null;
let gamepadIndex = null;
let currentControllerType = 'dualsense';
let modelReady = false;
let switchingController = false;

// HID / gyro
let hidDevice = null;
let controllerDriver = null;
let gyroActive = false;          // true when gyro is connected and feeding data
let gyroPermitted = false;       // true once gyro has been connected at least once
const gyroOrientation = new THREE.Quaternion();
let lastGyroTime = 0;
let gyroScale = (2000.0 / 32768.0) * (Math.PI / 180.0);
const gyroBias = { x: 0, y: 0, z: 0 };
let calibrating = false;
let calibSamples = [];
const CALIB_COUNT = 150;
let calibRetries = 0;
const MAX_CALIB_RETRIES = 5;
const CALIB_VARIANCE_THRESHOLD = 150;
let gyroConnectTimer = null;

// ── Button combo system ──
const BUTTON_NAMES = [
  'A/Cross', 'B/Circle', 'X/Square', 'Y/Triangle',
  'L1/LB', 'R1/RB', 'L2/LT', 'R2/RT',
  'Select', 'Start', 'L3', 'R3',
  'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Home',
];

const DEFAULT_COMBOS = {
  settings:   [8, 9],    // Select + Start
  gyroToggle: [8, 11],   // Select + R3
  calibrate:  [10, 11],  // L3 + R3
};

// Load saved combos from localStorage, fall back to defaults
function loadCombos() {
  try {
    const saved = localStorage.getItem('overlay-combos');
    if (saved) return { ...DEFAULT_COMBOS, ...JSON.parse(saved) };
  } catch (e) { /* ignore */ }
  return { ...DEFAULT_COMBOS };
}
function saveCombos() {
  try { localStorage.setItem('overlay-combos', JSON.stringify(combos)); } catch (e) { /* ignore */ }
}

const combos = loadCombos();
const comboPrevState = {};  // track previous pressed state per combo

function comboName(buttons) {
  return buttons.map(b => BUTTON_NAMES[b] || `Btn${b}`).join(' + ');
}

function isComboPressed(gamepad, buttons) {
  return buttons.every(b => gamepad.buttons[b]?.pressed);
}

function checkCombo(gamepad, key, action) {
  const pressed = isComboPressed(gamepad, combos[key]);
  if (pressed && !comboPrevState[key]) action();
  comboPrevState[key] = pressed;
}

// Remap capture state
let remapTarget = null;  // which combo key is being remapped

// Drift correction
const DRIFT_RATES = { off: 0, gentle: 0.0003, strong: 0.002 };
let driftMode = 'gentle';
const _identityQuat = new THREE.Quaternion();

const isDesktop = typeof window !== 'undefined' &&
  (window.electronAPI || navigator.userAgent.includes('Electron'));

// ── Gyro HUD ──
const gyroHud = document.getElementById('gyro-hud');
const arcNeedle = document.getElementById('arc-needle');
const arcBand = document.getElementById('arc-band');
const arcTicks = document.getElementById('arc-ticks');
const leanArrowLeft = document.getElementById('lean-arrow-left');
const leanArrowRight = document.getElementById('lean-arrow-right');
const calibHint = document.getElementById('calib-hint');
const GYRO_HUD_MAX_DEG = 40; // ±40° matches game's gyro sensitivity
let calibHintTimer = null;
let driftCheckAccum = 0;
let driftCheckLastLean = 0;
const _hudEuler = new THREE.Euler();

// Build the static arc band and tick marks
function initGyroHud() {
  const R = 100; // arc radius in SVG units
  const bandW = 10;
  const maxRad = GYRO_HUD_MAX_DEG * Math.PI / 180;

  // Arc band path (circular arc from -maxDeg to +maxDeg, opening downward)
  const steps = 40;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const a = -maxRad + (2 * maxRad * i / steps);
    const x = Math.sin(a) * (R - bandW / 2);
    const y = -Math.cos(a) * (R - bandW / 2);
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2);
  }
  for (let i = steps; i >= 0; i--) {
    const a = -maxRad + (2 * maxRad * i / steps);
    const x = Math.sin(a) * (R + bandW / 2);
    const y = -Math.cos(a) * (R + bandW / 2);
    d += 'L' + x.toFixed(2) + ',' + y.toFixed(2);
  }
  d += 'Z';
  arcBand.setAttribute('d', d);

  // Tick marks at 0%, ±25%, ±50%, ±75%, ±100%
  let ticksHtml = '';
  for (const pct of [0, 0.25, 0.5, 0.75, 1.0]) {
    for (const sign of (pct === 0 ? [1] : [-1, 1])) {
      const a = sign * pct * maxRad;
      const isMajor = pct === 0 || pct === 1.0;
      const inner = R - (isMajor ? 14 : 10);
      const outer = R + (isMajor ? 14 : 10);
      const x1 = Math.sin(a) * inner, y1 = -Math.cos(a) * inner;
      const x2 = Math.sin(a) * outer, y2 = -Math.cos(a) * outer;
      const sw = isMajor ? 1.2 : 0.6;
      const op = isMajor ? 0.5 : 0.25;
      ticksHtml += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke-width="${sw}" opacity="${op}"/>`;
    }
  }
  arcTicks.innerHTML = ticksHtml;
}

function leanColor(t) {
  // t: 0 (center) to 1 (max lean)
  const abs = Math.min(1, Math.abs(t));
  if (abs < 0.5) return '#ffffff';
  if (abs < 0.75) return '#ffaa22';
  return '#ff4444';
}

function updateGyroHud(leanDeg) {
  if (!gyroHud.classList.contains('visible')) return;

  const t = Math.max(-1, Math.min(1, leanDeg / GYRO_HUD_MAX_DEG)); // -1 to 1
  const absT = Math.abs(t);
  const R = 100;
  const maxRad = GYRO_HUD_MAX_DEG * Math.PI / 180;

  // Needle rotation
  const needleAngle = t * maxRad;
  const nx1 = Math.sin(needleAngle) * 4, ny1 = -Math.cos(needleAngle) * 4;
  const nx2 = Math.sin(needleAngle) * 22, ny2 = -Math.cos(needleAngle) * 22;
  // Use line from near-center to arc
  const nx2f = Math.sin(needleAngle) * (R - 2);
  const ny2f = -Math.cos(needleAngle) * (R - 2);
  arcNeedle.setAttribute('x1', nx1.toFixed(2));
  arcNeedle.setAttribute('y1', ny1.toFixed(2));
  arcNeedle.setAttribute('x2', nx2f.toFixed(2));
  arcNeedle.setAttribute('y2', ny2f.toFixed(2));
  const color = leanColor(t);
  arcNeedle.setAttribute('stroke', color);

  // Arrows + calibration text match needle color
  calibHint.style.color = color;
  leanArrowLeft.style.opacity = t < -0.05 ? Math.min(1, absT * 1.5) : 0.1;
  leanArrowLeft.style.color = t < -0.05 ? color : '#888';
  leanArrowRight.style.opacity = t > 0.05 ? Math.min(1, absT * 1.5) : 0.1;
  leanArrowRight.style.color = t > 0.05 ? color : '#888';
}

function showGyroHud() {
  gyroHud.classList.add('visible');
  applyHudPosition();
}
function hideGyroHud() { gyroHud.classList.remove('visible'); }

function applyHudPosition() {
  const pos = document.getElementById('hud-position')?.value || 'above';
  gyroHud.classList.remove('pos-above', 'pos-below');
  gyroHud.classList.add('pos-' + pos);
}

function showCalibHint(text, duration) {
  calibHint.textContent = text;
  calibHint.classList.remove('hidden');
  if (calibHintTimer) clearTimeout(calibHintTimer);
  if (duration) {
    calibHintTimer = setTimeout(() => {
      calibHint.classList.add('hidden');
      calibHintTimer = null;
    }, duration);
  }
}

function hideCalibHint() {
  calibHint.classList.add('hidden');
  if (calibHintTimer) { clearTimeout(calibHintTimer); calibHintTimer = null; }
}

initGyroHud();
applyHudPosition();

// In browser (not Electron), set a light background since transparency isn't available
if (!isDesktop) {
  document.body.style.background = '#e8e8ec';
}

// ── Initialize ──
async function init() {
  // Detect what's connected — if nothing, don't load a model yet
  const initialType = detectInitialController();
  const hasGamepad = initialType !== null;

  overlay = new ControllerOverlay({
    canvas,
    transparent: true,
    controllerType: hasGamepad ? initialType : 'dualsense',
  });
  await overlay.init();

  if (hasGamepad) {
    currentControllerType = initialType;
    modelReady = true;
    noControllerSplash.classList.add('hidden');
  } else {
    // No gamepad — hide the 3D model, show splash
    overlay.setVisible(false);
    modelReady = false;
  }

  new ResizeObserver(() => {
    overlay.resize(canvas.clientWidth, canvas.clientHeight);
  }).observe(canvas);

  // Listen for HID device disconnects
  if (navigator.hid) {
    navigator.hid.addEventListener('disconnect', (e) => {
      if (hidDevice && e.device === hidDevice) {
        console.log('HID device disconnected');
        disconnectGyro();
      }
    });
  }

  requestAnimationFrame(loop);

  // Check for already-connected gamepad (may have connected before
  // our event listeners were attached). Same approach as the game's
  // pollGamepad() fallback in input-manager.js.
  checkForExistingGamepad();
}

/**
 * Detect what controller is already connected at startup.
 */
function detectInitialController() {
  const gamepads = navigator.getGamepads();
  for (let i = 0; i < gamepads.length; i++) {
    if (gamepads[i]) {
      const type = detectControllerType(gamepads[i].id);
      console.log('Initial controller detected:', type, '(' + gamepads[i].id + ')');
      return type;
    }
  }
  return null; // nothing connected
}

/**
 * Check for a gamepad that was connected before event listeners were set up.
 * Triggers the full switchController flow including gyro auto-connect.
 */
function checkForExistingGamepad() {
  const gamepads = navigator.getGamepads();
  for (let i = 0; i < gamepads.length; i++) {
    if (gamepads[i]) {
      console.log('Found existing gamepad at startup:', gamepads[i].id);
      switchController(gamepads[i]);
      return;
    }
  }
}

// =====================================================================
// CONTROLLER LIFECYCLE
// =====================================================================

async function switchController(gamepad) {
  if (switchingController) return;
  switchingController = true;

  try {
    const newType = controllerTypeSelect.value === 'auto'
      ? detectControllerType(gamepad.id)
      : controllerTypeSelect.value;

    // Tear down gyro — physical device changed
    cancelGyroConnect();
    await disconnectGyro();

    // Load new model if type changed or first connection
    if (newType !== currentControllerType || !overlay.model) {
      modelReady = false;
      currentControllerType = newType;
      await overlay.setControllerType(newType);
      console.log('Controller model loaded:', newType);
    }

    // Always ensure model is ready and visible after switch
    modelReady = true;
    overlay.setVisible(true);
    noControllerSplash.classList.add('hidden');

    // Update UI
    gamepadIndex = gamepad.index;
    gamepadStatusEl.textContent = gamepad.id.slice(0, 30);
    gamepadStatusEl.classList.add('connected');

    // Show gyro toggle and auto-connect if controller supports gyro
    const info = ControllerRegistry.identifyFromGamepadId(gamepad.id);
    if (navigator.hid && info?.hasGyro) {
      showGyroToggle();
      // Always auto-connect gyro — in Electron requestDevice() auto-approves,
      // in browsers it will fail silently and the user can click the button.
      scheduleGyroConnect();
    } else {
      hideGyroToggle();
    }
  } catch (err) {
    console.error('Controller switch failed:', err);
    modelReady = true;
  } finally {
    switchingController = false;
  }
}

function onGamepadDisconnected(index) {
  if (index !== gamepadIndex) return;
  gamepadIndex = null;
  gamepadStatusEl.textContent = 'No gamepad';
  gamepadStatusEl.classList.remove('connected');
  cancelGyroConnect();
  disconnectGyro();
  hideGyroToggle();

  // Show the no-controller splash and hide the 3D model
  noControllerSplash.classList.remove('hidden');
  overlay.setVisible(false);
}

// ── Gamepad events ──

window.addEventListener('gamepadconnected', (e) => {
  switchController(e.gamepad);
});

window.addEventListener('gamepaddisconnected', (e) => {
  onGamepadDisconnected(e.gamepad.index);
});

// =====================================================================
// GYRO TOGGLE UI
// =====================================================================

function showGyroToggle() {
  gyroToggleBtn.classList.add('visible');
  // Shift status bar left to make room
  const statusBar = document.getElementById('status-bar');
  if (statusBar) statusBar.style.right = '78px';
}

function hideGyroToggle() {
  gyroToggleBtn.classList.remove('visible', 'active', 'inactive');
  const statusBar = document.getElementById('status-bar');
  if (statusBar) statusBar.style.right = '42px';
}

function updateGyroToggle() {
  const indicator = gyroToggleBtn.querySelector('.gyro-indicator');
  if (gyroActive) {
    gyroToggleBtn.title = 'Gyro: ON (click to disable)';
    if (indicator) indicator.textContent = '\u2705'; // green checkmark
  } else {
    gyroToggleBtn.title = 'Gyro: OFF (click to enable)';
    if (indicator) indicator.textContent = '\u274C'; // red X
  }
}

gyroToggleBtn.addEventListener('click', () => toggleGyro());

// =====================================================================
// GYRO CONNECTION
// =====================================================================

/**
 * Schedule gyro auto-connect after delay (desktop only).
 */
function scheduleGyroConnect() {
  cancelGyroConnect();
  // 2-second delay: Switch Pro needs time for USB enumeration + HID readiness.
  // The driver's init() has its own internal retries and delays for sub-commands.
  gyroConnectTimer = setTimeout(async () => {
    gyroConnectTimer = null;
    if (gamepadIndex === null) return;
    if (gyroActive) return;
    console.log('Auto-connecting gyro for', currentControllerType, '...');
    try {
      await connectControllerGyro();
      if (gyroActive) {
        console.log('Gyro auto-connected successfully');
      } else {
        console.log('Gyro auto-connect: no device found — click gyro button to retry');
      }
    } catch (err) {
      console.warn('Gyro auto-connect failed:', err.message);
    }
  }, 2000);
}

function cancelGyroConnect() {
  if (gyroConnectTimer) {
    clearTimeout(gyroConnectTimer);
    gyroConnectTimer = null;
  }
}

/**
 * Connect to controller gyro via WebHID.
 *
 * Step 1: getDevices() — returns devices from prior requestDevice() sessions.
 *         Works without user gesture. Fast.
 * Step 2: requestDevice() — triggers Electron's select-hid-device handler
 *         which auto-approves. Also works in browsers with user gesture.
 */
async function connectControllerGyro() {
  if (hidDevice && gyroActive) return;
  if (!navigator.hid) return;

  const filters = ControllerRegistry.getHIDFilters();
  let device;

  // Step 1: check previously-granted devices
  console.log('connectControllerGyro: trying getDevices()...');
  try {
    const granted = await navigator.hid.getDevices();
    console.log('connectControllerGyro: getDevices returned', granted.length, 'device(s)');
    for (const d of granted) {
      const drv = ControllerRegistry.getDriver(d.vendorId, d.productId);
      if (drv && drv.capabilities.gyro) {
        device = d;
        console.log('connectControllerGyro: found granted device:', d.productName);
        break;
      }
    }
  } catch (err) {
    console.log('connectControllerGyro: getDevices failed:', err.message);
  }

  // Step 2: requestDevice() if no granted device
  if (!device) {
    console.log('connectControllerGyro: trying requestDevice()...');
    try {
      const devices = await navigator.hid.requestDevice({ filters });
      console.log('connectControllerGyro: requestDevice returned', devices?.length || 0, 'device(s)');
      device = devices && devices[0];
    } catch (err) {
      console.log('connectControllerGyro: requestDevice failed:', err.message);
    }
  }

  if (!device) {
    console.log('connectControllerGyro: no device found');
    return;
  }

  console.log('connectControllerGyro: connecting to', device.productName,
    'vid:' + device.vendorId.toString(16), 'pid:' + device.productId.toString(16));

  // Clean up old device if any
  if (hidDevice) {
    hidDevice.removeEventListener('inputreport', handleInputReport);
    try { await hidDevice.close(); } catch (e) { /* ok */ }
    hidDevice = null;
    controllerDriver = null;
  }

  controllerDriver = await ControllerRegistry.connect(device);
  hidDevice = controllerDriver.device;
  hidDevice.addEventListener('inputreport', handleInputReport);

  gyroActive = true;
  gyroPermitted = true;
  connectGyroBtn.textContent = 'Connected';
  updateGyroToggle();
  showGyroHud();
  console.log('Gyro connected:', device.productName);

  startCalibration();
}

/**
 * Disconnect gyro and reset state.
 */
async function disconnectGyro() {
  if (hidDevice) {
    hidDevice.removeEventListener('inputreport', handleInputReport);
    try { await hidDevice.close(); } catch (e) { /* ok */ }
    hidDevice = null;
  }
  if (controllerDriver) {
    if (controllerDriver.destroy) controllerDriver.destroy();
    controllerDriver = null;
  }
  gyroActive = false;
  gyroPermitted = false;
  gyroOrientation.identity();
  lastGyroTime = 0;
  calibrating = false;
  calibSamples = [];
  calibRetries = 0;
  gyroBias.x = gyroBias.y = gyroBias.z = 0;
  connectGyroBtn.textContent = 'Connect';
  updateGyroToggle();
  hideGyroHud();
  hideCalibHint();
}

// ── Main loop ──

function loop() {
  requestAnimationFrame(loop);
  if (!modelReady) return;

  const gamepad = readGamepad();

  if (gamepad) {
    // Exit confirmation dialog takes priority
    if (exitConfirm.classList.contains('visible')) {
      navigateExitDialog(gamepad);
    } else if (remapTarget) {
      captureRemap(gamepad);
    } else if (settingsPanel.classList.contains('visible')) {
      navigateSettings(gamepad);
      checkCombo(gamepad, 'settings', toggleSettings);
    } else {
      // Normal combo detection
      checkCombo(gamepad, 'settings', toggleSettings);
      checkCombo(gamepad, 'gyroToggle', toggleGyro);
      checkCombo(gamepad, 'calibrate', () => {
        if (gyroActive) {
          startCalibration();
          console.log('Gyro recalibrating');
        }
      });
    }
  }

  overlay.update(gamepad, gyroActive ? gyroOrientation : null);

  // Update gyro HUD
  if (gyroActive) {
    _hudEuler.setFromQuaternion(gyroOrientation, 'XYZ');
    const leanDeg = -_hudEuler.z * (180 / Math.PI);
    updateGyroHud(leanDeg);

    // Drift detection: lean angle changing while controller is stationary
    if (!calibrating) {
      const leanDelta = Math.abs(leanDeg - driftCheckLastLean);
      driftCheckLastLean = leanDeg;
      if (leanDelta > 0.02 && leanDelta < 0.5) {
        driftCheckAccum += leanDelta;
      } else {
        driftCheckAccum = Math.max(0, driftCheckAccum - 0.1);
      }
      if (driftCheckAccum > 15) {
        showCalibHint(comboName(combos.calibrate) + ' to recalibrate', 5000);
        driftCheckAccum = 0;
      }
    }
  }
}

function toggleSettings() {
  settingsPanel.classList.toggle('visible');
  if (settingsPanel.classList.contains('visible')) {
    settingsFocusIndex = 0;
    updateSettingsFocus();
  }
}

async function toggleGyro() {
  if (gyroActive) {
    gyroActive = false;
    gyroOrientation.identity();
    lastGyroTime = 0;
    updateGyroToggle();
    hideGyroHud();
  } else if (gyroPermitted && hidDevice) {
    gyroActive = true;
    startCalibration();
    updateGyroToggle();
    showGyroHud();
  } else {
    try { await connectControllerGyro(); } catch (e) { /* */ }
  }
}

// ── Gamepad settings navigation ──
let settingsFocusIndex = 0;
const navPrevState = { up: false, down: false, left: false, right: false, a: false, b: false };

function getSettingRows() {
  return Array.from(settingsPanel.querySelectorAll('.setting-row, .camera-presets'));
}

function navigateSettings(gamepad) {
  const rows = getSettingRows();
  if (!rows.length) return;

  const up = gamepad.buttons[12]?.pressed || (gamepad.axes[1] < -0.5);
  const down = gamepad.buttons[13]?.pressed || (gamepad.axes[1] > 0.5);
  const left = gamepad.buttons[14]?.pressed || (gamepad.axes[0] < -0.5);
  const right = gamepad.buttons[15]?.pressed || (gamepad.axes[0] > 0.5);
  const a = gamepad.buttons[0]?.pressed;
  const b = gamepad.buttons[1]?.pressed;

  // Edge-triggered navigation
  if (up && !navPrevState.up) {
    settingsFocusIndex = Math.max(0, settingsFocusIndex - 1);
    updateSettingsFocus();
  }
  if (down && !navPrevState.down) {
    settingsFocusIndex = Math.min(rows.length - 1, settingsFocusIndex + 1);
    updateSettingsFocus();
  }

  const row = rows[settingsFocusIndex];
  if (row) {
    // Camera presets row — left/right highlights, A confirms selection
    if (row.classList.contains('camera-presets')) {
      const btns = Array.from(row.querySelectorAll('button'));
      // Track a hover/focus index within this row
      let hoverIdx = btns.findIndex(b => b.classList.contains('nav-hover'));
      if (hoverIdx === -1) hoverIdx = btns.findIndex(b => b.classList.contains('selected'));

      if (left && !navPrevState.left) {
        hoverIdx = Math.max(0, (hoverIdx === -1 ? btns.length : hoverIdx) - 1);
        highlightPresetBtn(btns, hoverIdx);
      }
      if (right && !navPrevState.right) {
        hoverIdx = Math.min(btns.length - 1, (hoverIdx === -1 ? -1 : hoverIdx) + 1);
        highlightPresetBtn(btns, hoverIdx);
      }
      if (a && !navPrevState.a && hoverIdx >= 0 && hoverIdx < btns.length) {
        selectCameraPreset(btns[hoverIdx].dataset.preset);
        clearPresetHover();
      }
    } else {
      const select = row.querySelector('select');
      const checkbox = row.querySelector('input[type="checkbox"]');
      const slider = row.querySelector('input[type="range"]');
      const button = row.querySelector('button');

      if (left && !navPrevState.left) {
        if (select) { select.selectedIndex = Math.max(0, select.selectedIndex - 1); select.dispatchEvent(new Event('change')); }
        if (slider) { slider.value = Math.max(+slider.min, +slider.value - 5); slider.dispatchEvent(new Event('input')); }
      }
      if (right && !navPrevState.right) {
        if (select) { select.selectedIndex = Math.min(select.options.length - 1, select.selectedIndex + 1); select.dispatchEvent(new Event('change')); }
        if (slider) { slider.value = Math.min(+slider.max, +slider.value + 5); slider.dispatchEvent(new Event('input')); }
      }
      if (a && !navPrevState.a) {
        if (checkbox) { checkbox.checked = !checkbox.checked; checkbox.dispatchEvent(new Event('change')); }
        if (button) button.click();
      }
    }
  }

  if (b && !navPrevState.b) {
    settingsPanel.classList.remove('visible');
  }

  navPrevState.up = up; navPrevState.down = down;
  navPrevState.left = left; navPrevState.right = right;
  navPrevState.a = a; navPrevState.b = b;
}

function highlightPresetBtn(btns, idx) {
  btns.forEach((b, i) => b.classList.toggle('nav-hover', i === idx));
}

function clearPresetHover() {
  document.querySelectorAll('.camera-presets button.nav-hover').forEach(b => b.classList.remove('nav-hover'));
}

function updateSettingsFocus() {
  clearPresetHover();
  const rows = getSettingRows();
  rows.forEach((r, i) => {
    r.style.background = i === settingsFocusIndex ? 'rgba(51,136,255,0.15)' : '';
    r.style.borderRadius = i === settingsFocusIndex ? '6px' : '';
  });
  if (rows[settingsFocusIndex]) {
    rows[settingsFocusIndex].scrollIntoView({ block: 'nearest' });
  }
}

// ── Exit dialog navigation ──
let exitFocusIdx = 0;
const exitDialogPrev = { left: false, right: false, a: false, b: false };

function navigateExitDialog(gamepad) {
  const btns = [document.getElementById('exit-cancel'), document.getElementById('exit-yes')];

  const left = gamepad.buttons[14]?.pressed || (gamepad.axes[0] < -0.5);
  const right = gamepad.buttons[15]?.pressed || (gamepad.axes[0] > 0.5);
  const a = gamepad.buttons[0]?.pressed;
  const b = gamepad.buttons[1]?.pressed;

  if (left && !exitDialogPrev.left) exitFocusIdx = 0;
  if (right && !exitDialogPrev.right) exitFocusIdx = 1;

  btns.forEach((btn, i) => {
    btn.style.outline = i === exitFocusIdx ? '2px solid #fff' : '';
    btn.style.outlineOffset = i === exitFocusIdx ? '2px' : '';
  });

  if (a && !exitDialogPrev.a) btns[exitFocusIdx].click();
  if (b && !exitDialogPrev.b) document.getElementById('exit-cancel').click();

  exitDialogPrev.left = left; exitDialogPrev.right = right;
  exitDialogPrev.a = a; exitDialogPrev.b = b;
}

// ── Remap capture ──
function startRemap(key) {
  remapTarget = key;
  updateRemapUI();
}

function captureRemap(gamepad) {
  const pressed = [];
  for (let i = 0; i < gamepad.buttons.length; i++) {
    if (gamepad.buttons[i].pressed) pressed.push(i);
  }
  if (pressed.length >= 2) {
    combos[remapTarget] = pressed;
    saveCombos();
    remapTarget = null;
    updateRemapUI();
  }
}

function updateRemapUI() {
  for (const key of Object.keys(DEFAULT_COMBOS)) {
    const label = document.getElementById(`combo-label-${key}`);
    const btn = document.getElementById(`combo-remap-${key}`);
    if (label) label.textContent = comboName(combos[key]);
    if (btn) btn.textContent = (remapTarget === key) ? 'Press combo...' : 'Remap';
  }
}

// Initialize remap buttons after DOM is ready
document.querySelectorAll('[data-remap]').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.remap;
    if (remapTarget === key) {
      remapTarget = null; // cancel
    } else {
      remapTarget = key;
    }
    updateRemapUI();
  });
});

function readGamepad() {
  if (gamepadIndex === null) {
    const gamepads = navigator.getGamepads();
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) {
        switchController(gamepads[i]);
        return null;
      }
    }
    return null;
  }

  const gp = navigator.getGamepads()[gamepadIndex];
  if (!gp) {
    onGamepadDisconnected(gamepadIndex);
    return null;
  }
  return gp;
}

// =====================================================================
// GYRO INPUT
// =====================================================================

function handleInputReport(event) {
  if (!controllerDriver || !gyroActive) return;
  const parsed = controllerDriver.parseReport(event.reportId, event.data);
  if (!parsed) return;

  if (parsed.touchpad) {
    overlay.updateTouchpad(parsed.touchpad, parsed.touchpadButton);
  }

  if (!parsed.gyro) return;

  gyroScale = parsed.gyroScale * (Math.PI / 180.0);
  const now = performance.now();
  const rawGx = parsed.gyro.x;
  const rawGy = parsed.gyro.y;
  const rawGz = parsed.gyro.z;

  if (calibrating) {
    calibSamples.push({ x: rawGx, y: rawGy, z: rawGz });
    if (calibSamples.length >= CALIB_COUNT) finishCalibration();
  }

  const gx = rawGx - gyroBias.x;
  const gy = rawGy - gyroBias.y;
  const gz = rawGz - gyroBias.z;

  if (lastGyroTime > 0) {
    const dt = (now - lastGyroTime) / 1000.0;
    if (dt < 0.1) {
      const profile = PROFILES[currentControllerType];
      const transform = profile?.gyroTransform || ((x, y, z) => [x, y, z]);
      const [tx, ty, tz] = transform(gx, gy, gz);
      const wx = tx * gyroScale * dt;
      const wy = ty * gyroScale * dt;
      const wz = tz * gyroScale * dt;
      const dq = new THREE.Quaternion();
      dq.setFromEuler(new THREE.Euler(wx, wy, wz, 'XYZ'));
      gyroOrientation.multiply(dq);
      gyroOrientation.normalize();

      const rate = DRIFT_RATES[driftMode] || 0;
      if (rate > 0) {
        const angularSpeed = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (angularSpeed < 300) {
          gyroOrientation.slerp(_identityQuat, rate * (1 - angularSpeed / 300));
        }
      }
    }
  }
  lastGyroTime = now;
}

// ── Calibration ──

function startCalibration() {
  calibrating = true;
  calibSamples = [];
  calibRetries = 0;
  gyroOrientation.identity();
  lastGyroTime = 0;
  // Reset camera to selected preset on calibration
  overlay.setCameraPreset(selectedCameraPreset);
  showCalibHint('Calibrating...', null);
}

function finishCalibration() {
  if (calibSamples.length === 0) return;

  let sx = 0, sy = 0, sz = 0;
  for (const s of calibSamples) { sx += s.x; sy += s.y; sz += s.z; }
  const meanX = sx / calibSamples.length;
  const meanY = sy / calibSamples.length;
  const meanZ = sz / calibSamples.length;

  let varX = 0, varY = 0, varZ = 0;
  for (const s of calibSamples) {
    varX += (s.x - meanX) ** 2;
    varY += (s.y - meanY) ** 2;
    varZ += (s.z - meanZ) ** 2;
  }
  const maxStd = Math.max(
    Math.sqrt(varX / calibSamples.length),
    Math.sqrt(varY / calibSamples.length),
    Math.sqrt(varZ / calibSamples.length),
  );

  if (maxStd > CALIB_VARIANCE_THRESHOLD && calibRetries < MAX_CALIB_RETRIES) {
    calibRetries++;
    calibSamples = [];
    console.log(`Calibration retry ${calibRetries}/${MAX_CALIB_RETRIES} (stddev: ${maxStd.toFixed(1)})`);
    return;
  }

  gyroBias.x = meanX;
  gyroBias.y = meanY;
  gyroBias.z = meanZ;
  calibrating = false;
  calibSamples = [];
  gyroOrientation.identity();
  lastGyroTime = 0;
  driftCheckAccum = 0;
  driftCheckLastLean = 0;
  showCalibHint(comboName(combos.calibrate) + ' to recalibrate', 3000);
  console.log('Gyro calibrated, bias:', gyroBias, 'stddev:', maxStd.toFixed(1));
}

// ── UI Events ──

settingsToggle.addEventListener('click', () => toggleSettings());

document.getElementById('settings-close').addEventListener('click', () => {
  settingsPanel.classList.remove('visible');
});

document.getElementById('btn-close-settings').addEventListener('click', () => {
  settingsPanel.classList.remove('visible');
});

// Exit application with confirmation
const exitConfirm = document.getElementById('exit-confirm');

document.getElementById('btn-exit-app').addEventListener('click', () => {
  exitFocusIdx = 0; // default to Cancel
  exitConfirm.classList.add('visible');
});

document.getElementById('exit-cancel').addEventListener('click', () => {
  exitConfirm.classList.remove('visible');
});

document.getElementById('exit-yes').addEventListener('click', () => {
  if (window.electronAPI?.quit) {
    window.electronAPI.quit();
  } else if (window.close) {
    window.close();
  }
});

// Click outside settings panel to close it
window.addEventListener('mousedown', (e) => {
  if (!settingsPanel.classList.contains('visible')) return;
  if (settingsPanel.contains(e.target)) return;
  if (e.target === settingsToggle || settingsToggle.contains(e.target)) return;
  settingsPanel.classList.remove('visible');
});

controllerTypeSelect.addEventListener('change', async (e) => {
  const gp = gamepadIndex !== null ? navigator.getGamepads()[gamepadIndex] : null;
  if (e.target.value === 'auto' && gp) {
    const type = detectControllerType(gp.id);
    if (type !== currentControllerType) {
      modelReady = false;
      currentControllerType = type;
      await overlay.setControllerType(type);
      modelReady = true;
    }
  } else if (e.target.value !== 'auto') {
    if (e.target.value !== currentControllerType) {
      modelReady = false;
      currentControllerType = e.target.value;
      await overlay.setControllerType(e.target.value);
      modelReady = true;
    }
  }
});

// Settings panel gyro button also connects
connectGyroBtn.addEventListener('click', async () => {
  if (hidDevice && gyroActive) return;
  try {
    await connectControllerGyro();
  } catch (err) {
    console.error('WebHID connect failed:', err);
    connectGyroBtn.textContent = 'Connect';
  }
});

document.getElementById('hud-position').addEventListener('change', () => applyHudPosition());

driftModeSelect.addEventListener('change', (e) => {
  driftMode = e.target.value;
});

const opacitySlider = document.getElementById('opacity-slider');
const opacityValue = document.getElementById('opacity-value');
opacitySlider.addEventListener('input', (e) => {
  const pct = parseInt(e.target.value);
  opacityValue.textContent = pct + '%';
  overlay.setOpacity(pct / 100);
});

const bodyColorInput = document.getElementById('body-color');
const accentColorInput = document.getElementById('accent-color');
bodyColorInput.addEventListener('input', (e) => overlay.setBodyColor(e.target.value));
accentColorInput.addEventListener('input', (e) => overlay.setAccentColor(e.target.value));

// Camera presets — one selected at a time, used as calibration view
let selectedCameraPreset = 'player';
const cameraPresetBtns = document.querySelectorAll('.camera-presets button');

function selectCameraPreset(preset) {
  selectedCameraPreset = preset;
  if (overlay) overlay.setCameraPreset(preset);
  cameraPresetBtns.forEach(b => {
    b.classList.toggle('selected', b.dataset.preset === preset);
  });
}

cameraPresetBtns.forEach((btn) => {
  btn.addEventListener('click', () => selectCameraPreset(btn.dataset.preset));
});

// Set default selection (overlay not ready yet, just highlights the button)
selectCameraPreset('player');

// ── Window display toggles (cosmetic only — never affects functionality) ──
const showTitleCheck = document.getElementById('show-title');
const showGyroCheck = document.getElementById('show-gyro');
const showGearCheck = document.getElementById('show-gear');

function applyDisplayToggles() {
  document.body.classList.toggle('show-title', showTitleCheck.checked);
  document.body.classList.toggle('show-gyro', showGyroCheck.checked);
  document.body.classList.toggle('show-gear', showGearCheck.checked);
}

showTitleCheck.addEventListener('change', applyDisplayToggles);
showGyroCheck.addEventListener('change', applyDisplayToggles);
showGearCheck.addEventListener('change', applyDisplayToggles);
applyDisplayToggles(); // apply defaults (all unchecked = all hidden)

// Right-click opens settings (needed when gear icon is hidden)
window.addEventListener('contextmenu', (e) => {
  if (settingsPanel.contains(e.target)) return;
  e.preventDefault();
  settingsPanel.classList.toggle('visible');
});

if (window.electronAPI) {
  window.electronAPI.onClickThroughChanged((isClickThrough) => {
    clickThroughIndicator.classList.toggle('active', !isClickThrough);
    if (isClickThrough) settingsPanel.classList.remove('visible');
  });
  window.electronAPI.onToggleSettings(() => {
    settingsPanel.classList.toggle('visible');
  });
}

// ── Start ──
updateRemapUI(); // populate combo labels from saved/default settings
init();
