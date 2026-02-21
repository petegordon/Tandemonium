// ============================================================
// CHASE CAMERA (portrait-optimized)
// ============================================================

import * as THREE from 'three';

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.currentPos = new THREE.Vector3();
    this.currentLook = new THREE.Vector3();
    this.shakeAmount = 0;
    this.initialized = false;

    // Offsets: Y = height, Z = behind(-)/ahead(+)
    this.offsetSlow = new THREE.Vector3(0, 6, -5);
    this.lookSlow = new THREE.Vector3(0, 0.5, 1);
    this.offsetFast = new THREE.Vector3(0, 4, -12);
    this.lookFast = new THREE.Vector3(0, 0.2, 8);
  }

  update(bike, dt, roadPath) {
    const fwd = new THREE.Vector3(Math.sin(bike.heading), 0, Math.cos(bike.heading));
    const speedT = Math.min(bike.speed / 10, 1);

    const offY = this.offsetSlow.y + (this.offsetFast.y - this.offsetSlow.y) * speedT;
    const offZ = this.offsetSlow.z + (this.offsetFast.z - this.offsetSlow.z) * speedT;
    const lookY = this.lookSlow.y + (this.lookFast.y - this.lookSlow.y) * speedT;
    const lookZ = this.lookSlow.z + (this.lookFast.z - this.lookSlow.z) * speedT;

    const desiredPos = bike.position.clone()
      .add(fwd.clone().multiplyScalar(offZ))
      .add(new THREE.Vector3(0, offY, 0));

    const desiredLook = bike.position.clone()
      .add(fwd.clone().multiplyScalar(lookZ))
      .add(new THREE.Vector3(0, lookY, 0));

    // Lift camera and look target above terrain so they don't clip through hills
    if (roadPath) {
      const camTerrainY = roadPath.getHeightAtWorld(desiredPos.x, desiredPos.z, bike.roadD);
      const minCamY = camTerrainY + offY * 0.5;
      if (desiredPos.y < minCamY) desiredPos.y = minCamY;

      const lookTerrainY = roadPath.getHeightAtWorld(desiredLook.x, desiredLook.z, bike.roadD);
      const minLookY = lookTerrainY + lookY;
      if (desiredLook.y < minLookY) desiredLook.y = minLookY;
    }

    if (!this.initialized) {
      this.currentPos.copy(desiredPos);
      this.currentLook.copy(desiredLook);
      this.initialized = true;
    }

    const camSmooth = Math.min(1, 2.5 * dt);
    this.currentPos.lerp(desiredPos, camSmooth);
    this.currentLook.lerp(desiredLook, camSmooth);

    const shake = new THREE.Vector3();
    if (bike.speed > 8) {
      this.shakeAmount = Math.max(this.shakeAmount, (bike.speed - 8) * 0.02);
    }
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
