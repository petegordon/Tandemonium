// ============================================================
// BALANCE CONTROLLER
// ============================================================

export class BalanceController {
  constructor(input) {
    this.input = input;
    this.steerFrames = { keyboard: 0, gamepad: 0, motion: 0, 'gamepad-gyro': 0 };
  }

  computeAutoSteer(bike, collectibleManager = null, obstacleManager = null) {
    if (!bike || !bike.roadPath) return 0;

    // Look-ahead: steer toward where the road is heading
    const lookAheadD = bike.roadD + bike.speed * 0.5;
    const ahead = bike.roadPath.getPointAtDistance(lookAheadD);
    const headingDiff = ahead.heading - bike.heading;
    // Normalize to [-PI, PI]
    let hDiff = headingDiff;
    if (hDiff > Math.PI) hDiff -= 2 * Math.PI;
    if (hDiff < -Math.PI) hDiff += 2 * Math.PI;

    // Lateral offset correction: steer toward road center
    const lateralCorrection = -bike._lateralOffset * 0.3;

    // Item-aware steering: attract toward collectibles, repel from obstacles
    let itemSteer = 0;
    const bikeX = bike.position.x;
    const bikeZ = bike.position.z;
    const heading = bike.heading;
    // Unit right vector perpendicular to bike heading
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);

    // Attract toward nearest uncollected collectible ahead
    if (collectibleManager && collectibleManager._items) {
      let bestDist = Infinity;
      let bestLateral = 0;
      for (const item of collectibleManager._items) {
        if (item.collected) continue;
        const aheadD = item.absoluteD - bike.distanceTraveled;
        if (aheadD < 2 || aheadD > 40) continue; // only consider items 2–40m ahead
        const pt = bike.roadPath.getPointAtDistance(item.roadD);
        const rx = Math.cos(pt.heading);
        const rz = -Math.sin(pt.heading);
        const wx = pt.x + rx * item.lateralOffset;
        const wz = pt.z + rz * item.lateralOffset;
        const dx = wx - bikeX;
        const dz = wz - bikeZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < bestDist) {
          bestDist = dist;
          // Project displacement onto bike's right vector to get lateral direction
          bestLateral = dx * rightX + dz * rightZ;
        }
      }
      if (bestDist < Infinity) {
        // Gentle attraction: stronger when closer, max ±0.25
        const strength = Math.min(0.25, 3.0 / bestDist);
        itemSteer += Math.sign(bestLateral) * strength;
      }
    }

    // Repel from nearby obstacles ahead
    if (obstacleManager && obstacleManager._items) {
      for (const item of obstacleManager._items) {
        if (item._worldX === undefined) continue;
        const aheadD = item.absoluteD - bike.distanceTraveled;
        if (aheadD < 0 || aheadD > 25) continue; // only consider obstacles 0–25m ahead
        const dx = item._worldX - bikeX;
        const dz = item._worldZ - bikeZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 8) continue; // too far laterally to matter
        // Project onto right vector
        const lateral = dx * rightX + dz * rightZ;
        // Repel: steer away, stronger when closer
        const repelStrength = Math.min(0.4, 2.0 / Math.max(dist, 0.5));
        itemSteer -= Math.sign(lateral) * repelStrength;
      }
    }

    // Combine heading alignment, lateral correction, and item steering
    const autoLean = Math.max(-1, Math.min(1, hDiff * 2.0 + lateralCorrection + itemSteer));
    return autoLean;
  }

  update(bike = null, assistWeight = 0, collectibleManager = null, obstacleManager = null) {
    let leanInput = 0;
    if (this.input.isPressed('KeyA')) { leanInput -= 1; this.steerFrames.keyboard++; }
    if (this.input.isPressed('KeyD')) { leanInput += 1; this.steerFrames.keyboard++; }
    const motion = this.input.getMotionLean();
    if (motion !== 0) {
      leanInput += motion;
      // Only count as intentional input above noise floor (avoids laptop sensor drift)
      if (Math.abs(motion) > 0.01) {
        if (this.input.gyroConnected) {
          this.steerFrames['gamepad-gyro']++;
        } else {
          this.steerFrames.motion++;
        }
      }
    }
    const gpLean = this.input.getGamepadLean();
    if (gpLean !== 0) { leanInput += gpLean; this.steerFrames.gamepad++; }
    leanInput = Math.max(-1, Math.min(1, leanInput));

    // Blend with auto-steer if assist is active
    if (assistWeight > 0 && bike) {
      const autoLean = this.computeAutoSteer(bike, collectibleManager, obstacleManager);
      leanInput = autoLean * assistWeight + leanInput * (1 - assistWeight);
      leanInput = Math.max(-1, Math.min(1, leanInput));
    }

    return { leanInput };
  }

  getSteerSource() {
    let best = 'none';
    let max = 0;
    for (const [key, count] of Object.entries(this.steerFrames)) {
      if (count > max) { max = count; best = key; }
    }
    return best;
  }

  resetSteerFrames() {
    this.steerFrames = { keyboard: 0, gamepad: 0, motion: 0, 'gamepad-gyro': 0 };
  }
}
