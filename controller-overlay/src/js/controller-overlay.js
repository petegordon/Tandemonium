// ============================================================
// CONTROLLER OVERLAY — 3D WebGL controller visualization
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PROFILES } from './controller-profiles.js';

const DEADZONE = 0.08;
const LERP_SPEED = 0.25; // Smoothing factor for animations

export class ControllerOverlay {
  /**
   * @param {Object} options
   * @param {HTMLCanvasElement} options.canvas — target canvas element
   * @param {boolean} [options.transparent=true] — transparent background
   * @param {string} [options.controllerType='dualsense'] — profile key
   */
  constructor(options = {}) {
    this.canvas = options.canvas;
    this.transparent = options.transparent !== false;
    this.controllerType = options.controllerType || 'dualsense';

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;

    this.model = null;
    this.bodyGroup = null; // Group for gyro rotation

    // Mesh references keyed by profile mesh name
    this.meshes = {};
    // Snapshot of original transforms per mesh name
    this.originals = {};

    // Current animated state (for lerping)
    this.animState = {
      buttons: {},   // meshName → current press offset
      triggers: {},  // meshName → current angle
      sticks: {},    // meshName → { tiltX, tiltZ }
      gyro: new THREE.Quaternion(),
    };

    this.stickPivots = {}; // 'left'|'right' → pivot Group
    this._animationId = null;
    this._disposed = false;

    // Touchpad visualization state
    this._touchIndicators = [null, null]; // per-finger { sphere, ring, glow }
    this._touchStrokes = { group: null, active: [null, null], prevActive: [false, false], prevId: [-1, -1] };
    this._touchColors = [0x44aaff, 0xff4444]; // blue, red
    this._touchpadBounds = null; // { minX, maxX, minZ, maxZ, topY, mesh }
    this._touchpadClickState = false;
    this._glowTexture = null;
    this._touchRaycaster = new THREE.Raycaster();
  }

  async init() {
    const { canvas, transparent } = this;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: transparent,
      antialias: true,
      premultipliedAlpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    if (transparent) {
      this.renderer.setClearColor(0x000000, 0);
    }

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      45,
      canvas.clientWidth / canvas.clientHeight,
      0.01,
      100
    );
    this.camera.position.set(0, 0.15, 0.35);

    // Orbit controls — rotation disabled (gyro handles that), zoom only
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableRotate = false;
    this.controls.enablePan = false;
    this.controls.enableZoom = true;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = 0.1;
    this.controls.maxDistance = 2;

    // Lighting — studio setup with strong front light
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(2, 3, 2);
    this.scene.add(keyLight);

    const frontLight = new THREE.DirectionalLight(0xffffff, 0.8);
    frontLight.position.set(0, 1, 3);
    this.scene.add(frontLight);

    const fillLight = new THREE.DirectionalLight(0xb0c4de, 0.5);
    fillLight.position.set(-2, 1, -1);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
    rimLight.position.set(0, -1, -2);
    this.scene.add(rimLight);

    // Body group for gyro rotation
    this.bodyGroup = new THREE.Group();
    this.scene.add(this.bodyGroup);

    // Load model
    await this._loadModel();

