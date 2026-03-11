// ============================================================
// GRASS PARTICLES — dirt/grass kick-up when off-road
// ============================================================

import * as THREE from 'three';

const POOL_SIZE = 300;

// Two particle types: dirt clods (short life, low arc) and grass flecks (longer, flutter)
const TYPE_DIRT = 0;
const TYPE_GRASS = 1;

// Earth-tone palette: [r, g, b]
const DIRT_COLORS = [
  [0.45, 0.33, 0.20],  // brown
  [0.38, 0.28, 0.16],  // dark brown
  [0.52, 0.40, 0.25],  // tan
  [0.35, 0.25, 0.14],  // dark earth
  [0.48, 0.36, 0.22],  // medium brown
  [0.30, 0.22, 0.12],  // deep soil
];

const GRASS_COLORS = [
  [0.30, 0.45, 0.12],  // grass green
  [0.25, 0.38, 0.10],  // dark grass
  [0.38, 0.52, 0.18],  // light grass
  [0.22, 0.35, 0.08],  // deep green
  [0.42, 0.55, 0.22],  // bright grass
  [0.32, 0.42, 0.14],  // olive grass
];

export class GrassParticles {
  constructor(scene) {
    this.scene = scene;

    // Ring buffer state
    this.nextIndex = 0;
    this.emitAccum = 0;

    // Per-particle arrays
    this.life = new Float32Array(POOL_SIZE);
    this.maxLife = new Float32Array(POOL_SIZE);
    this.vx = new Float32Array(POOL_SIZE);
    this.vy = new Float32Array(POOL_SIZE);
    this.vz = new Float32Array(POOL_SIZE);
    this.type = new Uint8Array(POOL_SIZE);    // TYPE_DIRT or TYPE_GRASS
    this.startSize = new Float32Array(POOL_SIZE);

    // Buffer geometry
    const positions = new Float32Array(POOL_SIZE * 3);
    const colors = new Float32Array(POOL_SIZE * 3);
    const sizes = new Float32Array(POOL_SIZE);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    // All particles start dead
    this.life.fill(0);
    sizes.fill(0);

    // Material
    this.material = new THREE.PointsMaterial({
      size: 0.035,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      sizeAttenuation: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  clear() {
    this.life.fill(0);
    this.emitAccum = 0;
    const sizes = this.geometry.attributes.size.array;
    sizes.fill(0);
    this.geometry.attributes.size.needsUpdate = true;
  }

  update(bike, dt) {
    // Per-wheel off-road amounts (each wheel independently touches grass)
    const frontOff = Math.max(0, Math.abs(bike._frontWheelOffset) - 2.5);
    const rearOff = Math.max(0, Math.abs(bike._rearWheelOffset) - 2.5);
    const frontIntensity = Math.min(frontOff / 3, 1);
    const rearIntensity = Math.min(rearOff / 3, 1);
    const speed = bike.speed;

    const posAttr = this.geometry.attributes.position;
    const colorAttr = this.geometry.attributes.color;
    const sizeAttr = this.geometry.attributes.size;
    const pos = posAttr.array;
    const col = colorAttr.array;
    const sizes = sizeAttr.array;

    // Advance existing particles
    for (let i = 0; i < POOL_SIZE; i++) {
      if (this.life[i] <= 0) continue;

      this.life[i] -= dt;

      if (this.life[i] <= 0) {
        sizes[i] = 0;
        continue;
      }

      const idx = i * 3;
      const t = this.life[i] / this.maxLife[i]; // 1→0 over lifetime

      // Gravity — dirt falls faster, grass flutters
      if (this.type[i] === TYPE_DIRT) {
        this.vy[i] -= 6.0 * dt;
        // Air drag on dirt
        this.vx[i] *= (1 - 2.0 * dt);
        this.vz[i] *= (1 - 2.0 * dt);
      } else {
        this.vy[i] -= 2.5 * dt;
        // Grass flutters with air resistance + slight sideways drift
        this.vx[i] *= (1 - 3.0 * dt);
        this.vz[i] *= (1 - 3.0 * dt);
        // Tiny flutter
        this.vx[i] += (Math.random() - 0.5) * 0.8 * dt;
        this.vz[i] += (Math.random() - 0.5) * 0.8 * dt;
      }

      pos[idx]     += this.vx[i] * dt;
      pos[idx + 1] += this.vy[i] * dt;
      pos[idx + 2] += this.vz[i] * dt;

      // Clamp to ground
      if (pos[idx + 1] < bike.position.y - 0.05) {
        pos[idx + 1] = bike.position.y - 0.05;
        this.vy[i] = 0;
        this.vx[i] *= 0.5;
        this.vz[i] *= 0.5;
      }

      // Size: dirt shrinks linearly, grass holds then fades
      if (this.type[i] === TYPE_DIRT) {
        sizes[i] = this.startSize[i] * t;
      } else {
        // Grass holds size longer then shrinks in last 30%
        sizes[i] = this.startSize[i] * Math.min(1, t / 0.3);
      }
    }

    // Emit new particles — each wheel emits independently based on its own offset
    const anyOff = (frontOff > 0 || rearOff > 0);
    if (anyOff && speed > 0.5 && !bike.fallen) {
      // Compute emission rates per wheel
      const frontRate = frontOff > 0 ? frontIntensity * Math.min(speed / 3, 1) * 80 : 0;
      const rearRate = rearOff > 0 ? rearIntensity * Math.min(speed / 3, 1) * 250 : 0;
      const totalRate = frontRate + rearRate;
      const rearFraction = totalRate > 0 ? rearRate / totalRate : 0.5;
      this.emitAccum += totalRate * dt;

      const sinH = Math.sin(bike.heading);
      const cosH = Math.cos(bike.heading);

      // Rear wheel: ~2m behind center
      const rearX = bike.position.x - sinH * 2.0;
      const rearY = bike.position.y + 0.05;
      const rearZ = bike.position.z - cosH * 2.0;

      // Front wheel: ~2m ahead of center
      const frontX = bike.position.x + sinH * 2.0;
      const frontY = bike.position.y + 0.05;
      const frontZ = bike.position.z + cosH * 2.0;

      while (this.emitAccum >= 1) {
        this.emitAccum -= 1;
        const i = this.nextIndex;
        this.nextIndex = (this.nextIndex + 1) % POOL_SIZE;

        const idx = i * 3;

        // Pick wheel weighted by their emission rates
        const fromRear = Math.random() < rearFraction;
        const wx = fromRear ? rearX : frontX;
        const wy = fromRear ? rearY : frontY;
        const wz = fromRear ? rearZ : frontZ;

        // Tight spawn radius around wheel contact
        pos[idx]     = wx + (Math.random() - 0.5) * 0.3;
        pos[idx + 1] = wy;
        pos[idx + 2] = wz + (Math.random() - 0.5) * 0.3;

        // ~60% dirt, ~40% grass
        const isDirt = Math.random() < 0.6;
        this.type[i] = isDirt ? TYPE_DIRT : TYPE_GRASS;

        if (isDirt) {
          // Dirt: low fast spray behind the wheel
          const kickSpeed = speed * 0.2 + Math.random() * 0.4;
          this.vx[i] = -sinH * kickSpeed + (Math.random() - 0.5) * 0.8;
          this.vy[i] = 0.4 + Math.random() * 1.2;
          this.vz[i] = -cosH * kickSpeed + (Math.random() - 0.5) * 0.8;

          this.maxLife[i] = 0.25 + Math.random() * 0.25;
          this.life[i] = this.maxLife[i];
          this.startSize[i] = 0.015 + Math.random() * 0.025;

          const c = DIRT_COLORS[Math.floor(Math.random() * DIRT_COLORS.length)];
          col[idx]     = c[0] + (Math.random() - 0.5) * 0.06;
          col[idx + 1] = c[1] + (Math.random() - 0.5) * 0.06;
          col[idx + 2] = c[2] + (Math.random() - 0.5) * 0.04;
        } else {
          // Grass: lighter, floatier, kicked up higher
          const kickSpeed = speed * 0.15 + Math.random() * 0.3;
          this.vx[i] = -sinH * kickSpeed + (Math.random() - 0.5) * 1.2;
          this.vy[i] = 0.8 + Math.random() * 1.8;
          this.vz[i] = -cosH * kickSpeed + (Math.random() - 0.5) * 1.2;

          this.maxLife[i] = 0.4 + Math.random() * 0.4;
          this.life[i] = this.maxLife[i];
          this.startSize[i] = 0.02 + Math.random() * 0.03;

          const c = GRASS_COLORS[Math.floor(Math.random() * GRASS_COLORS.length)];
          col[idx]     = c[0] + (Math.random() - 0.5) * 0.05;
          col[idx + 1] = c[1] + (Math.random() - 0.5) * 0.05;
          col[idx + 2] = c[2] + (Math.random() - 0.5) * 0.03;
        }

        sizes[i] = this.startSize[i];
      }
    } else {
      this.emitAccum = 0;
      // When stopped or on-road, kill lingering particles quickly
      if (speed < 0.5 || bike.fallen) {
        for (let i = 0; i < POOL_SIZE; i++) {
          if (this.life[i] > 0) {
            this.life[i] -= dt * 4;  // drain 4x faster
            if (this.life[i] <= 0) {
              this.life[i] = 0;
              sizes[i] = 0;
            }
          }
        }
      }
    }

    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
  }
}
