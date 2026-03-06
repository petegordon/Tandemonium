// ============================================================
// HAPTICS — vibration feedback (mobile + gamepad)
// ============================================================

const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

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
  if (canVibrate) navigator.vibrate(200);
  _gamepadRumble(0.8, 0.4, 200);
}

export function hapticTreeHit() {
  if (canVibrate) navigator.vibrate(100);
  _gamepadRumble(1.0, 0.5, 100);
}

export function hapticCheckpoint() {
  if (canVibrate) navigator.vibrate(50);
  _gamepadRumble(0.2, 0.3, 50);
}

export function hapticFinish() {
  if (canVibrate) navigator.vibrate([50, 50, 50, 50, 100]);
  _gamepadRumble(0.4, 0.6, 300);
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
