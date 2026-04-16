// ============================================================
// GYRO-GIMBAL — 3D nested-ring gyroscope visualization
// ============================================================
// Three colored torus rings (X/Y/Z) nested inside each other. Each
// ring rotates with one component of the controller's orientation,
// giving the classic gimbal look. Driven by gyroFusion.orientation.
// ============================================================

import * as THREE from 'three';

// Swing-twist decomposition: signed angle of the "twist" component of a
// quaternion around a unit axis (ax,ay,az). Isolates rotation-around-this-axis
// from the swing component, so the three returned angles don't cross-couple
// the way euler angles do.
function twistAngle(q, ax, ay, az) {
  const d = q.x * ax + q.y * ay + q.z * az;
  // Twist quaternion is (d*ax, d*ay, d*az, q.w), before normalization.
  // Signed angle = 2 * atan2(d, q.w), with sign carried by d.
  return 2 * Math.atan2(d, q.w);
}

export class GyroGimbal {
  constructor(canvas) {
    this.canvas = canvas;
    this.disposed = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    this.camera.position.set(0, 1.6, 4.2);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
    fill.position.set(-3, -1, -2);
    this.scene.add(fill);

    // Three rings as siblings — each shows only its own axis.
    this.outer = new THREE.Group();  // Y / yaw
    this.middle = new THREE.Group(); // X / pitch
    this.inner = new THREE.Group();  // Z / roll
    // Center indicator (bars + arrow) — always carries the full orientation
    // so it reads like a physical pointer independent of ring decoupling.
    this.indicator = new THREE.Group();

    const ringGeo = (radius) => new THREE.TorusGeometry(radius, 0.04, 16, 96);
    const mat = (hex) => new THREE.MeshStandardMaterial({
      color: hex, metalness: 0.5, roughness: 0.35,
      emissive: hex, emissiveIntensity: 0.25,
    });

    // Outer ring (Y/yaw) — green, lying flat (rotated around X by 90°)
    const ringY = new THREE.Mesh(ringGeo(1.4), mat(0x44dd66));
    ringY.rotation.x = Math.PI / 2;
    this.outer.add(ringY);

    // Middle ring (X/pitch) — red, vertical front-facing
    const ringX = new THREE.Mesh(ringGeo(1.15), mat(0xee4455));
    ringX.rotation.y = Math.PI / 2;
    this.middle.add(ringX);

    // Inner ring (Z/roll) — blue, vertical side-facing
    const ringZ = new THREE.Mesh(ringGeo(0.9), mat(0x4488ff));
    this.inner.add(ringZ);

    // Center indicator: a small arrow pointing forward so orientation is readable
    // Silver center indicator — three axis bars with an arrow on the Z bar
    // pointing away from the viewer (toward the front of the controller).
    const silverMat = new THREE.MeshStandardMaterial({
      color: 0xcfd4dc, metalness: 0.7, roughness: 0.3,
    });

    const arrowBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.7, 12),
      silverMat
    );
    arrowBody.rotation.x = Math.PI / 2;
    arrowBody.position.z = 0.0;
    this.indicator.add(arrowBody);

    const arrowHead = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.25, 16),
      silverMat
    );
    arrowHead.rotation.x = -Math.PI / 2; // point -Z (into the screen)
    arrowHead.position.z = -0.45;
    this.indicator.add(arrowHead);

    const barGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.5, 12);
    const barX = new THREE.Mesh(barGeo, silverMat);
    barX.rotation.z = Math.PI / 2; // align along X
    this.indicator.add(barX);
    const barY = new THREE.Mesh(barGeo, silverMat); // along Y
    this.indicator.add(barY);

    // Center sphere
    const hub = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.6, roughness: 0.3 })
    );
    this.indicator.add(hub);

    // Siblings, not nested — so yaw doesn't drag red/blue, pitch doesn't
    // drag green/blue, roll doesn't drag green/red. Each ring shows only
    // its own axis (unless fullMode is on, where each also gets the full
    // orientation). The center indicator always gets the full orientation.
    this.scene.add(this.outer);
    this.scene.add(this.middle);
    this.scene.add(this.inner);
    this.scene.add(this.indicator);

    this._euler = new THREE.Euler();
    this._q = new THREE.Quaternion();
    this.fullMode = false; // false = mechanical nested gimbal, true = all rings share full orientation

    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || 200;
    const h = this.canvas.clientHeight || 200;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Drive rotation from a controller-orientation quaternion.
  // When null, slowly returns to identity.
  update(q) {
    if (q) {
      this._q.copy(q);
    } else {
      this._q.slerp(new THREE.Quaternion(), 0.08);
    }
    if (this.fullMode) {
      this.outer.quaternion.copy(this._q);
      this.middle.quaternion.copy(this._q);
      this.inner.quaternion.copy(this._q);
    } else {
      // Swing-twist: extract the pure rotation around each world axis from _q.
      // Independent of the other axes — unlike euler decomposition, a physical
      // pitch won't bleed into yaw/roll angles regardless of current pose.
      const pitch = twistAngle(this._q, 1, 0, 0); // around X
      const yaw   = twistAngle(this._q, 0, 1, 0); // around Y
      const roll  = twistAngle(this._q, 0, 0, 1); // around Z
      this.outer.rotation.set(pitch, 0, 0);   // green / pitch
      this.middle.rotation.set(0, 0, roll);   // red / roll
      this.inner.rotation.set(0, yaw, 0);     // blue / yaw
    }
    // Center indicator always follows full orientation
    this.indicator.quaternion.copy(this._q);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.renderer.dispose();
  }
}
