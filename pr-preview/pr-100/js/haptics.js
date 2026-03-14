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

function _gamepadRumble(strong, weak, duration) {
  try {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
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