    // Start render loop
    this._animate();
  }

  async _loadModel() {
    const profile = PROFILES[this.controllerType];
    if (!profile) {
      console.error(`Unknown controller type: ${this.controllerType}`);
      return;
    }

    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(
        profile.model,
        (gltf) => {
          this._setupModel(gltf.scene, profile);
          resolve();
        },
        undefined,
        (err) => {
          console.error(`Failed to load model ${profile.model}:`, err);
          // Fall back to a placeholder
          this._createPlaceholder(profile);
          resolve();
        }
      );
    });
  }

  _setupModel(scene, profile) {
    // Normalize model size — fit into a ~0.25m bounding sphere
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const targetSize = 0.25;
    const scale = targetSize / maxDim;
    scene.scale.setScalar(scale);

    // Center the model
    const center = new THREE.Vector3();
    box.getCenter(center);
    scene.position.sub(center.multiplyScalar(scale));

    this.bodyGroup.add(scene);
    this.model = scene;

    // Collect mesh names that need special pivot handling
    const triggerMeshNames = new Set(Object.values(profile.triggerMap));

    // Collect all stick mesh names into a set for identification
    const stickMeshNames = new Set();
    const stickAssemblies = {}; // 'left' | 'right' → { meshes[], pivotKey }
    for (const [key, stick] of Object.entries(profile.stickMap)) {
      const names = stick.meshes || [stick.mesh];
      for (const n of names) stickMeshNames.add(n);
      stickAssemblies[key] = { names, stick };
    }

    // Pass 1: index all meshes by name and clone shared materials
    // GLB loader shares material instances for identical materials, so
    // pressing one button would glow all buttons with the same color.
    const meshByName = {};
    scene.traverse((child) => {
      if (child.isMesh) {
        meshByName[child.name] = child;
        // Clone material so each mesh can animate independently
        if (child.material) {
          child.material = child.material.clone();
        }
      }
    });

    // Pass 2: create stick pivot groups — group all parts of each stick
    // assembly into a single pivot at the base of the stick shaft
    this.stickPivots = {};
    for (const [key, asm] of Object.entries(stickAssemblies)) {
      const parts = asm.names.map(n => meshByName[n]).filter(Boolean);
      if (parts.length === 0) continue;

      // Find the lowest Y across all parts — that's the tilt base
      let pivotY = Infinity, pivotX = 0, pivotZ = 0;
      let partCount = 0;
      for (const part of parts) {
        part.geometry.computeBoundingBox();
        const bb = part.geometry.boundingBox;
        pivotY = Math.min(pivotY, bb.min.y);
        pivotX += (bb.min.x + bb.max.x) / 2;
        pivotZ += (bb.min.z + bb.max.z) / 2;
        partCount++;
      }
      pivotX /= partCount;
      pivotZ /= partCount;

      // Create pivot group at the base of the stick
      const pivot = new THREE.Group();
      pivot.name = key + '_stick_pivot';
      pivot.position.set(pivotX, pivotY, pivotZ);

      // Reparent all parts into the pivot, offsetting geometry
      const sceneParent = parts[0].parent;
      for (const part of parts) {
        part.geometry.translate(-pivotX, -pivotY, -pivotZ);
        const parent = part.parent;
        parent.remove(part);
        part.position.set(0, 0, 0);
        part.rotation.set(0, 0, 0);
        pivot.add(part);
      }
      sceneParent.add(pivot);

      this.stickPivots[key] = pivot;
      // Also register individual meshes for lookup
      for (const part of parts) {
        this.meshes[part.name] = part;
      }
    }

    // Pass 3: set up trigger pivots
    const allMeshes = Object.values(meshByName).filter(
      m => !stickMeshNames.has(m.name)  // sticks already handled
    );
    for (const child of allMeshes) {
      if (triggerMeshNames.has(child.name) && child.geometry) {
        child.geometry.computeBoundingBox();
        const bb = child.geometry.boundingBox;
        // Trigger pivot at the top-back (hinge point)
        const pivotX = (bb.min.x + bb.max.x) / 2;
        const pivotY = bb.max.y;
        const pivotZ = bb.min.z;

        child.geometry.translate(-pivotX, -pivotY, -pivotZ);

        const pivot = new THREE.Group();
        pivot.name = child.name + '_pivot';
        pivot.position.set(pivotX, pivotY, pivotZ);

        const parent = child.parent;
        parent.remove(child);
        child.position.set(0, 0, 0);
        child.rotation.set(0, 0, 0);
        pivot.add(child);
        parent.add(pivot);

        this.meshes[child.name] = pivot;
        this.originals[child.name] = {
          posX: pivot.position.x,
          posY: pivot.position.y,
          posZ: pivot.position.z,
          rotX: 0, rotZ: 0,
        };
      } else {
        this.meshes[child.name] = child;
        this.originals[child.name] = {
          posX: child.position.x,
          posY: child.position.y,
          posZ: child.position.z,
          rotX: child.rotation.x,
          rotZ: child.rotation.z,
        };
      }
    }

    // Fix meshes that should be body-colored but are dark in the GLB
    for (const name of ['touchpad', 'button_create', 'button_options']) {
      const m = meshByName[name];
      if (m?.material) m.material.color.set(0xe8e8ec);
    }

    // Hide static blue dot meshes — replaced by dynamic touch indicators
    for (const name of ['touch_point1', 'touch_point2']) {
      const m = meshByName[name];
      if (m) m.visible = false;
    }

    // Set up touchpad visualization if touchpad mesh exists
    const tpMesh = meshByName['touchpad'];
    if (tpMesh && profile.hasTouchpad) {
      tpMesh.geometry.computeBoundingBox();
      this._touchpadBounds = {
        minX: tpMesh.geometry.boundingBox.min.x,
        maxX: tpMesh.geometry.boundingBox.max.x,
        minZ: tpMesh.geometry.boundingBox.min.z,
        maxZ: tpMesh.geometry.boundingBox.max.z,
        topY: tpMesh.geometry.boundingBox.max.y + 0.02,
        mesh: tpMesh,
      };
      this._setupTouchIndicators();
    }

    // Log found meshes for debugging
    const profileMeshes = [
      ...Object.values(profile.buttonMap),
      ...Object.values(profile.triggerMap),
      ...Object.values(profile.stickMap).flatMap((s) => s.meshes || [s.mesh]),
      ...(profile.bodyMeshes || []),
      profile.touchpadMesh,
    ].filter(Boolean);

    const found = profileMeshes.filter((m) => this.meshes[m]);
    const missing = profileMeshes.filter((m) => !this.meshes[m]);
    console.log(
      `Controller model loaded: ${found.length}/${profileMeshes.length} meshes mapped`,
      missing.length ? `\nMissing: ${missing.join(', ')}` : ''
    );
  }

  /**
   * Create a simple placeholder when no GLB model is available.
   * Renders a rounded-box approximation of a controller.
   */
  _createPlaceholder(profile) {
    const group = new THREE.Group();

    // Body — rounded box
    const bodyGeo = new THREE.BoxGeometry(0.2, 0.04, 0.12, 4, 4, 4);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a2e,
      roughness: 0.5,
      metalness: 0.3,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.name = profile.bodyMesh || 'body';
    group.add(body);

    // Face buttons — 4 small spheres
    const btnGeo = new THREE.SphereGeometry(0.006, 16, 16);
    const btnColors = { face_cross: 0x4488ff, face_circle: 0xff4444, face_square: 0xff44aa, face_triangle: 0x44ff88 };
    const btnPositions = [
      [0.06, 0.025, -0.01],  // cross/A
      [0.07, 0.025, -0.02],  // circle/B
      [0.05, 0.025, -0.02],  // square/X
      [0.06, 0.025, -0.03],  // triangle/Y
    ];
    const btnNames = Object.values(profile.buttonMap).slice(0, 4);
    btnNames.forEach((name, i) => {
      const mat = new THREE.MeshStandardMaterial({
        color: Object.values(btnColors)[i] || 0x888888,
        roughness: 0.4,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(btnGeo, mat);
      mesh.name = name;
      mesh.position.set(...(btnPositions[i] || [0, 0.025, 0]));
      group.add(mesh);
    });

    // Sticks — two cylinders
    const stickGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.015, 16);
    const stickMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.6 });
    Object.values(profile.stickMap).forEach((stick, i) => {
      const mesh = new THREE.Mesh(stickGeo, stickMat.clone());
      mesh.name = stick.mesh;
      mesh.position.set(i === 0 ? -0.04 : 0.03, 0.025, i === 0 ? -0.01 : 0.01);
      group.add(mesh);
    });

    // Triggers — two flat boxes
    const trigGeo = new THREE.BoxGeometry(0.03, 0.005, 0.015);
    const trigMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.5 });
    Object.values(profile.triggerMap).forEach((name, i) => {
      const mesh = new THREE.Mesh(trigGeo, trigMat.clone());
      mesh.name = name;
      mesh.position.set(i === 0 ? -0.07 : 0.07, 0.02, -0.05);
      group.add(mesh);
    });

    this.bodyGroup.add(group);
    this.model = group;

    // Index all placeholder meshes
    group.traverse((child) => {
      if (child.isMesh) {
        this.meshes[child.name] = child;
        this.originals[child.name] = {
          posX: child.position.x,
          posY: child.position.y,
          posZ: child.position.z,
          rotX: child.rotation.x,
          rotZ: child.rotation.z,
        };
      }
    });

    console.log('Placeholder controller model created');
  }

  /**
   * Update the overlay with current input state.
   * @param {Gamepad|null} gamepad — from navigator.getGamepads()
   * @param {THREE.Quaternion|null} gyroQuaternion — from WebHID gyro integration
   */
  update(gamepad, gyroQuaternion) {
    if (this._disposed || !this.model) return;

    const profile = PROFILES[this.controllerType];
    if (!profile) return;

    // ── Buttons (digital press) ──
    if (gamepad?.buttons) {
      for (const [indexStr, meshName] of Object.entries(profile.buttonMap)) {
        const index = parseInt(indexStr);
        const btn = gamepad.buttons[index];
        if (!btn) continue;

        const mesh = this.meshes[meshName];
        const orig = this.originals[meshName];
        if (!mesh || !orig) continue;

        const targetY = orig.posY - (btn.pressed ? profile.pressDepth : 0);
        mesh.position.y = THREE.MathUtils.lerp(mesh.position.y, targetY, LERP_SPEED);

        // Yellow emissive glow on press
        const mat = mesh.isMesh ? mesh.material :
                    (mesh.children?.[0]?.isMesh ? mesh.children[0].material : null);
        if (mat && 'emissive' in mat) {
          if (!mat._btnEmissiveSet) {
            mat._btnEmissiveSet = true;
            mat.emissive.set(0xffcc00);
          }
          const targetIntensity = btn.pressed ? 3.0 : 0;
          mat.emissiveIntensity = THREE.MathUtils.lerp(
            mat.emissiveIntensity, targetIntensity, LERP_SPEED
          );
        }
      }

      // ── Triggers (analog) ──
      for (const [indexStr, meshName] of Object.entries(profile.triggerMap)) {
        const index = parseInt(indexStr);
        const btn = gamepad.buttons[index];
        if (!btn) continue;

        const mesh = this.meshes[meshName];
        const orig = this.originals[meshName];
        if (!mesh || !orig) continue;

        const targetAngle = orig.rotX - btn.value * profile.triggerMaxAngle;
        mesh.rotation.x = THREE.MathUtils.lerp(mesh.rotation.x, targetAngle, LERP_SPEED);

        // Yellow emissive glow scaling with trigger pull depth
        const trigMat = mesh.children?.[0]?.isMesh ? mesh.children[0].material : null;
        if (trigMat && 'emissive' in trigMat) {
          if (!trigMat._trigEmissiveSet) {
            trigMat._trigEmissiveSet = true;
            trigMat.emissive.set(0xffcc00);
          }
          const targetGlow = btn.value > 0.05 ? btn.value * 3.0 : 0;
          trigMat.emissiveIntensity = THREE.MathUtils.lerp(
            trigMat.emissiveIntensity, targetGlow, LERP_SPEED
          );
        }
      }
    }

    // ── Sticks (analog tilt) — rotate the entire stick assembly pivot ──
    if (gamepad?.axes && this.stickPivots) {
      for (const [key, stick] of Object.entries(profile.stickMap)) {
        const pivot = this.stickPivots[key];
        if (!pivot) continue;

        let axisX = gamepad.axes[stick.axisX] || 0;
        let axisY = gamepad.axes[stick.axisY] || 0;

        // Deadzone
        if (Math.abs(axisX) < DEADZONE) axisX = 0;
        if (Math.abs(axisY) < DEADZONE) axisY = 0;

        const targetTiltX = axisY * profile.stickMaxTilt;
        const targetTiltZ = -axisX * profile.stickMaxTilt;
        pivot.rotation.x = THREE.MathUtils.lerp(pivot.rotation.x, targetTiltX, LERP_SPEED);
        pivot.rotation.z = THREE.MathUtils.lerp(pivot.rotation.z, targetTiltZ, LERP_SPEED);

        // Stick glow: blue gradient on tilt, yellow on L3/R3 press
        const magnitude = Math.min(1, Math.sqrt(axisX * axisX + axisY * axisY));
        const stickMeshes = stick.meshes || [];
        // L3 = button 10, R3 = button 11
        const pressBtn = gamepad?.buttons?.[key === 'left' ? 10 : 11];
        const isPressed = pressBtn?.pressed || false;

        // Colors: blue gradient for tilt, yellow for click
        const tiltColors = [0x00ddff, 0x3388ff, 0x2244cc]; // cap, ring, base
        const tiltPeaks  = [4.0,     2.5,     1.2];
        const pressColor = 0xffcc00;
        const pressPeak  = 3.0;

        for (let si = 0; si < stickMeshes.length; si++) {
          const part = this.meshes[stickMeshes[si]];
          if (!part?.isMesh) continue;
          const partMat = part.material;
          if (!partMat || !('emissive' in partMat)) continue;

          // Switch emissive color between yellow (press) and blue (tilt)
          if (isPressed) {
            partMat.emissive.set(pressColor);
            const targetGlow = pressPeak;
            partMat.emissiveIntensity = THREE.MathUtils.lerp(
              partMat.emissiveIntensity, targetGlow, LERP_SPEED
            );
          } else {
            partMat.emissive.set(tiltColors[si] || 0x3388ff);
            const targetGlow = magnitude > 0 ? magnitude * (tiltPeaks[si] || 2.0) : 0;
            partMat.emissiveIntensity = THREE.MathUtils.lerp(
              partMat.emissiveIntensity, targetGlow, LERP_SPEED
            );
          }
        }
      }
    }

    // ── Gyro (body rotation) ──
    if (gyroQuaternion && this.bodyGroup) {
      this.animState.gyro.slerp(gyroQuaternion, LERP_SPEED);
      this.bodyGroup.quaternion.copy(this.animState.gyro);
    }
  }

  _animate() {
    if (this._disposed) return;
    this._animationId = requestAnimationFrame(() => this._animate());

    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Switch controller type. Unloads current model and loads new one.
   * @param {string} type — profile key
   */
  async setControllerType(type) {
    if (type === this.controllerType && this.model) return;
    this.controllerType = type;

    // Remove current model
    if (this.model) {
      this.bodyGroup.remove(this.model);
      this.model.traverse((child) => {
        if (child.isMesh) {
          child.geometry?.dispose();
          if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
              m.map?.dispose();
              m.normalMap?.dispose();
              m.roughnessMap?.dispose();
              m.metalnessMap?.dispose();
              m.dispose();
            });
          }
        }
      });
      this.model = null;
    }

    this.meshes = {};
    this.originals = {};
    this.stickPivots = {};

    await this._loadModel();
  }

  /**
   * Resize the renderer.
   */
  resize(width, height) {
    if (this._disposed) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  /**
   * Set the opacity of the entire controller model (0-1).
   * @param {number} opacity — 0 (invisible) to 1 (fully opaque)
   */
  setOpacity(opacity) {
    if (!this.model) return;
    this.model.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material.transparent = opacity < 1;
        child.material.opacity = opacity;
        child.material.needsUpdate = true;
      }
    });
    // Also update pivot group children (sticks/triggers are reparented)
    if (this.stickPivots) {
      for (const pivot of Object.values(this.stickPivots)) {
        pivot.traverse((child) => {
          if (child.isMesh && child.material) {
            child.material.transparent = opacity < 1;
            child.material.opacity = opacity;
            child.material.needsUpdate = true;
          }
        });
      }
    }
  }

  /**
   * Show or hide the entire controller (bodyGroup + scene rendering).
   */
  setVisible(visible) {
    if (this.bodyGroup) this.bodyGroup.visible = visible;
  }

  // ── Touchpad visualization ──

  _setupTouchIndicators() {
    // Glow texture
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,0.8)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.2)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    this._glowTexture = new THREE.CanvasTexture(canvas);

    // Create per-finger indicators (sphere + glow sprite)
    for (let i = 0; i < 2; i++) {
      const color = this._touchColors[i];

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.03, 16, 16),
        new THREE.MeshStandardMaterial({
          color, emissive: color, emissiveIntensity: 0.5,
          metalness: 0.2, roughness: 0.3, transparent: true, opacity: 0.9,
        })
      );
      sphere.visible = false;

      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._glowTexture, color, transparent: true, opacity: 0.6,
        blending: THREE.AdditiveBlending,
      }));
      sprite.scale.set(0.12, 0.12, 1);
      sprite.visible = false;

      // Add to the touchpad mesh's parent so they follow the model
      const parent = this._touchpadBounds.mesh.parent;
      parent.add(sphere);
      parent.add(sprite);

      this._touchIndicators[i] = { sphere, sprite };
    }

    // Stroke group
    this._touchStrokes.group = new THREE.Group();
    this._touchpadBounds.mesh.parent.add(this._touchStrokes.group);
  }

  _touchToLocal(tx, ty) {
    const b = this._touchpadBounds;
    if (!b) return null;
    // Map DualSense 1920x1080 touch coords to the touchpad geometry's XZ range
    const x = b.minX + (tx / 1920) * (b.maxX - b.minX);
    const z = b.minZ + (ty / 1080) * (b.maxZ - b.minZ);

    // Raycast downward onto the touchpad mesh to find the exact surface point
    const origin = new THREE.Vector3(x, b.topY + 5, z);
    this._touchRaycaster.set(origin, new THREE.Vector3(0, -1, 0));
    const hits = this._touchRaycaster.intersectObject(b.mesh, false);
    if (hits.length > 0) {
      // Convert world hit point back to the mesh parent's local space
      const localPoint = b.mesh.parent.worldToLocal(hits[0].point.clone());
      // Offset slightly above surface along the hit normal
      const normal = hits[0].face.normal.clone().transformDirection(b.mesh.matrixWorld).normalize();
      localPoint.add(normal.multiplyScalar(0.003));
      return localPoint;
    }
    // Fallback: flat projection above the bounding box top
    return new THREE.Vector3(x, b.topY, z);
  }

  /**
   * Update touchpad visualization from WebHID touch data.
   * @param {Array} touchPoints — [{active, id, x, y}, {active, id, x, y}]
   * @param {boolean} touchpadButton — whether touchpad is clicked
   */
  updateTouchpad(touchPoints, touchpadButton) {
    if (!this._touchpadBounds || !touchPoints) return;
    const profile = PROFILES[this.controllerType];
    if (!profile?.hasTouchpad) return;

    // Touchpad click → yellow glow on touchpad mesh
    const tpMesh = this._touchpadBounds.mesh;
    if (tpMesh?.material && 'emissive' in tpMesh.material) {
      if (touchpadButton && !this._touchpadClickState) {
        tpMesh.material.emissive.set(0xffcc00);
        tpMesh.material.emissiveIntensity = 2.0;
      } else if (!touchpadButton && this._touchpadClickState) {
        tpMesh.material.emissive.set(0x000000);
        tpMesh.material.emissiveIntensity = 0;
      }
      this._touchpadClickState = touchpadButton;
    }

    const strokes = this._touchStrokes;

    for (let i = 0; i < 2; i++) {
      const t = touchPoints[i];
      if (!t) continue;
      const ind = this._touchIndicators[i];
      if (!ind) continue;

      const idChanged = t.active && strokes.prevActive[i] && t.id !== strokes.prevId[i];

      if (idChanged) {
        // Slot swap — finalize old stroke, start new
        this._finalizeStroke(i);
        const wp = this._touchToLocal(t.x, t.y);
        if (wp) strokes.active[i] = { points: [wp], color: this._touchColors[i], mesh: null };
      }

      if (t.active) {
        const wp = this._touchToLocal(t.x, t.y);
        if (wp) {
          // Position indicator
          ind.sphere.position.copy(wp);
          ind.sprite.position.copy(wp);
          ind.sphere.visible = true;
          ind.sprite.visible = true;

          // Update stroke
          if (!strokes.prevActive[i]) {
            strokes.active[i] = { points: [wp], color: this._touchColors[i], mesh: null };
          } else if (strokes.active[i]) {
            const pts = strokes.active[i].points;
            const last = pts[pts.length - 1];
            if (wp.distanceTo(last) > 0.005) {
              pts.push(wp);
              if (pts.length % 3 === 0) this._updateLiveStroke(i);
            }
          }
        }
      } else {
        ind.sphere.visible = false;
        ind.sprite.visible = false;
        if (strokes.prevActive[i]) {
          this._updateLiveStroke(i);
          this._finalizeStroke(i);
        }
      }

      strokes.prevActive[i] = t.active;
      strokes.prevId[i] = t.id;
    }
  }

  _buildStrokeMesh(points, color, width) {
    if (points.length < 2) return null;
    const positions = [];
    const indices = [];

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let dir;
      if (i === 0) dir = new THREE.Vector3().subVectors(points[1], points[0]).normalize();
      else if (i === points.length - 1) dir = new THREE.Vector3().subVectors(points[i], points[i - 1]).normalize();
      else dir = new THREE.Vector3().subVectors(points[i + 1], points[i - 1]).normalize();

      // Compute an approximate surface normal by looking at adjacent points
      let up = new THREE.Vector3(0, 1, 0);
      if (i > 0 && i < points.length - 1) {
        const v1 = new THREE.Vector3().subVectors(points[i + 1], points[i]);
        const v2 = new THREE.Vector3().subVectors(points[i - 1], points[i]);
        const n = new THREE.Vector3().crossVectors(v1, v2);
        if (n.lengthSq() > 0.0001) up = n.normalize();
      }
      const perp = new THREE.Vector3().crossVectors(dir, up).normalize();
      const hw = width * 0.5;
      positions.push(p.x - perp.x * hw, p.y - perp.y * hw, p.z - perp.z * hw);
      positions.push(p.x + perp.x * hw, p.y + perp.y * hw, p.z + perp.z * hw);

      if (i > 0) {
        const vi = (i - 1) * 2;
        indices.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.3,
      roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide, transparent: true, opacity: 0.8,
    }));
  }

  _updateLiveStroke(idx) {
    const stroke = this._touchStrokes.active[idx];
    if (!stroke || stroke.points.length < 2) return;
    if (stroke.mesh) this._touchStrokes.group.remove(stroke.mesh);
    const mesh = this._buildStrokeMesh(stroke.points, stroke.color, 0.02);
    if (mesh) { this._touchStrokes.group.add(mesh); stroke.mesh = mesh; }
  }

  _finalizeStroke(idx) {
    const stroke = this._touchStrokes.active[idx];
    if (!stroke) return;
    if (stroke.points.length >= 2) {
      if (stroke.mesh) this._touchStrokes.group.remove(stroke.mesh);
      const mesh = this._buildStrokeMesh(stroke.points, stroke.color, 0.02);
      if (mesh) {
        this._touchStrokes.group.add(mesh);
        // Visible for 5s total: 3s solid, then 2s fade out
        const HOLD_MS = 3000;
        const FADE_MS = 2000;
        const startOpacity = mesh.material.opacity;
        setTimeout(() => {
          const fadeStart = performance.now();
          const fade = () => {
            const elapsed = performance.now() - fadeStart;
            const t = Math.min(elapsed / FADE_MS, 1);
            mesh.material.opacity = startOpacity * (1 - t);
            if (t < 1) {
              requestAnimationFrame(fade);
            } else {
              this._touchStrokes.group.remove(mesh);
              mesh.geometry.dispose();
              mesh.material.dispose();
            }
          };
          requestAnimationFrame(fade);
        }, HOLD_MS);
      }
    } else if (stroke.mesh) {
      this._touchStrokes.group.remove(stroke.mesh);
      stroke.mesh.geometry.dispose();
      stroke.mesh.material.dispose();
    }
    this._touchStrokes.active[idx] = null;
  }

  /**
   * Set the color of "body" meshes (white shell parts).
   * @param {string} hexColor — CSS hex color e.g. '#e8e8ec'
   */
  setBodyColor(hexColor) {
    this._setColorGroup('bodyColorMeshes', hexColor);
  }

  /**
   * Set the color of "accent" meshes (dark parts).
   * @param {string} hexColor — CSS hex color e.g. '#1a1a1e'
   */
  setAccentColor(hexColor) {
    this._setColorGroup('accentColorMeshes', hexColor);
  }

  _setColorGroup(groupKey, hexColor) {
    const profile = PROFILES[this.controllerType];
    if (!profile || !profile[groupKey]) return;
    const color = new THREE.Color(hexColor);
    for (const meshName of profile[groupKey]) {
      const mesh = this.meshes[meshName];
      if (!mesh) continue;
      // Mesh might be a pivot group (triggers) — get the actual mesh child
      const target = mesh.isMesh ? mesh : mesh.children?.find(c => c.isMesh);
      if (target?.material) {
        target.material.color.copy(color);
        target.material.needsUpdate = true;
      }
    }
  }

  /**
   * Set a camera preset position.
   * @param {'front'|'back'|'top'|'left'|'right'|'player'} preset
   */
  setCameraPreset(preset) {
    const d = 0.35;
    const presets = {
      front:  { pos: [0, 0.05, d],    target: [0, 0, 0] },
      back:   { pos: [0, 0.05, -d],   target: [0, 0, 0] },
      top:    { pos: [0, d, 0],        target: [0, 0, 0] },
      left:   { pos: [-d, 0.05, 0],    target: [0, 0, 0] },
      right:  { pos: [d, 0.05, 0],     target: [0, 0, 0] },
      player: { pos: [0, d * 0.6, d * 0.75], target: [0, 0, 0] },
    };
    const p = presets[preset] || presets['player'];
    this.camera.position.set(...p.pos);
    this.controls.target.set(...p.target);
  }

  dispose() {
    this._disposed = true;
    if (this._animationId) cancelAnimationFrame(this._animationId);
    this.controls?.dispose();
    this.renderer?.dispose();
    if (this.model) {
      this.model.traverse((child) => {
        if (child.isMesh) {
          child.geometry?.dispose();
          if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => m.dispose());
          }
        }
      });
    }
  }
}
