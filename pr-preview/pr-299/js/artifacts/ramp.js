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
    this._launched = false;
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

    if (bike.fallen) {
      // If the bike fell mid-jump, end the airborne state cleanly.
      if (this._launched) {
        this._launched = false;
        bike._airborne = false;
        bike._airYOffset = 0;
      }
      return;
    }

    // Allow re-trigger only after the bike has progressed past + lap-distance gap.
    // Detect crossing of the ramp footprint center (entering from behind).
    const r = pointInRoadRect(this.roadPath, this.p.d, this.p.offset || 0, this.p.width, this.p.length, bikePos);
    if (r && !this._launched && bikeDistanceTraveled > this._lastResetD + 50) {
      // Launch when bike center crosses the front half of the ramp
      if (r.alongNorm > 0.6) {
        this._launched = true;
        this._airT = 0;
        this._airSpeed0 = bike.speed;
        // Airtime scales with speed × ramp angle. Clamp to params hint and ground truth.
        const angleRad = this.p.angle * Math.PI / 180;
        const v0y = Math.min(8, bike.speed * Math.sin(angleRad) * 1.4);
        this._airDur = Math.max(0.2, Math.min(1.5, (2 * v0y) / 9.8));
        this._v0y = v0y;
        bike._airborne = true;
        bike._airYOffset = 0;
        this._lastResetD = bikeDistanceTraveled;
      }
    }

    // Integrate jump arc
    if (this._launched) {
      this._airT += dt;
      const t = this._airT;
      const y = this._v0y * t - 0.5 * 9.8 * t * t;
      bike._airYOffset = Math.max(0, y);
      // Keep speed roughly constant (no air drag); slight forward continuance
      if (this._airT >= this._airDur) {
        // Landing
        const cleanLanding = Math.abs(bike._lateralOffset) < 1.5;
        bike._airYOffset = 0;
        bike._airborne = false;
        this._launched = false;
        if (cleanLanding) {
          // Small forward boost as reward
          bike.speed = Math.min(bike.maxSpeed, bike.speed + 1.5);
        } else {
          // Skid: shake the bike a bit by adding lean velocity
          bike.leanVelocity += (Math.random() - 0.5) * 1.5;
          bike.speed *= 0.85;
        }
      }
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
