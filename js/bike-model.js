// ============================================================
// BIKE MODEL — GLB visuals + physics + remote state
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BIKE_MODEL_PATH } from './config.js';

export class BikeModel {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    // Physics state
    this.position = new THREE.Vector3(0, 0, 0);
    this.heading = 0;
    this.lean = 0;
    this.leanVelocity = 0;
    this.speed = 0;
    this.distanceTraveled = 0;
    this.crankAngle = 0;

    // Fall state
    this.fallen = false;
    this.fallTimer = 0;
    this._braking = false;
    this.boostTimer = 0;

    // Road path reference (set externally after construction)
    this.roadPath = null;
    this.roadD = 0;          // distance along road centerline
    this._lateralOffset = 0; // distance from road center (for off-road wobble)
    this._frontWheelOffset = 0; // front wheel lateral offset
    this._rearWheelOffset = 0;  // rear wheel lateral offset
    this._smoothPitch = 0;   // smoothed pitch angle for rendering

    // GLB data
    this.modelLoaded = false;
    this.spokeMeshes = [];
    this.pedalNodes = [];
    this.smoothSpokeFade = 0;
    this.maxSpeed = 16;

    this._loadModel();
  }

  _loadModel() {
    const loader = new GLTFLoader();
    loader.load(BIKE_MODEL_PATH, (gltf) => {
      const model = gltf.scene;
      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }

        const n = (child.name || '').toLowerCase();

        if (child.isMesh && (n === 'cylinder035_cycle_0' || n === 'cylinder024_cycle_0')) {
          child.material = child.material.clone();
          child.material.transparent = true;
          this.spokeMeshes.push(child);
        }

        if (n.includes('pedal')) {
          this.pedalNodes.push(child);
        }
      });

      // Scale to ~4.4m long
      const targetLength = 4.4;
      const preBox = new THREE.Box3().setFromObject(model);
      const preSize = preBox.getSize(new THREE.Vector3());
      const maxDim = Math.max(preSize.x, preSize.y, preSize.z);
      const scale = targetLength / maxDim;
      model.scale.setScalar(scale);

      this.group.add(model);
      this.group.updateMatrixWorld(true);

      // Find true bounds
      let minY = Infinity, maxY = -Infinity;
      let minX = Infinity, maxX = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      const v = new THREE.Vector3();

      model.traverse((child) => {
        if (child.isMesh && child.geometry && child.geometry.attributes.position) {
          const pos = child.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i);
            child.localToWorld(v);
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.z < minZ) minZ = v.z;
            if (v.z > maxZ) maxZ = v.z;
          }
        }
      });

      const centerX = (minX + maxX) / 2;
      const centerZ = (minZ + maxZ) / 2;
      model.position.y -= minY;
      model.position.x -= centerX;
      model.position.z -= centerZ;

      this.modelLoaded = true;
      console.log('Bike loaded. Spokes:', this.spokeMeshes.length,
        'Pedals:', this.pedalNodes.length);
    }, undefined, (err) => {
      console.error('Failed to load tandem_bicycle.glb:', err);
    });
  }

  update(pedalResult, balanceResult, dt, safetyMode, autoSpeed) {
    this.crankAngle = pedalResult.crankAngle;

    if (this.fallen) {
      this.fallTimer -= dt;
      if (this.fallTimer <= 0) this._reset();
      this._applyTransform(dt);
      return;
    }

    // Auto-speed
    if (autoSpeed && !pedalResult.braking) {
      const cruiseSpeed = 3.0;
      if (this.speed < cruiseSpeed) {
        this.speed += 2.0 * dt;
      }
    }

    // Braking
    this._braking = pedalResult.braking;
    if (pedalResult.braking) {
      this.speed *= (1 - 2.5 * dt);
      if (this.speed < 0.05) this.speed = 0;
    }

    // Acceleration
    this.speed += pedalResult.acceleration;

    // Collectible speed boost
    if (this.boostTimer > 0) {
      this.boostTimer -= dt;
      this.speed += 4.0 * dt; // sustained push
    }

    // Friction — reduced at low speeds so startup isn't brutally hard
    const frictionBase = 0.6;
    const frictionMin = 0.15;
    const frictionRamp = Math.min(1, this.speed / 4); // full friction at ~4 m/s (~14 km/h)
    this.speed *= (1 - (frictionMin + (frictionBase - frictionMin) * frictionRamp) * dt);

    // Center-strip bonus: compacted dirt in the middle 20% of road is faster
    const centerDist = Math.abs(this._lateralOffset);
    if (centerDist < 0.5 && this.speed > 0.5) {
      this.speed *= (1 + 0.3 * (1 - centerDist / 0.5) * dt); // gentle boost
    }

    // Road-edge drag: drifting toward the edges of the dirt path slows you
    if (centerDist > 0.5 && centerDist <= 2.5 && this.speed > 0) {
      const edgeFrac = (centerDist - 0.5) / 2.0; // 0→1 across road width
      this.speed *= (1 - edgeFrac * 0.8 * dt);    // moderate drag near edges
    }

    // Grass drag: off-road surface slows you down significantly
    const offRoadDrag = Math.max(0, centerDist - 2.5);
    if (offRoadDrag > 0 && this.speed > 0) {
      const dragIntensity = Math.min(offRoadDrag / 3, 1); // 0→1 over 3 units
      this.speed *= (1 - dragIntensity * 1.5 * dt);       // strong off-road friction
    }

    this.speed = Math.max(0, Math.min(this.speed, this.maxSpeed));

    // Balance physics (portrait-tuned: softer response, more damping)
    const gravity = Math.sin(this.lean) * 4.0;
    const playerLean = balanceResult.leanInput * 14.0;
    const gyro = -this.lean * Math.min(this.speed * 0.8, 6.0);
    const damping = -this.leanVelocity * 2.5;

    const pedalWobble = pedalResult.wobble * (Math.random() - 0.5) * 2;

    const t = performance.now() / 1000;
    const lowSpeedWobble = Math.max(0, 1 - this.speed * 0.3) *
      (Math.sin(t * 2.7) * 0.3 + Math.sin(t * 4.3) * 0.15);

    let pedalLeanKick = 0;
    if (pedalResult.acceleration > 0 && !pedalResult.braking) {
      pedalLeanKick = (Math.random() - 0.5) * 0.2;
    }

    // Danger-zone wobble: progressive shake as lean approaches crash
    let dangerWobble = 0;
    const dangerRatio = Math.abs(this.lean) / 1.35;
    if (dangerRatio > 0.55) {
      const intensity = (dangerRatio - 0.55) / 0.45; // 0→1 from yellow to crash
      dangerWobble = intensity * (Math.sin(t * 11) * 0.4 + Math.sin(t * 17) * 0.25);
    }

    // Grass wobble: rough terrain when off-road
    let grassWobble = 0;
    const offRoad = Math.max(0, Math.abs(this._lateralOffset) - 2.5);
    if (offRoad > 0 && this.speed > 0.1) {
      const grassIntensity = Math.min(offRoad / 3, 1); // ramps up over 3 units off-road
      grassWobble = grassIntensity * this.speed * 0.15 *
        (Math.sin(t * 13.7) * 0.5 + Math.sin(t * 23.1) * 0.3 + (Math.random() - 0.5) * 0.4);
    }

    this.leanVelocity += (gravity + playerLean + gyro + damping +
      pedalWobble + lowSpeedWobble + pedalLeanKick + dangerWobble + grassWobble) * dt;
    this.lean += this.leanVelocity * dt;

    // Safety mode
    if (safetyMode) {
      this.lean = Math.max(-1.0, Math.min(1.0, this.lean));
    }

    // Steering from lean
    const turnRate = -this.lean * this.speed * 0.35;
    this.heading += turnRate * dt;

    // Slope physics — uphill decelerates, downhill accelerates
    // Reduced at low speeds so hills don't stall startup
    if (this.roadPath && this.speed > 0.01) {
      const slope = this.roadPath.getSlopeAtDistance(this.roadD);
      const slopeRamp = Math.min(1, this.speed / 4);
      this.speed -= slope * 9.8 * dt * 0.3 * slopeRamp;
      this.speed = Math.max(0, Math.min(this.speed, this.maxSpeed));
    }

    // Position
    this.position.x += Math.sin(this.heading) * this.speed * dt;
    this.position.z += Math.cos(this.heading) * this.speed * dt;

    // Track road distance (smoothed, wrap-aware) and set terrain height
    if (this.roadPath) {
      const info = this.roadPath.getClosestRoadInfo(this.position.x, this.position.z, this.roadD);
      if (info) {
        const prevRoadD = this.roadD;
        let diff = info.d - this.roadD;
        const L = this.roadPath.loopLength;
        if (diff > L / 2) diff -= L;
        if (diff < -L / 2) diff += L;
        this.roadD += diff * Math.min(1, 15 * dt);
        this.roadD = ((this.roadD % L) + L) % L;

        // Update distanceTraveled from road progress, not path length.
        // Going sideways or in circles doesn't count; going backward subtracts.
        let roadDelta = this.roadD - prevRoadD;
        if (roadDelta > L / 2) roadDelta -= L;
        if (roadDelta < -L / 2) roadDelta += L;
        this.distanceTraveled = Math.max(0, this.distanceTraveled + roadDelta);

        this._lateralOffset = info.lateralOffset;

        // Per-wheel lateral offsets (front +2m, rear -2m along heading)
        const sinH = Math.sin(this.heading);
        const cosH = Math.cos(this.heading);
        const frontInfo = this.roadPath.getClosestRoadInfo(
          this.position.x + sinH * 2.0, this.position.z + cosH * 2.0, this.roadD);
        const rearInfo = this.roadPath.getClosestRoadInfo(
          this.position.x - sinH * 2.0, this.position.z - cosH * 2.0, this.roadD);
        this._frontWheelOffset = frontInfo ? frontInfo.lateralOffset : this._lateralOffset;
        this._rearWheelOffset = rearInfo ? rearInfo.lateralOffset : this._lateralOffset;

        this.position.y = this.roadPath.getPointAtDistance(this.roadD).y;
      }
    }

    // Fall detection
    if (Math.abs(this.lean) > 1.35) {
      this._fall();
    }

    // Spoke fade (asymmetric: 8x out, 1.2x in)
    if (this.spokeMeshes.length > 0) {
      const targetFade = Math.min(this.speed / (this.maxSpeed * 0.2), 1);
      const rate = targetFade > this.smoothSpokeFade ? 8 : 1.2;
      this.smoothSpokeFade += (targetFade - this.smoothSpokeFade) * Math.min(1, rate * dt);
      const opacity = 1 - this.smoothSpokeFade;
      for (const spoke of this.spokeMeshes) {
        spoke.material.opacity = opacity;
        spoke.visible = opacity > 0.02;
      }
    }

    // Pedal crank animation
    if (this.speed > 0.01) {
      const pedalSpin = this.speed * dt * 1.5;
      for (const node of this.pedalNodes) {
        node.rotation.z += pedalSpin;
      }
    }

    this._applyTransform(dt);
  }

  // Apply remote state from network (stoker-side, no physics)
  applyRemoteState(state) {
    this.position.set(state.x, state.y, state.z);
    this.heading = state.heading;
    this.lean = state.lean;
    this.leanVelocity = state.leanVelocity;
    this.speed = state.speed;
    this.distanceTraveled = state.distanceTraveled;
    this.crankAngle = state.crankAngle || 0;
    this.fallen = !!(state.flags & 1);
    this._braking = !!(state.flags & 2);

    // Use captain's authoritative roadD (smoothed, wrap-aware, with snap for large jumps)
    if (state.roadD !== undefined) {
      let diff = state.roadD - this.roadD;
      const L = this.roadPath ? this.roadPath.loopLength : 0;
      if (L) {
        if (diff > L / 2) diff -= L;
        if (diff < -L / 2) diff += L;
      }
      if (Math.abs(diff) > 10) {
        this.roadD = state.roadD;
      } else {
        this.roadD += diff * Math.min(1, 15 * (1 / 60));
      }
      if (L) {
        this.roadD = ((this.roadD % L) + L) % L;
      }
    }

    // Compute lateral offsets for particles (stoker-side)
    if (this.roadPath) {
      const info = this.roadPath.getClosestRoadInfo(this.position.x, this.position.z, this.roadD);
      if (info) {
        this._lateralOffset = info.lateralOffset;
        const sinH = Math.sin(this.heading);
        const cosH = Math.cos(this.heading);
        const frontInfo = this.roadPath.getClosestRoadInfo(
          this.position.x + sinH * 2.0, this.position.z + cosH * 2.0, this.roadD);
        const rearInfo = this.roadPath.getClosestRoadInfo(
          this.position.x - sinH * 2.0, this.position.z - cosH * 2.0, this.roadD);
        this._frontWheelOffset = frontInfo ? frontInfo.lateralOffset : this._lateralOffset;
        this._rearWheelOffset = rearInfo ? rearInfo.lateralOffset : this._lateralOffset;
      }
    }

    // Spoke fade
    if (this.spokeMeshes.length > 0) {
      const targetFade = Math.min(this.speed / (this.maxSpeed * 0.2), 1);
      const dt = 1 / 60;
      const rate = targetFade > this.smoothSpokeFade ? 8 : 1.2;
      this.smoothSpokeFade += (targetFade - this.smoothSpokeFade) * Math.min(1, rate * dt);
      const opacity = 1 - this.smoothSpokeFade;
      for (const spoke of this.spokeMeshes) {
        spoke.material.opacity = opacity;
        spoke.visible = opacity > 0.02;
      }
    }

    // Pedal crank
    if (this.speed > 0.01) {
      const dt = 1 / 60;
      const pedalSpin = this.speed * dt * 1.5;
      for (const node of this.pedalNodes) {
        node.rotation.z += pedalSpin;
      }
    }

    this._applyTransform(1 / 60);
  }

  _applyTransform(dt) {
    this.group.position.copy(this.position);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), this.heading
    );
    const qLean = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1), this.lean
    );

    // Pitch from road slope (smoothed)
    let qPitch;
    if (this.roadPath) {
      const slope = this.roadPath.getSlopeAtDistance(this.roadD);
      const targetPitch = -Math.atan(slope);
      const t = dt ? Math.min(1, 20 * dt) : 1;
      this._smoothPitch += (targetPitch - this._smoothPitch) * t;
      qPitch = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0), this._smoothPitch
      );
    } else {
      qPitch = new THREE.Quaternion();
    }

    const q = new THREE.Quaternion();
    q.multiplyQuaternions(qYaw, qPitch);
    q.multiply(qLean);
    this.group.quaternion.copy(q);
  }

  _fall() {
    this.fallen = true;
    this.fallTimer = 2.0;
    this.speed = 0;
    this.lean = Math.sign(this.lean) * Math.PI / 2.2;
    this.leanVelocity = 0;
    const terrainY = this.roadPath
      ? this.roadPath.getHeightAtWorld(this.position.x, this.position.z, this.roadD)
      : 0;
    this.position.y = terrainY - 0.15;
  }

  _reset() {
    this.fallen = false;
    this.lean = 0;
    this.leanVelocity = 0;
    this.speed = 0;
    const terrainY = this.roadPath
      ? this.roadPath.getHeightAtWorld(this.position.x, this.position.z, this.roadD)
      : 0;
    this.position.y = terrainY;
  }

  fullReset() {
    this.resetToDistance(0);
  }

  resetToDistance(distance) {
    this.fallen = false;
    this.lean = 0;
    this.leanVelocity = 0;
    this.speed = 0;
    this._smoothPitch = 0;

    const roadD = this.roadPath ? (distance % this.roadPath.loopLength) : 0;
    this.roadD = roadD;

    if (this.roadPath) {
      const pt = this.roadPath.getPointAtDistance(roadD);
      this.position.set(pt.x, pt.y, pt.z);
      this.heading = pt.heading;
    } else {
      this.position.set(0, 0, 0);
      this.heading = 0;
    }

    this.distanceTraveled = distance;
    this.crankAngle = 0;
    this.smoothSpokeFade = 0;
    for (const spoke of this.spokeMeshes) {
      spoke.material.opacity = 1;
      spoke.visible = true;
    }
  }
}
