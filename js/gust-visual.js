// ============================================================
// GUST VISUAL — wind-blown dust streaks (E-2)
// ============================================================
//
// The gust used to be invisible. It pushed the bike's lean and nothing else
// happened on screen, so the banner said HOLD IT while the world sat perfectly
// still — and on a phone, where the push is small next to the tilt noise, there
// was nothing to notice at all.
//
// This is the wind made visible: dust drawn as short straight streaks, all
// travelling the SAME direction the bike is being pushed, so the picture and
// the physics agree. Line segments rather than points, because a streak reads
// as direction and a dot does not.
//
// Cheap by construction: one LineSegments, a fixed pool, no allocation per
// frame, and nothing at all in the loop when the wind is not blowing.

import * as THREE from 'three';
import { isMobile } from './config.js';

const POOL = isMobile ? 130 : 280;

// Where streaks are born, relative to the bike, in metres.
const SPAWN_LATERAL = 11;   // how far upwind they start
const SPAWN_AHEAD = 15;     // ahead of the rider
const SPAWN_BEHIND = 7;
const SPAWN_Y_MIN = 0.05;
const SPAWN_Y_MAX = 3.2;

const WIND_SPEED = 26;      // m/s of lateral travel at full strength
const TAIL_S = 0.08;        // how far behind the head the tail trails
const LIFE_MIN = 0.45;
const LIFE_MAX = 1.0;

// Pale road dust, so it reads against both grass and sky.
const DUST = [1.0, 0.96, 0.84];

export class GustVisual {
  constructor(scene) {
    this.scene = scene;
    this.dir = 1;          // -1 | 1, matches the lean push
    this.strength = 0;     // 0..1, the gust envelope
    this.nextIndex = 0;

    this.life = new Float32Array(POOL);
    this.maxLife = new Float32Array(POOL);
    this.hx = new Float32Array(POOL);
    this.hy = new Float32Array(POOL);
    this.hz = new Float32Array(POOL);
    this.vx = new Float32Array(POOL);
    this.vz = new Float32Array(POOL);

    // Two vertices per streak: head, then tail.
    const positions = new Float32Array(POOL * 6);
    const colors = new Float32Array(POOL * 6);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  /**
   * Blow, or stop blowing.
   * @param {number} dir       -1 or 1 — the same sign as the lean push
   * @param {number} strength  0..1, the gust envelope
   */
  setWind(dir, strength) {
    this.dir = dir >= 0 ? 1 : -1;
    this.strength = Math.max(0, Math.min(1, strength || 0));
  }

  clear() {
    this.life.fill(0);
    this.strength = 0;
    this.lines.visible = false;
    const col = this.geometry.attributes.color.array;
    col.fill(0);
    this.geometry.attributes.color.needsUpdate = true;
  }

  _spawn(bike) {
    const i = this.nextIndex;
    this.nextIndex = (this.nextIndex + 1) % POOL;

    // Start upwind, so every streak crosses the rider rather than away from them.
    const lateral = -this.dir * SPAWN_LATERAL * (0.5 + Math.random() * 0.7);
    const along = -SPAWN_BEHIND + Math.random() * (SPAWN_AHEAD + SPAWN_BEHIND);

    // The bike's heading gives us the two axes to place along.
    const fx = Math.sin(bike.heading), fz = Math.cos(bike.heading);
    const rx = fz, rz = -fx;   // right-hand perpendicular

    this.hx[i] = bike.position.x + rx * lateral + fx * along;
    this.hz[i] = bike.position.z + rz * lateral + fz * along;
    this.hy[i] = bike.position.y + SPAWN_Y_MIN + Math.random() * (SPAWN_Y_MAX - SPAWN_Y_MIN);

    const speed = WIND_SPEED * (0.7 + Math.random() * 0.6);
    this.vx[i] = rx * this.dir * speed;
    this.vz[i] = rz * this.dir * speed;

    this.maxLife[i] = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    this.life[i] = this.maxLife[i];
  }

  update(bike, dt) {
    if (!bike) return;

    // Emit while the wind is up. Rate follows the envelope, so the storm builds
    // and thins out with the push the rider is actually feeling.
    if (this.strength > 0.01) {
      const want = Math.round(POOL * 0.2 * this.strength);
      for (let n = 0; n < want; n++) this._spawn(bike);
    }

    const posAttr = this.geometry.attributes.position;
    const colAttr = this.geometry.attributes.color;
    const pos = posAttr.array;
    const col = colAttr.array;

    let alive = 0;
    for (let i = 0; i < POOL; i++) {
      const base = i * 6;
      if (this.life[i] <= 0) {
        // Collapse the segment to a point and make it black-on-transparent.
        col[base] = col[base + 1] = col[base + 2] = 0;
        col[base + 3] = col[base + 4] = col[base + 5] = 0;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;

      this.hx[i] += this.vx[i] * dt;
      this.hz[i] += this.vz[i] * dt;
      // Dust lifts a little as it goes.
      this.hy[i] += 0.6 * dt;

      // Head
      pos[base] = this.hx[i];
      pos[base + 1] = this.hy[i];
      pos[base + 2] = this.hz[i];
      // Tail, trailing straight back along the wind
      pos[base + 3] = this.hx[i] - this.vx[i] * TAIL_S;
      pos[base + 4] = this.hy[i];
      pos[base + 5] = this.hz[i] - this.vz[i] * TAIL_S;

      // Fade in over the first 20% of life and out over the last 40%.
      const t = this.life[i] / this.maxLife[i];
      const fade = Math.min(1, t / 0.4, (1 - t) / 0.2 + 0.15);
      const a = Math.max(0, fade);
      col[base] = DUST[0] * a; col[base + 1] = DUST[1] * a; col[base + 2] = DUST[2] * a;
      // The tail is dimmer, which is what makes it read as motion.
      col[base + 3] = DUST[0] * a * 0.15;
      col[base + 4] = DUST[1] * a * 0.15;
      col[base + 5] = DUST[2] * a * 0.15;
    }

    this.lines.visible = alive > 0;
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.lines);
    this.geometry.dispose();
    this.material.dispose();
  }
}
