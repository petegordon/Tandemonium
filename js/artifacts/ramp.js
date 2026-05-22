// ============================================================
// RAMP — wedge mesh on the road; sets bike._airYOffset during a
// jump arc, plus an airborne flag.  Clean landing = small boost.
// ============================================================

import * as THREE from 'three';
import { roadFrame, inVisibilityWindow, pointInRoadRect } from './artifact-base.js';

function makeRampMesh(skin, width, length, angle) {
  // Wedge: a quad slanted up at `angle` from the road surface.
  const angleRad = angle * Math.PI / 180;
  const height = Math.sin(angleRad) * length;
  const grp = new THREE.Group();
  const color = skin === 'metal' ? 0xa1a8b3 : skin === 'dirt' ? 0x8a5a2d : 0x7c4a26;
  // DoubleSide everywhere so the wedge reads correctly from any camera angle.
  // The slope's normal tilts toward -Z so the bike sees its back face during
  // the close approach; without DoubleSide the slope visually disappears and
  // the wedge looks "backwards".
  const mat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });

  // Top surface (the ramp face). Slope rises in the +Z direction so the bike,
  // moving along the road's forward axis, climbs the wedge and launches off
  // the high end. Rotation sign is `-angleRad` so the +Y edge of the plane
  // ends up at the LOW end (z = -halfL, y = 0) and the -Y edge at the HIGH
  // end (z = +halfL, y = height).
  const topGeo = new THREE.PlaneGeometry(width, length);
  const top = new THREE.Mesh(topGeo, mat);
  top.rotation.x = -Math.PI / 2 - angleRad;
  top.position.y = height / 2;
  top.position.z = 0;
  grp.add(top);

  // Two side triangles (BufferGeometry). Vertical edge at +halfL (high end),
  // horizontal base from -halfL to +halfL, hypotenuse rising as z increases.
  const sideGeo = new THREE.BufferGeometry();
  const halfL = length / 2;
  sideGeo.setAttribute('position', new THREE.Float32BufferAttribute([
     halfL, 0, 0,
    -halfL, 0, 0,
    -halfL, height, 0
  ], 3));
  sideGeo.setIndex([0, 1, 2]);
  sideGeo.computeVertexNormals();
  const sideL = new THREE.Mesh(sideGeo, mat);
  sideL.position.x = -width / 2;
  sideL.rotation.y = Math.PI / 2;
  grp.add(sideL);
  const sideR = new THREE.Mesh(sideGeo, mat);
  sideR.position.x = width / 2;
  sideR.rotation.y = Math.PI / 2;
  grp.add(sideR);

  // Back wall (the tall end of the ramp, so it doesn't look hollow).
  // Sits at the high end (z = +halfL) on the bike's exit side.
  const backGeo = new THREE.PlaneGeometry(width, height);
  const back = new THREE.Mesh(backGeo, mat);
  back.position.y = height / 2;
  back.position.z = halfL;
  grp.add(back);

  grp.userData.height = height;
  return grp;
}

export class Ramp {
  constructor(scene, roadPath, params) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.p = params;
    this.group = makeRampMesh(params.skin, params.width, params.length, params.angle);
    this.group.visible = false;
    scene.add(this.group);
    this._height = this.group.userData.height;

    this._airT = 0;       // seconds since launch
    this._airDur = 0;     // total airtime
    this._airSpeed0 = 0;  // launch speed
    this._v0y = 0;
    this._launchY = 0;    // bike Y at the moment of ballistic launch
    this._launched = false;
    this._onSlope = false;
    this._lastResetD = -Infinity;
  }

  update(dt, bikeDistanceTraveled, bikePos, bike) {
    const visible = inVisibilityWindow(this.p.d, bikeDistanceTraveled);
    this.group.visible = visible;
    if (visible) {
      const f = roadFrame(this.roadPath, this.p.d, this.p.offset || 0);
      this.group.position.set(f.x, f.y, f.z);
      this.group.rotation.y = f.heading;
    }

    // Detect a checkpoint/respawn reset: bike distance moved backward past
    // the last launch point. Re-arm the ramp and clear any stale airborne
    // state on the bike so a second pass triggers cleanly.
    if (bikeDistanceTraveled < this._lastResetD) {
      this._lastResetD = -Infinity;
      if (this._launched || this._onSlope) {
        this._launched = false;
        this._onSlope = false;
        bike._airborne = false;
        bike._airYOffset = 0;
      }
    }

    if (bike.fallen) {
      if (this._launched || this._onSlope) {
        this._launched = false;
        this._onSlope = false;
        bike._airborne = false;
        bike._airYOffset = 0;
      }
      return;
    }

    // Phase B: in the air after launch — integrate ballistic arc, then land.
    if (this._launched) {
      this._airT += dt;
      const t = this._airT;
      const y = this._launchY + this._v0y * t - 0.5 * 9.8 * t * t;
      if (y <= 0 || this._airT >= this._airDur) {
        const cleanLanding = Math.abs(bike._lateralOffset) < 1.5;
        bike._airYOffset = 0;
        bike._airborne = false;
        this._launched = false;
        if (cleanLanding) {
          bike.speed = Math.min(bike.maxSpeed, bike.speed + 2.0);
        } else {
          bike.leanVelocity += (Math.random() - 0.5) * 1.5;
          bike.speed *= 0.85;
        }
      } else {
        bike._airYOffset = y;
      }
      return;
    }

    // Phase A: bike is rolling across the wedge footprint. Lift the bike's
    // Y-offset linearly with progress so it visibly climbs the slope, then
    // launch off the top with the slope's apex as the starting altitude.
    const r = pointInRoadRect(this.roadPath, this.p.d, this.p.offset || 0, this.p.width, this.p.length, bikePos);
    const canEngage = bikeDistanceTraveled > this._lastResetD + 50;

    if (r && canEngage) {
      const slopeY = r.alongNorm * this._height;
      bike._airYOffset = slopeY;
      this._onSlope = true;

      // Launch near the top of the slope.
      if (r.alongNorm > 0.85) {
        const angleRad = this.p.angle * Math.PI / 180;
        const v0y = Math.min(8, bike.speed * Math.sin(angleRad) * 1.8 + 1.5);
        const g = 9.8;
        const launchY = slopeY;
        // Time until y returns to 0 (ground): solve launchY + v0y*t - 0.5*g*t² = 0.
        const airDur = Math.min(2.0, (v0y + Math.sqrt(v0y * v0y + 2 * g * launchY)) / g);

        this._launched = true;
        this._onSlope = false;
        this._airT = 0;
        this._airSpeed0 = bike.speed;
        this._v0y = v0y;
        this._launchY = launchY;
        this._airDur = airDur;
        bike._airborne = true;
        // Forward kick — the ramp throws you forward as well as up.
        bike.speed = Math.min(bike.maxSpeed, bike.speed + 1.5);
        this._lastResetD = bikeDistanceTraveled;
      }
    } else if (this._onSlope) {
      // Left the footprint without launching (stopped on the ramp, fell off
      // the side, etc.) — drop back to road level.
      this._onSlope = false;
      bike._airYOffset = 0;
    }
  }

  destroy() {
    this.scene.remove(this.group);
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
