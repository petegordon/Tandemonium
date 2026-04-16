// ============================================================
// HAPTICS — vibration feedback (mobile + gamepad)
// ============================================================

const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

// Prime vibration API on first user tap (Android Chrome requires user activation)
let _primed = false;
function _prime() {
  if (_primed) return;
  _primed = true;
  if (canVibrate) navigator.vibrate(1); // silent 1ms vibration to unlock API
}
if (typeof document !== 'undefined') {
  document.addEventListener('touchstart', _prime, { once: true });
  document.addEventListener('click', _prime, { once: true });
}

let _offRoadThrottleUntil = 0;

// Targeted haptic sources: a list of objects (typically InputManager
// instances) whose `.gamepadIndex` property identifies which gamepads
// should rumble. In solo / online MP this is just [P1's InputManager];
// in local multiplayer it's [P1 InputManager, P2 InputManager] so both
// players feel shared events like crashes and checkpoints. Resolving
// indices fresh on each call handles hot-swap automatically — when a
// controller is unplugged the source's gamepadIndex goes null and we
// skip it, and when a new pad is plugged in the updated index is read
// on the next rumble. When null, fall back to the legacy "first pad
// with a vibration actuator" behavior so this module stays usable
// standalone.
let _hapticSources = null;

/**
 * Set the list of input sources whose gamepads should receive haptic
 * feedback. Each entry is an object with a numeric `gamepadIndex`
 * property (null when no gamepad is claimed). Pass null to clear.
 * @param {Array<{gamepadIndex: number|null}>|null} sources
 */
export function setHapticSources(sources) {
  _hapticSources = sources && sources.length > 0 ? sources : null;
}

/**
 * Add a single input source to the haptic target list without
 * replacing existing sources. Used by InputManager._onSlotChange so
 * each player's InputManager independently registers itself when its
 * slot binds HID — the previous setHapticSources([this]) call was
 * replacing the whole array and dropping other players' sources in
 * local MP.
 * @param {{gamepadIndex: number|null}} src
 */
export function addHapticSource(src) {
  if (!src) return;
  if (!_hapticSources) _hapticSources = [];
  if (!_hapticSources.includes(src)) _hapticSources.push(src);
}

/**
 * Remove a single input source from the haptic target list.
 * @param {{gamepadIndex: number|null}} src
 */
export function removeHapticSource(src) {
  if (!_hapticSources || !src) return;
  const idx = _hapticSources.indexOf(src);
  if (idx >= 0) _hapticSources.splice(idx, 1);
  if (_hapticSources.length === 0) _hapticSources = null;
}

function _gamepadRumble(strong, weak, duration) {
  try {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (_hapticSources) {
      // Targeted: rumble the specific gamepad index of each source.
      // Multiple sources in local MP means both players feel the event.
      for (const src of _hapticSources) {
        if (!src) continue;

        // Skip controllers sitting idle on the desk during one-human local
        // MP — rumbling a resting controller shakes its gyro and pollutes
        // the steering merge. `isActive()` returns true by default on
        // sources that haven't opted into held-detection.
        if (typeof src.isActive === 'function' && !src.isActive()) continue;

        // Let the source suppress its in-motion bias calibration during
        // the rumble window so vibration doesn't corrupt gyro bias.
        if (typeof src.onRumbleWillFire === 'function') {
          src.onRumbleWillFire(duration);
        }

        // Prefer the driver-level rumble path when the source has a
        // controller driver that implements setRumble — e.g. DualSense on
        // macOS, where Chromium's Gamepad API vibrationActuator sometimes
        // resolves without actually writing the HID output report. The
        // driver bypass uses the same open WebHID handle already held for
        // gyro reads and is authoritative, AND works when gamepadIndex is
        // null (BT DualSense in 0x31 mode, invisible to the Gamepad API).
        // Drivers without setRumble (Switch Pro, Xbox) fall through to the
        // Gamepad API path below.
        const driver = src._controllerDriver;
        if (driver && typeof driver.setRumble === 'function') {
          driver.setRumble(strong, weak, duration).catch(() => {});
          continue;
        }

        const idx = src.gamepadIndex;
        if (idx == null) continue;
        const gp = gamepads[idx];
        if (!gp || !gp.vibrationActuator) continue;
        gp.vibrationActuator.playEffect('dual-rumble', {
          startDelay: 0,
          duration,
          weakMagnitude: weak,
          strongMagnitude: strong,
        });
      }
      return;
    }
    // Fallback: first-found pad (legacy behavior for modules that
    // haven't registered targets yet).
    for (const gp of gamepads) {
      if (!gp || !gp.vibrationActuator) continue;
      gp.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration,
        weakMagnitude: weak,
        strongMagnitude: strong,
      });
      return;
    }
  } catch { /* unsupported */ }
}

export function hapticCrash() {
  if (canVibrate) navigator.vibrate([100, 30, 200]);
  _gamepadRumble(0.8, 0.4, 300);
}

export function hapticTreeHit() {
  if (canVibrate) navigator.vibrate(150);
  _gamepadRumble(1.0, 0.5, 150);
}

export function hapticCheckpoint() {
  if (canVibrate) navigator.vibrate(50);
  _gamepadRumble(0.2, 0.3, 50);
}

export function hapticFinish() {
  if (canVibrate) navigator.vibrate([50, 50, 50, 50, 200]);
  _gamepadRumble(0.4, 0.6, 400);
}

export function hapticOffRoad(intensity) {
  const now = performance.now();
  if (now < _offRoadThrottleUntil) return;
  if (intensity < 0.1) return;

  const duration = Math.round(20 + intensity * 30);
  _offRoadThrottleUntil = now + duration + 40;

  if (canVibrate) navigator.vibrate(duration);
  _gamepadRumble(intensity * 0.3, intensity * 0.2, duration);
}
