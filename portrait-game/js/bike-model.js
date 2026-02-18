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
      this._applyTransform();
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

    // Friction
    this.speed *= (1 - 0.6 * dt);
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

    this.leanVelocity += (gravity + playerLean + gyro + damping +
      pedalWobble + lowSpeedWobble + pedalLeanKick + dangerWobble) * dt;
    this.lean += this.leanVelocity * dt;

    // Safety mode
    if (safetyMode) {
      this.lean = Math.max(-1.0, Math.min(1.0, this.lean));
    }

    // Steering from lean
    const turnRate = -this.lean * this.speed * 0.35;
    this.heading += turnRate * dt;

    // Position
    this.position.x += Math.sin(this.heading) * this.speed * dt;
    this.position.z += Math.cos(this.heading) * this.speed * dt;
    this.distanceTraveled += this.speed * dt;

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

    this._applyTransform();
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

  fullReset() {
    this._reset();
    this.position.set(0, 0, 0);
    this.heading = 0;
    this.distanceTraveled = 0;
    this.crankAngle = 0;
    this.smoothSpokeFade = 0;
    for (const spoke of this.spokeMeshes) {
      spoke.material.opacity = 1;
      spoke.visible = true;
    }
  }
}
