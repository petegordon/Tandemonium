// ============================================================
// CONTROLLER OVERLAY — 3D WebGL controller visualization
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// Required to decode geometry from GLBs that use EXT_meshopt_compression
// (the default in `gltf-transform optimize`). Without it, meshopt-
// compressed buffer views silently fail to decode and the mesh renders
// as an empty bounding box. Loaded lazily inside _loadModel so callers
// without meshopt GLBs don't pay the import cost.
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { PROFILES } from './controller-profiles.js';
import { normalizeTrackpad } from './trackpad-math.js';

const DEADZONE = 0.08;
const LERP_SPEED = 0.25; // Smoothing factor for animations
// Peak emissive intensity for the press/tilt glow. Kept modest on purpose:
// the renderer uses ACES filmic tone mapping, which desaturates very bright
// emissive — at the old 3.0 a saturated color (e.g. pure red) blew out toward
// orange/yellow. ~1.5 keeps the chosen hue faithful while still glowing. Nudge
// up for a punchier glow if you don't mind some hue shift on saturated colors.
const PRESS_GLOW = 1.5;
// Trackpad click-fill (#57): a press jumps the fill straight to this fraction
// of the pad's max radius (at full opacity) so even a quick tap that ends
// between render frames still shows a noticeably-sized circle, then keeps
// expanding to full while held.
const TRACKPAD_FILL_MIN = 0.45;
// Grip-sense bars sit at this inert dark grey at rest and brighten to the grip
// color while that side is gripped (issue #74 — activation should read on the
// bar itself, not just the handle glow).
const GRIP_BAR_REST_COLOR = 0x44444c;
// Emissive intensity of a grip-sense BAR while its side is gripped. Fixed on
// purpose — the Grip Glow Brightness slider drives the GLOW only, so the bar and
// the glow stay independently defined.
const GRIP_BAR_LIT_EMISSIVE = 0.6;
const FLOAT_ZERO = new THREE.Vector3(); // shared read-only lerp target (parts seated)

export class ControllerOverlay {
  /**
   * Normalize an `assetBase` option: '' / null → '' (page-relative, the
   * default); anything else gets exactly one trailing slash so it can be
   * concatenated straight onto a profile's `model` path.
   * @param {string} [base]
   * @returns {string}
   */
  static normalizeAssetBase(base) {
    if (!base) return '';
    const b = String(base);
    return b.endsWith('/') ? b : b + '/';
  }

  /**
   * @param {Object} options
   * @param {HTMLCanvasElement} options.canvas — target canvas element
   * @param {boolean} [options.transparent=true] — transparent background
   * @param {string} [options.controllerType='dualsense'] — profile key
   * @param {string} [options.assetBase=''] — URL prefix prepended to each
   *   profile's `model` path (e.g. 'assets/controllers/dualsense.glb'). The
   *   profiles resolve relative to the host PAGE by default; a host that
   *   vendors the GLBs somewhere else (or serves the page from a deeper path)
   *   passes the directory that contains `assets/`, e.g. 'shared/visualizer/'.
   *   A trailing slash is added when missing.
   */
  constructor(options = {}) {
    this.canvas = options.canvas;
    this.transparent = options.transparent !== false;
    this.controllerType = options.controllerType || 'dualsense';
    this.assetBase = ControllerOverlay.normalizeAssetBase(options.assetBase);

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

    // Emissive "press" glow color for digital buttons, stick clicks, and
    // triggers (pre-bottom). Defaults to yellow; override via setPressColor.
    this._pressColor = 0xff0000; // default highlight: red
    this._touchpadBounds = null; // { minX, maxX, minZ, maxZ, topY, mesh }
    this._trackpads = null; // multi-pad controllers (Steam Controller): per-pad indicator config
    this._touchpadClickState = false;
    this._glowTexture = null;
    this._touchRaycaster = new THREE.Raycaster();

    // "Pop-off" floating parts: each floatable mesh is wrapped in an identity
    // Group whose position lerps to a radial-outward offset when active (so
    // triggers/bumpers/paddles float clear of the body, visible at any angle)
    // and back to zero when not — zero offset is a no-op, so the seated look
    // is byte-identical to before.
    this._floatWrappers = []; // [{ group, offset:Vector3 }]
    this._floatActive = false;
    this._floatShrink = 1; // model scale while popped (computed per profile)

    // Grip-sense highlighting (Steam Controller capacitive grips)
    this._gripMarkers = null;   // { left, right } billboard sprites, on top
    this._gripEnabled = false;  // on-top grip GLOW markers off by default (#92); toggled from settings
    this._gripBarsVisible = true; // grip-sense side BAR meshes shown by default (#92); from settings
    // Grip glow marker size in 1..5 steps of the base unit. width = across the
    // handle, length = front-to-back (model Z, the handle's long axis).
    // (1,1) renders a small circle; anything larger is a bar.
    this._gripGlowWidth = 2;
    this._gripGlowLength = 4;
    this._gripMarkerSpecs = null; // per-side { pos, baseSize } for (re)building markers on size change
    this._gripBrightness = 0.5; // on-top marker peak opacity (settings slider); subtle by default (#61)
    // Grip highlight color — shares the global highlight color (#45's
    // overlay:highlightColor / --hl-color). Default matches that picker.
    this._gripColor = 0xff0000; // follows the highlight default: red

    // ── Layout editor (#51): click-drag + keyboard-rotate the floatable parts ──
    this._editMode = false;        // editing the float layout right now
    this._layoutMode = 'relative'; // 'relative' (rides with body) | 'absolute' (world-fixed)
    this._selectedWrapper = null;  // the wrapper currently being edited
    this._selectionBox = null;     // THREE.BoxHelper around the selection
    this._editRaycaster = new THREE.Raycaster();
    this._dragState = null;        // { plane, startLocal, startOffset } during a drag
    this._onLayoutChange = null;   // callback(layoutJSON) — app persists it
    this._onSelectChange = null;   // callback(partName|null) — app shows selection
    // Bound DOM handlers (kept so we can add/remove them on edit toggle).
    this._boundPointerDown = (e) => this._editPointerDown(e);
    this._boundPointerMove = (e) => this._editPointerMove(e);
    this._boundPointerUp = (e) => this._editPointerUp(e);
    this._boundKeyDown = (e) => this._editKeyDown(e);
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
    // No tone mapping: ACES Filmic desaturated/hue-shifted the picked highlight
    // color (the press/grip emissive read muted). Linear output keeps colors at
    // full saturation; brightness comes from the metalness fix + lights rather
    // than exposure (which NoToneMapping ignores).
    this.renderer.toneMapping = THREE.NoToneMapping;
    if (transparent) {
      this.renderer.setClearColor(0x000000, 0);
    }

    // Scene
    this.scene = new THREE.Scene();

    // Neutral studio environment for reflections (the "shine"). Materials only
    // use it when their envMapIntensity > 0, which _applyShine drives off the
    // Shine setting — so at shine 0 the model is matte and unchanged. Loaded
    // dynamically + guarded so a missing/incompatible RoomEnvironment addon
    // disables Shine instead of breaking the whole overlay.
    this._shine = 0.35; // 0..1: gloss (lower roughness) + reflection (envMapIntensity); default 35%
    this._initEnvironment();

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

  async _loadModel(token = this._loadSeq) {
    const profile = PROFILES[this.controllerType];
    if (!profile) {
      console.error(`Unknown controller type: ${this.controllerType}`);
      return;
    }

    const modelUrl = this.assetBase + profile.model;
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      // MeshoptDecoder is a WASM-backed module; the registration tells
      // the GLTFLoader to use it when it encounters EXT_meshopt_compression.
      // Cheap to call repeatedly — Three's loader checks if it's already set.
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.load(
        modelUrl,
        (gltf) => {
          // A newer setControllerType() superseded this load — discard the
          // freshly-parsed scene so it doesn't stack onto the current model.
          if (token !== this._loadSeq) {
            gltf.scene.traverse((c) => {
              if (c.isMesh) {
                c.geometry?.dispose();
                const mats = Array.isArray(c.material) ? c.material : [c.material];
                mats.forEach((m) => { if (m) { m.map?.dispose(); m.dispose(); } });
              }
            });
            resolve();
            return;
          }
          this._setupModel(gltf.scene, profile);
          resolve();
        },
        undefined,
        (err) => {
          console.error(`Failed to load model ${modelUrl}:`, err);
          if (token !== this._loadSeq) { resolve(); return; }
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

    // Collect mesh names that need special pivot handling. Index both
    // the profile-form name (may contain spaces) AND the GLTFLoader-
    // sanitized form (spaces → underscores) so the pass-3 lookup
    // `triggerMeshNames.has(child.name)` matches whichever form the
    // loaded Object3D ended up with.
    const triggerMeshNames = new Set();
    for (const n of Object.values(profile.triggerMap)) {
      triggerMeshNames.add(n);
      triggerMeshNames.add(n.replace(/ /g, '_'));
    }

    // Collect all stick mesh names into a set for identification
    // stickMeshNames is used downstream to skip stick parts in the
    // pass-3 generic-mesh loop. Profile names may be space-form (face-
    // painter export) but the loaded Object3D names are underscore-
    // form (GLTFLoader sanitization). Index BOTH spellings so the
    // skip-check works against whichever form the mesh's name ended up.
    const stickMeshNames = new Set();
    const stickAssemblies = {}; // 'left' | 'right' → { meshes[], pivotKey }
    for (const [key, stick] of Object.entries(profile.stickMap)) {
      const names = stick.meshes || [stick.mesh];
      for (const n of names) {
        stickMeshNames.add(n);
        stickMeshNames.add(n.replace(/ /g, '_'));
      }
      stickAssemblies[key] = { names, stick };
    }

    // Pass 1: index all meshes by name and clone shared materials.
    // GLB loader shares material instances for identical materials, so
    // pressing one button would glow all buttons with the same color.
    //
    // Three.js's GLTFLoader replaces spaces in glTF node names with
    // underscores ("Bumper L2" → "Bumper_L2"). Profiles authored from
    // face-painter regions use the original space-form names. Alias
    // each underscored name to its space form right here so the
    // subsequent setup passes (stick pivots, trigger pivots) can find
    // the meshes by either spelling. Without this alias, stick part
    // lookups via `meshByName[stick.meshes[i]]` return undefined and
    // the stick pivot never gets created — tilt animation has nothing
    // to rotate.
    const meshByName = {};
    scene.traverse((child) => {
      if (child.isMesh) {
        meshByName[child.name] = child;
        if (child.name.includes('_')) {
          const alias = child.name.replace(/_/g, ' ');
          if (meshByName[alias] === undefined) meshByName[alias] = child;
        }
        // Clone material so each mesh can animate independently
        if (child.material) {
          child.material = child.material.clone();
          // Models exported without materials get glTF's default (metalness 1,
          // roughness 1). A fully-metallic surface with no environment map
          // renders dark/gray — that's why the bare Steam GLB looked dim. Clamp
          // metalness down so the lights actually read on the body (only lowers
          // over-metallic materials; properly-authored ones are left alone).
          const m = child.material;
          if ('metalness' in m) m.metalness = Math.min(m.metalness, 0.2);
          // No reflection until the Shine setting raises it (scene.environment
          // is always set, so default this to 0 to keep the matte baseline).
          if ('envMapIntensity' in m) m.envMapIntensity = 0;
        }
      }
    });

    // Pass 2: create stick pivot groups — group all parts of each stick
    // assembly into a single pivot at the base of the stick shaft.
    //
    // World-space bounding boxes are required here: `gltf-transform
    // optimize` quantizes per-mesh geometry to int16 and stores the
    // actual position in the node's translate. So `geometry.boundingBox`
    // gives local-space bounds centered near the origin, and any pivot
    // math based on those bounds would place every pivot at world (0,0,0).
    // `Box3.setFromObject` walks the world transform and returns true
    // world bounds, which works for both quantized and non-quantized GLBs.
    //
    // Reparenting uses Object3D.attach() (preserves world transform)
    // instead of remove/add (which would drop the node's translate and
    // collapse the part onto the pivot's origin).
    this.bodyGroup.updateMatrixWorld(true);
    this.stickPivots = {};
    const _wb = new THREE.Box3();
    const _wv = new THREE.Vector3();
    for (const [key, asm] of Object.entries(stickAssemblies)) {
      const parts = asm.names.map(n => meshByName[n]).filter(Boolean);
      if (parts.length === 0) continue;

      // Find the lowest Y across all parts (world space) — tilt base
      let pivotWorldY = Infinity, pivotWorldX = 0, pivotWorldZ = 0;
      let partCount = 0;
      for (const part of parts) {
        _wb.setFromObject(part);
        pivotWorldY = Math.min(pivotWorldY, _wb.min.y);
        pivotWorldX += (_wb.min.x + _wb.max.x) / 2;
        pivotWorldZ += (_wb.min.z + _wb.max.z) / 2;
        partCount++;
      }
      pivotWorldX /= partCount;
      pivotWorldZ /= partCount;

      // Place pivot in the first part's parent space, at the equivalent
      // of that world point. worldToLocal mutates the vector, so pass
      // a fresh one.
      const sceneParent = parts[0].parent;
      const pivotLocal = sceneParent.worldToLocal(
        _wv.set(pivotWorldX, pivotWorldY, pivotWorldZ).clone()
      );

      const pivot = new THREE.Group();
      pivot.name = key + '_stick_pivot';
      pivot.position.copy(pivotLocal);
      sceneParent.add(pivot);

      // attach() keeps each part's visible world position while moving
      // it into the pivot, so rotating the pivot rotates the parts
      // around the pivot's world position.
      for (const part of parts) {
        pivot.attach(part);
      }

      this.stickPivots[key] = pivot;
      // Also register individual meshes for lookup. Each part gets an
      // `originals` entry too so that profile.buttonMap entries pointing
      // at stick parts (typically L3/R3 click highlights on the stick
      // cap) can animate via the standard button-press path. Without
      // the originals, the button loop's `if (!mesh || !orig) continue`
      // silently skips them.
      for (const part of parts) {
        this.meshes[part.name] = part;
        this.originals[part.name] = {
          posX: part.position.x,
          posY: part.position.y,
          posZ: part.position.z,
          rotX: part.rotation.x,
          rotZ: part.rotation.z,
        };
      }
    }

    // Pass 3: set up trigger pivots + register everything else.
    // meshByName may contain two keys per mesh (loaded "Foo_Bar" name
    // + space-form alias "Foo Bar") pointing at the SAME Object3D —
    // dedupe by reference via Set so each mesh is processed once.
    const allMeshes = [...new Set(Object.values(meshByName))].filter(
      m => !stickMeshNames.has(m.name)  // sticks already handled
    );
    for (const child of allMeshes) {
      if (triggerMeshNames.has(child.name) && child.geometry) {
        // World-space bbox — see comment in pass 2 about why
        // geometry.boundingBox isn't usable for quantized GLBs.
        _wb.setFromObject(child);
        // Trigger pivot at the top-back (hinge point) in world space
        const pivotWorldX = (_wb.min.x + _wb.max.x) / 2;
        const pivotWorldY = _wb.max.y;
        const pivotWorldZ = _wb.min.z;

        const parent = child.parent;
        const pivotLocal = parent.worldToLocal(
          _wv.set(pivotWorldX, pivotWorldY, pivotWorldZ).clone()
        );

        const pivot = new THREE.Group();
        pivot.name = child.name + '_pivot';
        pivot.position.copy(pivotLocal);
        parent.add(pivot);
        // attach() preserves the trigger's world position; rotations on
        // the pivot now rotate the mesh around the hinge point.
        pivot.attach(child);

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

    // DualSense: procedurally add the mic/mute button (not in the GLB).
    // Small capsule/pill below the PS button, between the sticks.
    if (this.controllerType === 'dualsense' && meshByName['button_ps']) {
      const psMesh = meshByName['button_ps'];
      psMesh.geometry.computeBoundingBox();
      const psBB = psMesh.geometry.boundingBox;
      const psSize = new THREE.Vector3();
      psBB.getSize(psSize);
      const psCenter = new THREE.Vector3();
      psBB.getCenter(psCenter);

      // Pill shape — slightly wider than PS button, very shallow
      const micW = psSize.x * 0.9;
      const micH = psSize.y * 0.9;
      const micD = psSize.z * 0.9;
      const micGeo = new THREE.CapsuleGeometry(micH * 0.5, Math.max(0.001, micW - micH), 6, 12);
      // CapsuleGeometry's length is along Y by default — rotate to lie flat (X-long)
      micGeo.rotateZ(Math.PI / 2);

      const micMat = new THREE.MeshStandardMaterial({
        color: 0x1a1a1e, metalness: 0.3, roughness: 0.55,
      });
      const micMesh = new THREE.Mesh(micGeo, micMat);
      micMesh.name = 'button_mic';

      // Position in the same local space as PS button:
      // same X (centered), same Y (top face), offset +Z (toward front/bottom
      // of controller face) by ~1.6x the PS button's Z size.
      const micLocalX = psMesh.position.x + psCenter.x;
      const micLocalY = psMesh.position.y + psBB.max.y; // sit on the face
      const micLocalZ = psMesh.position.z + psCenter.z + psSize.z * 1.6;
      micMesh.position.set(micLocalX, micLocalY, micLocalZ);

      psMesh.parent.add(micMesh);
      this.meshes['button_mic'] = micMesh;
      this.originals['button_mic'] = {
        posX: micMesh.position.x,
        posY: micMesh.position.y,
        posZ: micMesh.position.z,
        rotX: micMesh.rotation.x,
        rotZ: micMesh.rotation.z,
      };
    }

    // Fix meshes that should be body-colored but are dark in the GLB.
    // `misc2` is the RIGHT Steam Controller trackpad — it must match the LEFT
    // pad (`touchpad`) or the click press-glow reads differently on each side
    // (the emissive sits on top of the base color, so a darker base = duller
    // glow). Keeping both pads the same body color makes the glow symmetric.
    for (const name of ['touchpad', 'misc2', 'button_create', 'button_options']) {
      const m = meshByName[name];
      if (m?.material) m.material.color.set(0xe8e8ec);
    }

    // Hide static blue dot meshes — replaced by dynamic touch indicators
    for (const name of ['touch_point1', 'touch_point2']) {
      const m = meshByName[name];
      if (m) m.visible = false;
    }

    // Set up touchpad visualization.
    //  - Multi-pad controllers (Steam Controller: two trackpads) use the
    //    per-pad indicator path: each driver touch-point moves a pre-modeled
    //    indicator dot across its pad surface.
    //  - Single-pad controllers (DualSense) use the two-finger path below.
    // Reset prior-model touchpad state so a controller switch can't leave the
    // multi-pad path active with stale (disposed) mesh refs.
    this._trackpads = null;
    this._touchpadBounds = null;
    if (profile.trackpads && profile.hasTouchpad) {
      this._setupTrackpads(profile, meshByName);
    } else {
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
    }

    // Name aliasing: Three.js's GLTFLoader replaces spaces in glTF
    // node names with underscores ("Bumper L2" → "Bumper_L2"), so a
    // profile mesh name written with spaces (as the face-painter
    // exports them) wouldn't match the loaded Object3D's name. Mirror
    // every underscore-bearing key in `this.meshes` and `this.originals`
    // to its space-form variant so profile lookups by either form work.
    for (const key of Object.keys(this.meshes)) {
      if (key.includes('_')) {
        const alias = key.replace(/_/g, ' ');
        if (this.meshes[alias] === undefined) this.meshes[alias] = this.meshes[key];
        if (this.originals[key] && this.originals[alias] === undefined) {
          this.originals[alias] = this.originals[key];
        }
      }
    }

    // Apply the profile's default two-tone theme on load (opt-in per profile so
    // controllers with already-correct GLB materials are left untouched). The
    // bare Steam GLB has no materials, so it needs this to render two-tone.
    if (profile.themeOnLoad) {
      if (profile.defaultBodyColor) this.setBodyColor(profile.defaultBodyColor);
      if (profile.defaultAccentColor) this.setAccentColor(profile.defaultAccentColor);
    }

    // Apply the current Shine setting to the freshly-loaded materials.
    this._applyShine();

    // Wrap floatable parts for the "pop-off" feature (after aliasing so every
    // profile name resolves in this.meshes).
    this._setupFloatParts(profile);

    // Grip-sense on-top markers (after aliasing so grip meshes resolve).
    this._setupGripMarkers(profile);

    // Move the grip-sense BAR meshes out to the controller's left/right sides
    // (after the markers are placed, so the markers keep their original
    // anchoring and only the bars move).
    this._repositionGripBars(profile);
    // Honor the current "show grip bars" setting on this freshly-loaded model.
    this._applyGripBarsVisible();
    // Set the bars to their inert rest grey + clone their materials (they're not
    // in a theme group, so this is the only thing that colors them); setGripState
    // then lights them to the grip color while a side is gripped.
    this._applyGripBarColor();

    // Diagnostic: per-mapping check at load time so we can tell whether
    // each gamepad-index → mesh path will animate at runtime. The press
    // / tilt / trigger loops all early-return on missing mesh OR missing
    // originals, so we explicitly check BOTH here.
    const summarize = (kind, mapping) => {
      const rows = [];
      let ok = 0, total = 0;
      for (const [k, name] of Object.entries(mapping)) {
        total++;
        const m = this.meshes[name];
        const o = this.originals[name];
        if (m && o) { ok++; rows.push(`  ✓ ${kind}[${k}] = "${name}"`); }
        else { rows.push(`  ✗ ${kind}[${k}] = "${name}"  ${!m ? '(mesh missing)' : '(originals missing)'}`); }
      }
      return { rows, ok, total };
    };
    const btn = summarize('button', profile.buttonMap);
    const trg = summarize('trigger', profile.triggerMap);
    const stickRows = [];
    let stickOk = 0, stickTotal = 0;
    for (const [side, s] of Object.entries(profile.stickMap)) {
      const names = s.meshes || [s.mesh];
      stickTotal += names.length;
      for (const n of names) {
        if (this.meshes[n] && this.originals[n]) { stickOk++; stickRows.push(`  ✓ stick.${side} part "${n}"`); }
        else { stickRows.push(`  ✗ stick.${side} part "${n}"  ${!this.meshes[n] ? '(mesh missing)' : '(originals missing)'}`); }
      }
    }
    console.log(
      `Controller "${profile.name || this.controllerType}" loaded:\n` +
      `  buttons:  ${btn.ok}/${btn.total}\n` +
      `  triggers: ${trg.ok}/${trg.total}\n` +
      `  sticks:   ${stickOk}/${stickTotal}\n` +
      [...btn.rows, ...trg.rows, ...stickRows].join('\n')
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

  // ── "Pop-off" floating parts ──
  // Wrap each profile.floatParts mesh in an identity Group and precompute a
  // radial-outward offset (auto-derived from geometry: direction = part center
  // → model center, magnitude = model radius × floatFactor). Floating just
  // lerps each wrapper between 0 (seated) and its offset (popped) — the seated
  // state is a no-op, and the part's own press/rotation animation runs inside
  // the wrapper untouched.
  _setupFloatParts(profile) {
    // Re-setup (e.g. controller switch) invalidates any active selection.
    this._selectedWrapper = null;
    if (this._selectionBox) { this.scene?.remove(this._selectionBox); this._selectionBox = null; }
    this._floatWrappers = [];
    const names = profile.floatParts;
    if (!names || !names.length) return;

    this.model.updateWorldMatrix(true, true);
    const modelBox = new THREE.Box3().setFromObject(this.model);
    const modelCenter = modelBox.getCenter(new THREE.Vector3());
    const worldRadius = modelBox.getSize(new THREE.Vector3()).length() * 0.5;
    const scale = this.model.scale.x || 1; // uniform scale applied in _setupModel
    const factor = profile.floatFactor ?? 0.6;
    // Extra sideways push so parts clear the body's width, not just radially.
    const lateralBias = profile.floatLateralBias ?? 1.6;
    // Shrink the whole model while popped so the spread-out layout still fits
    // the window. Auto-derived from the spread (a wider pop → smaller body),
    // with a margin; override via profile.floatShrink.
    this._floatShrink = profile.floatShrink ?? (1 / (1 + factor * 0.9));
    // Parts that should additionally turn their flat face toward the camera
    // while popped (e.g. the back paddles, which sit edge-on at rest).
    const faceCamSet = new Set(profile.floatFaceCamera || []);

    const seen = new Set();
    for (const name of names) {
      const obj = this.meshes[name];
      if (!obj || seen.has(obj)) continue; // skip missing / duplicate (alias) refs
      seen.add(obj);

      // The part's center relative to the model center (world space). `dir` is
      // the normalized version used for the default radial fan-out.
      const partCenter = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
      const rel = partCenter.clone().sub(modelCenter);
      const dir = rel.clone();
      if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0); // dead-center part → push up
      dir.normalize();
      // Convert the world displacement to the wrapper's parent-local space. At
      // setup the model isn't gyro-rotated yet (rotation identity), so for a
      // uniformly-scaled parent this is just divide-by-scale.
      //
      // Per-part tuning (profile.floatTuning[name]) replaces the radial fan-out
      // with a deliberate push along the controller's own axes, so e.g. the
      // triggers/bumpers lift off the BACK surface (where they sit) instead of
      // flying to the corners. The part keeps its natural spot and is nudged by:
      //   back — push toward the back (−Z), off the rear surface
      //   up   — push toward the top (+Y)
      //   side — push outward to its own side (±X, away from the centerline)
      // all in model-radius units. (Axes per the camera presets: +Z front /
      // −Z back, +Y top, +X right.) Untuned parts use the default radial pop.
      const tuning = profile.floatTuning?.[name];
      let offset;
      if (tuning) {
        const back = tuning.back ?? 0;
        const up = tuning.up ?? 0;
        const side = tuning.side ?? 0;
        const sideSign = Math.sign(rel.x) || 1; // keep left on the left, right on the right
        offset = new THREE.Vector3(
          sideSign * worldRadius * side,
          worldRadius * up,
          -worldRadius * back        // −Z = back, off the rear surface
        ).divideScalar(scale);
      } else {
        offset = dir.clone().multiplyScalar((worldRadius * factor) / scale);
        offset.x *= lateralBias; // bias the pop outward to the sides
      }

      // Rotation pivot = the part's own center (parent-local), captured before
      // wrapping reparents obj. Rotating about this point (not the model origin)
      // keeps the part in place as it turns — otherwise a big face-camera turn
      // swings it in a wide arc (the left paddles ending up under the body).
      const pivot = obj.parent.worldToLocal(partCenter.clone());
      const wrapper = {
        group: this._wrapForFloat(obj), pivot, offset, t: 0,
        // Editor metadata (#51):
        partName: name,
        obj,                            // raycast target / highlight subject
        seatedWorld: partCenter.clone(),// world center at the identity pose (for absolute pin)
        modelScale: scale,              // uniform model scale (parent-local → world)
        layout: null,                   // user override { offset:Vector3, euler:{x,y,z} } or null
      };
      // Tuned parts (triggers/bumpers) are deliberately placed relative to the
      // body, so they normally rotate WITH the body (no camera-facing counter-
      // rotation) — otherwise they appear to spin independently as the gyro
      // moves and swing out of place at steep angles. An optional `tiltUp`
      // (degrees) pivots the part about its own center toward the top, so it
      // flips up rather than just translating. EXCEPTION: a part that is also in
      // floatFaceCamera keeps facing the camera, so it can take a tuned offset
      // (e.g. paddles popped DOWN under the body) while still turning its flat
      // face to the viewer.
      const wantsFaceCam = faceCamSet.has(name);
      if (tuning && !wantsFaceCam) {
        wrapper.stayWithBody = true;
        if (tuning.tiltUp) {
          wrapper.tiltQuat = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(tuning.tiltUp)
          );
        }
      }
      if (wantsFaceCam) {
        const normal = this._partSurfaceNormal(obj);
        if (normal) {
          wrapper.faceCamera = true;
          wrapper.restNormal = normal;       // world surface normal at rest
          wrapper.restCenter = partCenter;    // world center (for camera direction)
        }
      }
      this._floatWrappers.push(wrapper);
    }

    // Apply the profile's hand-tuned default layout first (baseline), then let
    // any saved user layout for this controller override it. Both run on every
    // (re)load so switching controllers restores each one's positions; the
    // editor's provider is registered by the app.
    if (profile.defaultLayout) this.applyLayout(profile.defaultLayout);
    if (this._layoutProvider) {
      const saved = this._layoutProvider(this.controllerType);
      if (saved) this.applyLayout(saved);
    }
  }

  // Wrap an animated part in an identity Group so floating (group position)
  // is decoupled from the part's own press/rotation animation (mesh transform).
  _wrapForFloat(obj) {
    const g = new THREE.Group(); // identity → preserves obj's world transform
    obj.parent.add(g);
    g.add(obj);
    return g;
  }

  // World-space surface normal of a (roughly flat) part = its thinnest local
  // bounding-box axis, mapped to world. Used to turn paddles face-on.
  _partSurfaceNormal(obj) {
    let mesh = obj.isMesh ? obj : null;
    if (!mesh) obj.traverse((c) => { if (!mesh && c.isMesh) mesh = c; });
    if (!mesh?.geometry) return null;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const dims = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
    const minIdx = dims.indexOf(Math.min(...dims));
    const local = new THREE.Vector3(minIdx === 0 ? 1 : 0, minIdx === 1 ? 1 : 0, minIdx === 2 ? 1 : 0);
    mesh.updateWorldMatrix(true, false);
    return local.transformDirection(mesh.matrixWorld).normalize();
  }

  /** Toggle the pop-off float (parts ease in/out via the render loop). */
  setFloatParts(enabled) {
    this._floatActive = !!enabled;
  }

  _updateFloat() {
    if (!this._floatWrappers.length) return;
    // Parts are "popped" while the float is on OR while editing the layout
    // (so the user can grab them in their popped positions).
    const popped = this._floatActive || this._editMode;
    // Shrink the whole model while popped so the spread-out parts fit the
    // window — but NOT while editing, where a stable 1:1 scale keeps the
    // click-drag math WYSIWYG. Eases back to full size when seated.
    if (this.bodyGroup) {
      const target = this._editMode ? 1 : (popped ? this._floatShrink : 1);
      const s = THREE.MathUtils.lerp(this.bodyGroup.scale.x, target, LERP_SPEED);
      this.bodyGroup.scale.setScalar(s);
    }
    // Counter-rotation: cancel the body's gyro so non-tuned popped parts hold a
    // camera-facing orientation. Identity when seated.
    const counter = this._floatCounterQuat || (this._floatCounterQuat = new THREE.Quaternion());
    if (popped && this.bodyGroup) counter.copy(this.bodyGroup.quaternion).invert();
    else counter.identity();

    // Scratch objects (reused each frame to avoid allocations).
    const camPos = this._floatCamPos || (this._floatCamPos = new THREE.Vector3());
    const camDir = this._floatCamDir || (this._floatCamDir = new THREE.Vector3());
    const faceRot = this._floatFaceRot || (this._floatFaceRot = new THREE.Quaternion());
    const tgt = this._floatTargetQuat || (this._floatTargetQuat = new THREE.Quaternion());
    const rp = this._floatRP || (this._floatRP = new THREE.Vector3());
    const pos = this._floatPos || (this._floatPos = new THREE.Vector3());
    const idn = this._floatIdentityQuat || (this._floatIdentityQuat = new THREE.Quaternion());
    const eul = this._floatEuler || (this._floatEuler = new THREE.Euler());
    const layoutQ = this._floatLayoutQuat || (this._floatLayoutQuat = new THREE.Quaternion());
    const parentQ = this._floatParentQuat || (this._floatParentQuat = new THREE.Quaternion());
    const wpt = this._floatWPos || (this._floatWPos = new THREE.Vector3());
    if (this.camera) this.camera.getWorldPosition(camPos);

    const absolute = this._layoutMode === 'absolute';

    for (const w of this._floatWrappers) {
      // A saved/edited layout overrides the profile's floatTuning offset + tilt.
      const effOffset = w.layout ? w.layout.offset : w.offset;
      let layoutRot = null;
      if (w.layout && w.layout.euler) {
        eul.set(
          THREE.MathUtils.degToRad(w.layout.euler.x || 0),
          THREE.MathUtils.degToRad(w.layout.euler.y || 0),
          THREE.MathUtils.degToRad(w.layout.euler.z || 0)
        );
        layoutRot = layoutQ.setFromEuler(eul);
      }

      if (absolute) {
        // Absolute: pin the part to a fixed WORLD transform, independent of the
        // body's gyro rotation/shrink, by countering the parent's live world
        // transform. Eases to its seated spot when not popped.
        const parent = w.group.parent;
        let targetQuat = idn;
        let targetPos = rp.set(0, 0, 0);
        if (popped && parent) {
          parent.updateWorldMatrix(true, false);
          parent.getWorldQuaternion(parentQ);
          const Qworld = layoutRot || w.tiltQuat || idn;       // fixed world orientation
          wpt.copy(effOffset).multiplyScalar(w.modelScale).add(w.seatedWorld); // fixed world center
          const localQ = tgt.copy(parentQ).invert().multiply(Qworld);
          parent.worldToLocal(wpt);                            // → parent-local target center
          targetPos = pos.copy(wpt).sub(rp.copy(w.pivot).applyQuaternion(localQ));
          targetQuat = localQ;
        }
        w.group.quaternion.slerp(targetQuat, LERP_SPEED);
        w.group.position.lerp(targetPos, LERP_SPEED);
      } else {
        // Relative: rides with the body (wrapper under bodyGroup).
        let target = counter;
        if (layoutRot) {
          target = layoutRot;                                  // user-set orientation, rides with body
        } else if (w.stayWithBody) {
          target = (popped && w.tiltQuat) ? w.tiltQuat : idn;
        } else if (w.faceCamera && popped && this.camera) {
          camDir.copy(camPos).sub(w.restCenter).normalize();
          faceRot.setFromUnitVectors(w.restNormal, camDir);
          target = tgt.copy(counter).multiply(faceRot);
        }
        w.group.quaternion.slerp(target, LERP_SPEED);
        // Ease the pop amount, then place the wrapper so its rotation pivots
        // about the part's own center: pos = P − R·P + offset·t.
        w.t = THREE.MathUtils.lerp(w.t, popped ? 1 : 0, LERP_SPEED);
        rp.copy(w.pivot).applyQuaternion(w.group.quaternion);
        pos.copy(w.pivot).sub(rp).addScaledVector(effOffset, w.t);
        w.group.position.copy(pos);
      }
    }

    // Keep the selection outline glued to the selected part.
    if (this._selectionBox && this._selectedWrapper) this._selectionBox.update();
  }

  // ── Layout editor (#51) ────────────────────────────────────────────────
  // Public API used by the app's "Edit Layout" settings UI.

  /** Enable/disable layout editing (click-drag + keyboard-rotate the parts). */
  setEditMode(on) {
    on = !!on;
    if (on === this._editMode) return;
    this._editMode = on;
    const el = this.renderer?.domElement;
    if (on) {
      this._floatActiveBeforeEdit = this._floatActive;
      this._floatActive = true; // pop parts out so they're grabbable
      // Disable OrbitControls for the whole session: its onPointerDown calls
      // setPointerCapture BEFORE checking rotate/pan, so even "zoom-only" it
      // would steal the drag. (Re-enabled on exit.)
      if (this.controls) this.controls.enabled = false;
      el?.addEventListener('pointerdown', this._boundPointerDown);
      window.addEventListener('pointermove', this._boundPointerMove);
      window.addEventListener('pointerup', this._boundPointerUp);
      window.addEventListener('keydown', this._boundKeyDown);
      if (el) el.style.cursor = 'pointer';
    } else {
      el?.removeEventListener('pointerdown', this._boundPointerDown);
      window.removeEventListener('pointermove', this._boundPointerMove);
      window.removeEventListener('pointerup', this._boundPointerUp);
      window.removeEventListener('keydown', this._boundKeyDown);
      this._dragState = null;
      this._selectWrapper(null);
      if (this.controls) this.controls.enabled = true;
      this._floatActive = this._floatActiveBeforeEdit ?? this._floatActive;
      if (el) el.style.cursor = '';
    }
  }

  /** Register a provider(controllerType) → saved layout JSON, auto-applied on (re)load. */
  setLayoutProvider(fn) { this._layoutProvider = fn; }

  /** 'relative' (parts ride with the body) | 'absolute' (world-fixed). */
  setLayoutMode(mode) {
    this._layoutMode = mode === 'absolute' ? 'absolute' : 'relative';
  }
  getLayoutMode() { return this._layoutMode; }

  /** Register a callback(layoutJSON) fired whenever the layout changes. */
  setLayoutChangeHandler(fn) { this._onLayoutChange = fn; }
  /** Register a callback(partName|null) fired when the selection changes. */
  setSelectHandler(fn) { this._onSelectChange = fn; }

  /** Serialize the per-part layout overrides to plain JSON (for localStorage). */
  getLayout() {
    const out = {};
    for (const w of this._floatWrappers) {
      if (!w.layout) continue;
      const o = w.layout.offset, e = w.layout.euler || {};
      out[w.partName] = {
        offset: [o.x, o.y, o.z],
        euler: [e.x || 0, e.y || 0, e.z || 0],
      };
    }
    return out;
  }

  /** Apply a saved layout (from getLayout()) to the current parts. */
  applyLayout(layout) {
    if (!layout || typeof layout !== 'object') return;
    for (const w of this._floatWrappers) {
      const e = layout[w.partName];
      if (e && Array.isArray(e.offset)) {
        w.layout = {
          offset: new THREE.Vector3(e.offset[0] || 0, e.offset[1] || 0, e.offset[2] || 0),
          euler: { x: e.euler?.[0] || 0, y: e.euler?.[1] || 0, z: e.euler?.[2] || 0 },
        };
      }
    }
  }

  /** Clear all per-part overrides back to the profile defaults. */
  resetLayout() {
    for (const w of this._floatWrappers) this._restoreWrapperDefault(w);
    this._emitLayout();
  }
  /** Clear just the selected part's override. */
  resetSelected() {
    if (this._selectedWrapper) { this._restoreWrapperDefault(this._selectedWrapper); this._emitLayout(); }
  }

  // Reset a wrapper to the position it had BEFORE any user edit — i.e. the spot
  // shown when Edit Layout opens. That's the profile's hand-tuned defaultLayout
  // if it lists this part (Steam triggers/bumpers), otherwise null so it falls
  // back to the computed floatTuning offset. So "reset" undoes the user's tweaks
  // rather than jumping to a different procedural value.
  _restoreWrapperDefault(w) {
    const def = PROFILES[this.controllerType]?.defaultLayout?.[w.partName];
    if (def && Array.isArray(def.offset)) {
      w.layout = {
        offset: new THREE.Vector3(def.offset[0] || 0, def.offset[1] || 0, def.offset[2] || 0),
        euler: { x: def.euler?.[0] || 0, y: def.euler?.[1] || 0, z: def.euler?.[2] || 0 },
      };
    } else {
      w.layout = null;
    }
  }
  /** Deselect the current part (used by the floating editor's close button). */
  clearLayoutSelection() { this._selectWrapper(null); }

  _emitLayout() { if (this._onLayoutChange) this._onLayoutChange(this.getLayout()); }

  // Lazily create a part's layout override, SEEDED FROM ITS CURRENT POPPED
  // ORIENTATION rather than zero rotation. Selecting/grabbing a part used to
  // reset it to euler {0,0,0}, throwing away its intended tilt (triggers/
  // bumpers' tiltUp) or camera-facing pose (paddles) — the "orientation resets
  // on first click" complaint. Reading the live wrapper quaternion reproduces
  // exactly what's on screen, so the first edit is a no-op visually.
  _ensureLayout(w) {
    if (!w || w.layout) return;
    const q = (this._layoutMode === 'absolute')
      ? w.group.getWorldQuaternion(new THREE.Quaternion())
      : w.group.quaternion.clone();
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    w.layout = {
      offset: w.offset.clone(),
      euler: {
        x: THREE.MathUtils.radToDeg(e.x),
        y: THREE.MathUtils.radToDeg(e.y),
        z: THREE.MathUtils.radToDeg(e.z),
      },
    };
  }

  /**
   * Current position/rotation of the selected part, for a numeric editor.
   * Read-only — does NOT create an override (so merely selecting a part to
   * inspect its values doesn't freeze a camera-facing paddle). Values match
   * what `setSelectedLayout` accepts: offset in parent-local model units,
   * euler in degrees. Returns null when nothing is selected.
   */
  getSelectedLayout() {
    const w = this._selectedWrapper;
    if (!w) return null;
    let offset, euler;
    if (w.layout) {
      offset = w.layout.offset;
      euler = w.layout.euler;
    } else {
      offset = w.offset;
      const q = (this._layoutMode === 'absolute')
        ? w.group.getWorldQuaternion(new THREE.Quaternion())
        : w.group.quaternion;
      const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      euler = {
        x: THREE.MathUtils.radToDeg(e.x),
        y: THREE.MathUtils.radToDeg(e.y),
        z: THREE.MathUtils.radToDeg(e.z),
      };
    }
    return {
      partName: w.partName,
      offset: { x: offset.x, y: offset.y, z: offset.z },
      euler: { x: euler.x, y: euler.y, z: euler.z },
    };
  }

  /**
   * Set precise position/rotation on the selected part from a numeric editor.
   * Accepts a partial `{ offset:{x,y,z}, euler:{x,y,z} }`; only finite fields
   * are applied, so individual axes can be edited independently. Commits an
   * override (seeded from the current pose for any axes left unspecified).
   */
  setSelectedLayout(vals) {
    const w = this._selectedWrapper;
    if (!w || !vals) return;
    this._ensureLayout(w);
    if (vals.offset) {
      for (const k of ['x', 'y', 'z']) {
        if (Number.isFinite(vals.offset[k])) w.layout.offset[k] = vals.offset[k];
      }
    }
    if (vals.euler) {
      for (const k of ['x', 'y', 'z']) {
        if (Number.isFinite(vals.euler[k])) w.layout.euler[k] = vals.euler[k];
      }
    }
    this._emitLayout();
  }

  // Raycast canvas coords → the floatable wrapper under the cursor (or null).
  _pickWrapper(clientX, clientY) {
    const el = this.renderer?.domElement;
    if (!el || !this.camera) return null;
    const rect = el.getBoundingClientRect();
    const ndc = this._editNDC || (this._editNDC = new THREE.Vector2());
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._editRaycaster.setFromCamera(ndc, this.camera);
    const targets = [];
    for (const w of this._floatWrappers) if (w.obj) targets.push(w.obj);
    const hits = this._editRaycaster.intersectObjects(targets, true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o) {
      const w = this._floatWrappers.find((ww) => ww.group === o);
      if (w) return w;
      o = o.parent;
    }
    return null;
  }

  _selectWrapper(w) {
    if (w === this._selectedWrapper) return;
    this._selectedWrapper = w || null;
    if (this._selectionBox) {
      this.scene?.remove(this._selectionBox);
      this._selectionBox.geometry?.dispose?.();
      this._selectionBox = null;
    }
    if (w && w.obj && this.scene) {
      this._selectionBox = new THREE.BoxHelper(w.obj, 0x33ddff);
      this._selectionBox.material.depthTest = false;
      this._selectionBox.renderOrder = 999;
      this.scene.add(this._selectionBox);
    }
    if (this._onSelectChange) this._onSelectChange(w ? w.partName : null);
  }

  // Project canvas coords onto a world-space plane; returns a Vector3 or null.
  _rayToPlane(clientX, clientY, plane) {
    const el = this.renderer?.domElement;
    if (!el || !this.camera) return null;
    const rect = el.getBoundingClientRect();
    const ndc = this._editNDC || (this._editNDC = new THREE.Vector2());
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._editRaycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    return this._editRaycaster.ray.intersectPlane(plane, out) ? out : null;
  }

  _editPointerDown(e) {
    if (!this._editMode || e.button !== 0) return;
    // Stop this click from bubbling to the app's window-drag handler (which
    // would otherwise move the whole OS window instead of the part).
    e.stopPropagation();
    const w = this._pickWrapper(e.clientX, e.clientY);
    this._selectWrapper(w);
    if (!w) return;
    e.preventDefault();
    if (this.controls) this.controls.enabled = false; // don't zoom mid-drag
    // Drag on a plane through the part center, facing the camera.
    const center = w.obj.getWorldPosition(new THREE.Vector3());
    const normal = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center);
    const hit = this._rayToPlane(e.clientX, e.clientY, plane);
    if (!hit) { if (this.controls) this.controls.enabled = true; return; }
    const parent = w.group.parent;
    const startLocal = parent ? parent.worldToLocal(hit.clone()) : hit.clone();
    this._ensureLayout(w);
    this._dragState = { wrapper: w, plane, startLocal, startOffset: w.layout.offset.clone() };
  }

  _editPointerMove(e) {
    const ds = this._dragState;
    if (!ds) return;
    const hit = this._rayToPlane(e.clientX, e.clientY, ds.plane);
    if (!hit) return;
    const parent = ds.wrapper.group.parent;
    const curLocal = parent ? parent.worldToLocal(hit) : hit;
    ds.wrapper.layout.offset.copy(ds.startOffset).add(curLocal).sub(ds.startLocal);
  }

  _editPointerUp() {
    if (!this._dragState) return;
    this._dragState = null;
    if (this.controls) this.controls.enabled = true;
    this._emitLayout();
  }

  _editKeyDown(e) {
    if (!this._editMode) return;
    if (e.key === 'Escape') { this._selectWrapper(null); e.preventDefault(); return; }
    const w = this._selectedWrapper;
    if (!w) return;
    this._ensureLayout(w);
    const step = e.shiftKey ? 2 : 15; // degrees per press (Shift = fine)
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':    w.layout.euler.x += step; break; // pitch
      case 'ArrowDown':  w.layout.euler.x -= step; break;
      case 'ArrowLeft':  w.layout.euler.y += step; break; // yaw
      case 'ArrowRight': w.layout.euler.y -= step; break;
      case 'q': case 'Q': w.layout.euler.z += step; break; // roll
      case 'e': case 'E': w.layout.euler.z -= step; break;
      case 'r': case 'R': w.layout.euler = { x: 0, y: 0, z: 0 }; break; // reset rotation
      default: handled = false;
    }
    if (handled) { e.preventDefault(); this._emitLayout(); }
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

        // Emissive glow on press (color configurable via setPressColor).
        // Color is set every frame so a runtime color change takes effect
        // immediately; intensity lerps to 0 when not pressed, so the color
        // is invisible then. DoubleSide (set once) keeps the highlight
        // visible from front AND back once the part is popped out via float.
        const mat = mesh.isMesh ? mesh.material :
                    (mesh.children?.[0]?.isMesh ? mesh.children[0].material : null);
        if (mat && 'emissive' in mat) {
          if (!mat._btnEmissiveSet) {
            mat._btnEmissiveSet = true;
            mat.side = THREE.DoubleSide;
            mat.needsUpdate = true;
          }
          mat.emissive.set(this._pressColor);
          const targetIntensity = btn.pressed ? PRESS_GLOW : 0;
          mat.emissiveIntensity = THREE.MathUtils.lerp(
            mat.emissiveIntensity, targetIntensity, LERP_SPEED
          );
        }
      }

      // ── Triggers (analog) ──
      // Rotation pivots the trigger mesh around its top edge. Emissive
      // glow scales with pull depth so a half-pull shows ~half brightness,
      // matching DualSense's behavior. Color transitions from yellow
      // (mid-pull) to red (fully pressed) so the user gets a distinct
      // signal at the bottoming-out point separate from analog level.
      // Material is forced DoubleSide so the glow is visible regardless
      // of which side of the rotating mesh is facing the camera.
      for (const [indexStr, meshName] of Object.entries(profile.triggerMap)) {
        const index = parseInt(indexStr);
        const btn = gamepad.buttons[index];
        if (!btn) continue;

        const mesh = this.meshes[meshName];
        const orig = this.originals[meshName];
        if (!mesh || !orig) continue;

        const targetAngle = orig.rotX - btn.value * profile.triggerMaxAngle;
        mesh.rotation.x = THREE.MathUtils.lerp(mesh.rotation.x, targetAngle, LERP_SPEED);

        // Find the trigger's Mesh material — search descendants in case
        // the pivot wraps a Group (instead of a single Mesh) or the
        // GLTFLoader produced extra intermediate nodes.
        let innerMesh = mesh.isMesh ? mesh : null;
        if (!innerMesh) {
          mesh.traverse((c) => { if (!innerMesh && c.isMesh) innerMesh = c; });
        }
        const trigMat = innerMesh?.material;
        if (trigMat && 'emissive' in trigMat) {
          // One-time material setup: enable double-sided rendering so
          // the glow shows when the trigger rotates inward, and start
          // emissive at yellow.
          if (!trigMat._trigEmissiveSet) {
            trigMat._trigEmissiveSet = true;
            trigMat.side = THREE.DoubleSide;
            trigMat.needsUpdate = true;
            trigMat.emissive.set(this._pressColor);
          }
          // Two-tone behavior: highlight color up to 95% pull, snap to red
          // when fully pressed (bottomed out). The intensity scales with
          // analog value in both phases.
          const fullyPressed = btn.value >= 0.95;
          const targetColor = fullyPressed ? 0xff3322 : this._pressColor;
          trigMat.emissive.set(targetColor);
          const targetGlow = btn.value > 0.05 ? btn.value * PRESS_GLOW : 0;
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

        // Stick glow: the highlight color for both tilt and L3/R3 click.
        // Hue stays constant; only intensity varies — a gradient that's
        // brightest at the cap on tilt, and full strength on click.
        const magnitude = Math.min(1, Math.sqrt(axisX * axisX + axisY * axisY));
        const stickMeshes = stick.meshes || [];
        // L3 = button 10, R3 = button 11
        const pressBtn = gamepad?.buttons?.[key === 'left' ? 10 : 11];
        const isPressed = pressBtn?.pressed || false;

        // Per-layer tilt brightness (cap, ring, base), scaled off PRESS_GLOW.
        const tiltPeaks = [PRESS_GLOW, PRESS_GLOW * 0.65, PRESS_GLOW * 0.35];

        for (let si = 0; si < stickMeshes.length; si++) {
          const part = this.meshes[stickMeshes[si]];
          if (!part?.isMesh) continue;
          const partMat = part.material;
          if (!partMat || !('emissive' in partMat)) continue;

          partMat.emissive.set(this._pressColor);
          const targetGlow = isPressed
            ? PRESS_GLOW
            : (magnitude > 0 ? magnitude * (tiltPeaks[si] ?? PRESS_GLOW * 0.5) : 0);
          partMat.emissiveIntensity = THREE.MathUtils.lerp(
            partMat.emissiveIntensity, targetGlow, LERP_SPEED
          );
        }
      }
    }

    // ── Gyro (body rotation) ──
    // While editing the layout we hold the body level (ease toward identity) so
    // dragging/rotating parts is stable and WYSIWYG, ignoring live gyro.
    if (this.bodyGroup) {
      const idn = this._floatIdentityQuat || (this._floatIdentityQuat = new THREE.Quaternion());
      if (this._editMode) {
        this.animState.gyro.slerp(idn, LERP_SPEED);
        this.bodyGroup.quaternion.copy(this.animState.gyro);
      } else if (gyroQuaternion) {
        this.animState.gyro.slerp(gyroQuaternion, LERP_SPEED);
        this.bodyGroup.quaternion.copy(this.animState.gyro);
      }
    }
  }

  _animate() {
    if (this._disposed) return;
    this._animationId = requestAnimationFrame(() => this._animate());

    this._updateFloat();
    this._updateTrackpadFills();
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
  }

  // Advance the per-pad radial click-fill animation (issue #57). Time-based so
  // the spread/fade are smooth regardless of frame rate or HID report cadence.
  _updateTrackpadFills() {
    if (!this._trackpads) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = Math.min(0.05, (now - (this._fillLastT ?? now)) / 1000); // clamp hitches
    this._fillLastT = now;
    const EXPAND_S = 0.18; // spread out to full pad
    const FADE_S = 0.18;   // fade after release
    for (const pad of this._trackpads) {
      const f = pad.fill;
      if (!f || !f.uniforms) continue;
      if (f.phase === 'expand') {
        f.progress = Math.min(1, f.progress + dt / EXPAND_S);
        f.alpha = 1;
        // Reached full: fade if the press already ended (fire-and-forget ripple),
        // otherwise hold filled until release.
        if (f.progress >= 1) f.phase = f.releaseRequested ? 'fade' : 'hold';
      } else if (f.phase === 'fade') {
        f.alpha = Math.max(0, f.alpha - dt / FADE_S);
        if (f.alpha <= 0) { f.phase = 'idle'; f.progress = 0; f.releaseRequested = false; }
      }
      f.uniforms.uFillRadius.value = f.progress * f.maxRadius;
      f.uniforms.uFillAlpha.value = f.alpha;
    }
  }

  /**
   * Switch controller type. Unloads current model and loads new one.
   * @param {string} type — profile key
   */
  async setControllerType(type) {
    if (type === this.controllerType && this.model) return;
    this.controllerType = type;
    // Serialize against overlapping loads: each call bumps a token; an async
    // GLB load that finishes AFTER a newer call is discarded instead of being
    // added. Without this, the initial model load racing an auto-route swap
    // leaves two models in bodyGroup (the "ghost"/overlapping-controller bug).
    const token = this._loadSeq = (this._loadSeq || 0) + 1;

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

  // ── Multi-trackpad (Steam Controller) ──
  // Each profile.trackpads entry maps a driver touch-point index to a pad mesh
  // and a pre-modeled indicator dot (touch_point1/2) that sits at the pad's
  // center; on touch we move the dot to the finger position on that pad.
  _setupTrackpads(profile, meshByName) {
    this._trackpads = [];
    profile.trackpads.forEach((cfg, idx) => {
      const padMesh = meshByName[cfg.pad];
      if (!padMesh) {
        console.warn(`Trackpad pad mesh '${cfg.pad}' not found in model`);
        return;
      }
      padMesh.geometry.computeBoundingBox();
      const bb = padMesh.geometry.boundingBox;
      const dot = meshByName[cfg.indicator] || null;
      let restPos = null;
      let dotLiftY = 0;
      if (dot) {
        restPos = dot.position.clone();
        dot.visible = false; // shown only while a finger is on the pad
        // dot.position is an OFFSET from the dot's baked geometry (already at
        // the pad surface), so the lift must be a small DELTA: raise the dot
        // from its modeled height just past the raised pad edge, plus a small
        // margin. (Using an absolute Y double-counts the baked height and
        // floats the dot way off the pad.) Margin scales with pad thickness so
        // it survives the body-resize on the float branch; tune trackpadDotLift.
        dot.geometry?.computeBoundingBox?.();
        const dotCenterY = dot.geometry
          ? (dot.geometry.boundingBox.min.y + dot.geometry.boundingBox.max.y) / 2
          : bb.max.y;
        const margin = (bb.max.y - bb.min.y) * (profile.trackpadDotLift ?? 0.05);
        dotLiftY = Math.max(0, bb.max.y - dotCenterY) + margin;
      } else {
        console.warn(`Trackpad indicator '${cfg.indicator}' not found in model`);
      }
      // Capture the pad mesh's baseline emissive so a click glow can be
      // cleanly restored on release (rather than blindly zeroing it and
      // clobbering any baked/parent-set emissive).
      const padMat = padMesh.material;
      const baseEmissive = padMat && 'emissive' in padMat ? padMat.emissive.getHex() : null;
      const baseEmissiveIntensity = padMat && 'emissiveIntensity' in padMat
        ? padMat.emissiveIntensity : 0;
      const pad = {
        point: cfg.point,
        width: bb.max.x - bb.min.x,
        depth: bb.max.z - bb.min.z,
        bbMinX: bb.min.x,        // geometry-local origin, for the fill center
        bbMinZ: bb.min.z,
        bbMaxY: bb.max.y,        // AABB top; ray starts above it to find the real surface
        thickness: bb.max.y - bb.min.y,
        centerSurface: null,     // cached pad-center surface point (dot-parent local), lazily raycast
        dotLiftY,
        dot,
        restPos,
        color: this._touchColors[idx % this._touchColors.length],
        padMesh,                 // whole-pad mesh, lit up on a physical click
        baseEmissive,
        baseEmissiveIntensity,
        clickState: false,       // prior-frame click, so we only set on transitions
        fill: null,              // radial click-fill animation state (issue #57)
      };
      this._installPadFillShader(pad);
      this._trackpads.push(pad);
    });
  }

  // Experiment (#57): a radial color-fill that spreads from the click point out
  // to cover the whole trackpad on a full press. Injects a small additive
  // emissive term into the pad's standard material via onBeforeCompile: every
  // fragment inside an animated radius (measured from the click center in the
  // pad geometry's local XZ plane) gets the press color. The pad mesh itself
  // clips the fill to the trackpad shape. Uniforms are advanced per-frame in
  // _updateTrackpadFills; the click edge in _updateTrackpads seeds the center.
  _installPadFillShader(pad) {
    const mat = pad.padMesh?.material;
    if (!mat || !('emissive' in mat)) return;
    pad.fill = {
      phase: 'idle',                       // 'idle' | 'expand' | 'hold' | 'fade'
      progress: 0,                         // 0..1 radius fraction
      alpha: 0,                            // 0..1 fill opacity (fades on release)
      releaseRequested: false,             // released mid-expand → fade once expand finishes
      center: new THREE.Vector2(
        pad.bbMinX + pad.width / 2,
        pad.bbMinZ + pad.depth / 2,
      ),
      color: new THREE.Color(this._pressColor),
      maxRadius: 0.5 * Math.hypot(pad.width, pad.depth) * 1.05, // cover corners
      uniforms: null,
    };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFillCenter = { value: pad.fill.center };
      shader.uniforms.uFillRadius = { value: 0 };
      shader.uniforms.uFillColor = { value: pad.fill.color };
      shader.uniforms.uFillAlpha = { value: 0 };
      shader.uniforms.uFillEdge = { value: pad.fill.maxRadius * 0.18 }; // soft front
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPadXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vPadXZ = position.xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\nvarying vec2 vPadXZ;\nuniform vec2 uFillCenter;\nuniform float uFillRadius;\nuniform vec3 uFillColor;\nuniform float uFillAlpha;\nuniform float uFillEdge;')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n  float _fd = distance(vPadXZ, uFillCenter);\n  float _fm = 1.0 - smoothstep(uFillRadius - uFillEdge, uFillRadius, _fd);\n  totalEmissiveRadiance += uFillColor * (_fm * uFillAlpha * 1.5);');
      pad.fill.uniforms = shader.uniforms;
    };
    mat.needsUpdate = true;
  }

  // Raycast straight down (in the pad mesh's own frame) onto the actual pad
  // surface for the fractional touch (fx,fy), and return the hit in the dot's
  // parent-local space — or null if the column misses the mesh. The SC pads are
  // canted, and that tilt is baked into the mesh geometry (the node transform is
  // identity), so the AABB top is a flat horizontal plane that does NOT match
  // the real surface. Casting onto the mesh recovers the true (tilted/curved)
  // surface point. Uses the mesh's live world matrix, so it stays correct as
  // gyro rotates the whole model; the returned local point is invariant to that
  // rotation. (#93)
  _trackpadSurfaceLocal(pad, fx, fy) {
    const mesh = pad.padMesh;
    if (!mesh || !pad.dot) return null;
    mesh.updateWorldMatrix(true, false);
    const px = pad.bbMinX + fx * pad.width;
    const pz = pad.bbMinZ + fy * pad.depth;
    // Start a full pad-thickness above the AABB top so the vertical ray clears
    // the whole tilted top face, then aim down the pad's local -Y (in world).
    const origin = mesh.localToWorld(new THREE.Vector3(px, pad.bbMaxY + pad.thickness, pz));
    const dir = new THREE.Vector3(0, -1, 0)
      .applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion())).normalize();
    this._touchRaycaster.set(origin, dir);
    const hits = this._touchRaycaster.intersectObject(mesh, false);
    if (!hits.length) return null;
    return pad.dot.parent.worldToLocal(hits[0].point.clone());
  }

  _updateTrackpads(touchPoints) {
    const profile = PROFILES[this.controllerType];
    const range = profile.trackpadRange || 32768;
    const opts = {
      invertX: !!profile.trackpadInvertX,
      invertY: !!profile.trackpadInvertY,
      swapXY: !!profile.trackpadSwapXY,
    };
    for (const pad of this._trackpads) {
      const t = touchPoints[pad.point];

      // Whole-pad click highlight (issue #57): a physical press starts a radial
      // color-fill that spreads from the finger's click point out to cover the
      // whole pad; release fades it out. Only react on click transitions.
      const clicked = !!(t && t.clicked);
      if (clicked !== pad.clickState) {
        if (pad.fill) {
          const f = pad.fill;
          if (clicked) {
            // Seed the fill center at the finger position (geometry-local XZ),
            // matching where the indicator dot sits; fall back to pad center.
            if (t) {
              const { fx, fy } = normalizeTrackpad(t.x, t.y, range, opts);
              f.center.set(pad.bbMinX + fx * pad.width, pad.bbMinZ + fy * pad.depth);
            }
            f.color.set(this._pressColor);
            f.releaseRequested = false;
            // (Re)start the expand only from a settled state — if it's already
            // expanding/holding (e.g. pressure flickered across the threshold),
            // let it keep going rather than snapping back.
            if (f.phase === 'idle' || f.phase === 'fade') {
              f.phase = 'expand';
              f.progress = Math.max(f.progress, TRACKPAD_FILL_MIN);
              f.alpha = 1;
            }
          } else {
            // Release. The click is pressure-gated and often briefer than the
            // time-based expand — so DON'T cut the animation short: if we're
            // still expanding, just note the release and let the ripple finish
            // (it fades once it reaches full). Only a held-to-full press fades
            // immediately on release.
            if (f.phase === 'hold') f.phase = 'fade';
            else if (f.phase === 'expand') f.releaseRequested = true;
          }
        }
        pad.clickState = clicked;
      }

      if (!pad.dot || !pad.restPos) continue;
      // Note on sensitivity (#93): the dot shows whenever the finger is
      // detected (t.active === contact area > 0), which is the most sensitive
      // signal the firmware exposes — there is no lighter-touch capacitive bit
      // (verified against a real capture). A very light touch that never
      // registers contact area is a firmware/hardware floor, not something the
      // overlay can lower.
      if (t && t.active) {
        const { fx, fy } = normalizeTrackpad(t.x, t.y, range, opts);
        // Place the dot ON the real pad surface at the finger position by
        // raycasting onto the pad mesh, then moving the dot from its calibrated
        // rest (pad-center) position by the finger's surface-space delta. This
        // makes the dot hug the canted/curved pad instead of floating on the
        // flat AABB-top plane at the wrong angle (#93). Falls back to the old
        // flat placement if the ray misses (e.g. finger mapped off the mesh).
        if (!pad.centerSurface) pad.centerSurface = this._trackpadSurfaceLocal(pad, 0.5, 0.5) || null;
        const hit = this._trackpadSurfaceLocal(pad, fx, fy);
        if (pad.centerSurface && hit) {
          pad.dot.position.set(
            pad.restPos.x + (hit.x - pad.centerSurface.x),
            pad.restPos.y + (hit.y - pad.centerSurface.y),
            pad.restPos.z + (hit.z - pad.centerSurface.z),
          );
        } else {
          pad.dot.position.set(
            pad.restPos.x + (fx - 0.5) * pad.width,
            pad.restPos.y + pad.dotLiftY, // small lift above the modeled surface
            pad.restPos.z + (fy - 0.5) * pad.depth,
          );
        }
        pad.dot.visible = true;
        const m = pad.dot.material;
        if (m && 'emissive' in m) {
          m.emissive.set(pad.color);
          m.emissiveIntensity = 1.2;
        }
      } else {
        pad.dot.visible = false;
      }
    }
  }

  /**
   * Update touchpad visualization from WebHID touch data.
   * @param {Array} touchPoints — [{active, id, x, y}, {active, id, x, y}]
   * @param {boolean} touchpadButton — whether touchpad is clicked
   */
  updateTouchpad(touchPoints, touchpadButton) {
    if (!touchPoints) return;
    // Multi-pad controllers (Steam Controller) take the per-pad path.
    if (this._trackpads) { this._updateTrackpads(touchPoints); return; }
    if (!this._touchpadBounds) return;
    const profile = PROFILES[this.controllerType];
    if (!profile?.hasTouchpad) return;

    // Touchpad click → press-highlight glow on touchpad mesh
    const tpMesh = this._touchpadBounds.mesh;
    if (tpMesh?.material && 'emissive' in tpMesh.material) {
      if (touchpadButton && !this._touchpadClickState) {
        tpMesh.material.emissive.set(this._pressColor);
        tpMesh.material.emissiveIntensity = PRESS_GLOW;
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
   * Surface "shine" 0..1: glossier (lower roughness) + more reflective
   * (envMapIntensity) as it rises. 0 = matte (each material's authored look,
   * unchanged). Modulates from each material's ORIGINAL roughness so other
   * controllers aren't flattened.
   */
  setShine(value) {
    this._shine = Math.max(0, Math.min(1, value));
    this._applyShine();
  }

  // Load the reflection environment lazily and defensively: a failure here only
  // disables Shine, it never breaks model loading or the rest of the overlay.
  async _initEnvironment() {
    try {
      const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
      if (this._disposed || !this.renderer) return;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
      this._applyShine(); // a model may already be loaded
    } catch (err) {
      console.warn('Environment map unavailable; Shine reflections disabled.', err);
    }
  }

  _applyShine() {
    if (!this.model) return;
    const shine = this._shine;
    this.model.traverse((c) => {
      const m = c.material;
      if (!m || !m.isMeshStandardMaterial) return;
      if (m.userData._origRoughness === undefined) m.userData._origRoughness = m.roughness;
      m.roughness = m.userData._origRoughness * (1 - shine * 0.85);
      m.envMapIntensity = shine; // 0 = no reflection (matte); up = mirror-ish sheen
    });
  }

  /**
   * Set the color of "accent" meshes (dark parts).
   * @param {string} hexColor — CSS hex color e.g. '#1a1a1e'
   */
  setAccentColor(hexColor) {
    this._setColorGroup('accentColorMeshes', hexColor);
  }

  /**
   * Set the emissive "press" highlight color used for digital button,
   * stick-click, and trigger (pre-bottom) glow. The fully-pressed trigger
   * still snaps to red as a distinct bottoming-out cue.
   * @param {string} hexColor — CSS hex color e.g. '#ff3344'
   */
  setPressColor(hexColor) {
    this._pressColor = new THREE.Color(hexColor).getHex();
  }

  /**
   * Highlight the capacitive grip sensors while held (digital on/off). Two
   * INDEPENDENT indicators, each with its own toggle:
   *   • GLOW — an on-top billboard/cylinder marker per grip, rendered with
   *     depthTest off so it reads at ANY angle. Peak opacity = the Grip Glow
   *     Brightness setting. Gated by setGripVisible (_gripEnabled).
   *   • BARS — the left/right side strip meshes. They ease from a rest grey to
   *     the grip color (with a fixed emissive lift) while that side is gripped,
   *     so the bar itself shows activation (issue #74). Gated by
   *     setGripBarsVisible (_gripBarsVisible); brightness does NOT affect them.
   * @param {{left:boolean, right:boolean}} grips
   */
  setGripState(grips) {
    const map = PROFILES[this.controllerType]?.gripMeshes;
    if (!map || !grips) return;
    const gripCol = this._gripColorC || (this._gripColorC = new THREE.Color());
    gripCol.setHex(this._gripColor);
    const restCol = this._gripBarRestC || (this._gripBarRestC = new THREE.Color(GRIP_BAR_REST_COLOR));
    const black = this._gripBlackC || (this._gripBlackC = new THREE.Color(0x000000));
    for (const side of ['left', 'right']) {
      const gripped = !!grips[side];
      // On-top billboard glow marker — the handle activation cue. Brightness
      // sets its peak opacity; lerps in/out. Gated by the glow toggle.
      const marker = this._gripMarkers?.[side];
      if (marker) {
        marker.material.opacity = THREE.MathUtils.lerp(
          marker.material.opacity, (this._gripEnabled && gripped) ? this._gripBrightness : 0, LERP_SPEED
        );
      }
      // Bar mesh — ease toward the grip color (lit) while that side is gripped,
      // back to the inert rest grey when released, so the bar itself reads the
      // activation (issue #74). Gated by the bars toggle, independent of glow.
      const barActive = this._gripBarsVisible && gripped;
      const bar = this._gripBarMesh(map[side]);
      if (bar?.material?.color) {
        bar.material.color.lerp(barActive ? gripCol : restCol, LERP_SPEED);
        if ('emissive' in bar.material) {
          bar.material.emissive.lerp(barActive ? gripCol : black, LERP_SPEED);
          bar.material.emissiveIntensity = THREE.MathUtils.lerp(
            bar.material.emissiveIntensity ?? 0, barActive ? GRIP_BAR_LIT_EMISSIVE : 0, LERP_SPEED
          );
        }
      }
    }
  }

  // The Mesh that carries a grip-bar's material (the GLB node may wrap it).
  _gripBarMesh(name) {
    const obj = this.meshes[name];
    return obj && (obj.isMesh ? obj : obj.children?.find((c) => c.isMesh)) || null;
  }

  /** Toggle the grip-sense GLOW (the on-top marker only — not the bars). */
  setGripVisible(enabled) {
    this._gripEnabled = !!enabled;
  }

  /** Show/hide the grip-sense BAR meshes (the physical bars on the handles). */
  setGripBarsVisible(enabled) {
    this._gripBarsVisible = !!enabled;
    this._applyGripBarsVisible();
  }

  _applyGripBarsVisible() {
    const map = PROFILES[this.controllerType]?.gripMeshes;
    if (!map) return;
    for (const side of ['left', 'right']) {
      const mesh = this.meshes[map[side]];
      if (mesh) mesh.visible = this._gripBarsVisible;
    }
  }

  /** Grip glow marker across-handle width (1..5 base units). */
  setGripGlowWidth(v) {
    this._gripGlowWidth = Math.max(1, Math.min(5, Math.round(v)));
    this._buildGripMarkers();
  }

  /** Grip glow marker front-to-back length along the handle / model Z (1..5). */
  setGripGlowLength(v) {
    this._gripGlowLength = Math.max(1, Math.min(5, Math.round(v)));
    this._buildGripMarkers();
  }

  /** On-top grip marker peak brightness (0–1). */
  setGripBrightness(value) {
    this._gripBrightness = Math.max(0, Math.min(1, value));
  }

  /** Grip highlight color (markers + the bar's lit state); CSS hex e.g. '#3388ff'. */
  setGripColor(hexColor) {
    this._gripColor = new THREE.Color(hexColor).getHex();
    if (this._gripMarkers) {
      for (const side of ['left', 'right']) this._gripMarkers[side]?.material.color.setHex(this._gripColor);
    }
    // The bars' rest grey is independent of the grip color; setGripState picks
    // up the new _gripColor for the lit state on the next report.
  }

  // Reset the grip-sense BAR meshes to their inert rest appearance (grey, no
  // emissive); setGripState lights them to the grip color while gripped. The
  // bars are excluded from the body/accent theme groups (PR #76) — otherwise
  // they'd take the body color and vanish into it — so they're driven here.
  // Each bar's material is cloned once so left/right light up independently
  // (GLB models often share one material across both meshes).
  _applyGripBarColor() {
    const map = PROFILES[this.controllerType]?.gripMeshes;
    if (!map) return;
    for (const side of ['left', 'right']) {
      const mesh = this._gripBarMesh(map[side]);
      if (!mesh?.material?.color) continue;
      if (!mesh.material._gripCloned) {
        mesh.material = mesh.material.clone();
        mesh.material._gripCloned = true;
      }
      mesh.material.color.setHex(GRIP_BAR_REST_COLOR);
      if ('emissive' in mesh.material) {
        mesh.material.emissive.setHex(0x000000);
        mesh.material.emissiveIntensity = 0;
      }
      mesh.material.needsUpdate = true;
    }
  }

  // Set up the on-top grip glow markers. Computes each marker's pinned handle
  // position + base size once (geometry-derived), then builds the actual marker
  // objects for the current shape. Markers live under bodyGroup so they ride
  // with the controller; depthTest off so they're never hidden by the body.
  _setupGripMarkers(profile) {
    this._disposeGripMarkers();
    this._gripMarkerSpecs = null;
    const map = profile.gripMeshes;
    if (!map) return;
    if (!this._glowTexture) {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
      this._glowTexture = new THREE.CanvasTexture(c);
    }
    const modelBox = new THREE.Box3().setFromObject(this.model);
    const modelCenterX = (modelBox.min.x + modelBox.max.x) / 2;
    // Push each marker outward (left → farther left, right → farther right) by
    // this fraction of the model width; side derived from geometry.
    const sideOffset = (modelBox.max.x - modelBox.min.x) * (profile.gripMarkerSideOffset ?? 0);
    const specs = {};
    for (const side of ['left', 'right']) {
      const mesh = this.meshes[map[side]];
      if (!mesh) continue;
      const gb = new THREE.Box3().setFromObject(mesh);
      const pos = gb.getCenter(new THREE.Vector3());
      pos.x += (pos.x < modelCenterX ? -sideOffset : sideOffset);
      // Lift toward the top but keep it down on the handle (not the mid/top).
      // gripMarkerHeight: 0 = grip center, 1 = controller top.
      const h = profile.gripMarkerHeight ?? 0.5;
      pos.y = pos.y + (modelBox.max.y - pos.y) * h;
      // Store the handle's actual extents so the glow can be sized to stay
      // CONTAINED inside the handle (cross-section from the thin X/Y, length
      // from Z). world == bodyGroup-local at setup (bodyGroup unrotated).
      specs[side] = {
        pos,
        dimX: gb.max.x - gb.min.x,
        dimY: gb.max.y - gb.min.y,
        dimZ: gb.max.z - gb.min.z,
      };
    }
    this._gripMarkerSpecs = specs;
    this._buildGripMarkers();
  }

  _disposeGripMarkers() {
    if (!this._gripMarkers) return;
    for (const side of ['left', 'right']) {
      const m = this._gripMarkers[side];
      if (!m) continue;
      this.bodyGroup?.remove(m);
      m.material?.dispose?.();
      m.geometry?.dispose?.(); // sprites share a built-in geometry; meshes own theirs
    }
    this._gripMarkers = null;
  }

  // (Re)build the marker objects from the stored specs at the current size.
  //  - width 1 AND length 1: a camera-facing billboard sprite (a small circle;
  //    symmetric, so yaw is moot).
  //  - otherwise: a 3D CYLINDER pinned to the handle, its axis running
  //    FRONT-TO-BACK (model Z, the handle's long axis); length sets the height,
  //    width sets the diameter. A cylinder has volume, so unlike a flat plane it
  //    never collapses to a line/dot at grazing angles. depthTest off keeps it
  //    on top; as a child of the body it turns with the controller (yaw).
  _buildGripMarkers() {
    this._disposeGripMarkers();
    const specs = this._gripMarkerSpecs;
    if (!specs) return;
    const w = this._gripGlowWidth;
    const len = this._gripGlowLength;
    const isCircle = w === 1 && len === 1;
    // Yaw (about the vertical Y axis) that swings each glow's front (+Z, the
    // bumper/trigger end) toward the controller's centerline — see it in the Top
    // view. Per-profile knob in degrees; sign flips per side below.
    const yaw = THREE.MathUtils.degToRad(PROFILES[this.controllerType]?.gripMarkerYaw ?? 0);
    // Band texture for the cylinder glow: uniform AROUND the tube (so the color
    // wraps the whole circumference, not just one facing strip like the radial
    // texture did), and a bright plateau filling MOST of the length with just a
    // soft fade at the very ends. The Length slider scales the cylinder height,
    // so this keeps the glow filling ~the whole cylinder (max Length ≈ the full
    // handle) instead of only a short middle band. Maps v (0..1) → height.
    if (!this._barGlowTexture) {
      const c = document.createElement('canvas'); c.width = 4; c.height = 64;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, 64);
      g.addColorStop(0.00, 'rgba(255,255,255,0)');
      g.addColorStop(0.10, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.90, 'rgba(255,255,255,0.95)');
      g.addColorStop(1.00, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 64);
      this._barGlowTexture = new THREE.CanvasTexture(c);
    }
    const markers = {};
    for (const side of ['left', 'right']) {
      const spec = specs[side];
      if (!spec) continue;
      // Size everything from the handle's own extents so the glow stays INSIDE
      // the handle. The cross-section uses the thin X/Y; the length uses Z. The
      // 1..5 sliders map to a fraction (v/5) of these maxima, so even the
      // largest setting is bounded by the handle.
      const thin = Math.min(spec.dimX, spec.dimY);
      let obj;
      let yLift = 0;
      if (isCircle) {
        obj = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this._glowTexture, color: this._gripColor, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
        }));
        const d = thin * 0.9;
        obj.scale.set(d, d, 1);
      } else {
        // Read as a soft GLOW that's still visible over the light handles. The
        // band texture wraps the FULL circumference (color all the way around the
        // tube, consistent from any angle) and fills most of the length, fading
        // softly only at the very ends. NORMAL blending keeps
        // it visible on any background. (Pure additive looked like a real glow
        // but vanished over the bright body — additive adds to the destination,
        // and there's no headroom over near-white, so it only showed over dark
        // areas. A radial texture only lit one facing strip of the tube.)
        const mat = new THREE.MeshBasicMaterial({
          map: this._barGlowTexture,
          color: this._gripColor, transparent: true, opacity: 0,
          blending: THREE.NormalBlending, depthTest: false, depthWrite: false,
        });
        // Cylinder: radius ≤ half the handle's thin cross-section; height ≤ the
        // handle's Z length. Built along Y, rotated so its axis runs
        // front-to-back (model Z, the handle's long axis). Open-ended (no cap
        // disks) so the band fades cleanly at the ends with no flat cap showing.
        const radius = (thin * 0.45) * (w / 5);
        const height = (spec.dimZ * 1.35) * (len / 5); // ~50% longer than before
        const geo = new THREE.CylinderGeometry(radius, radius, height, 20, 1, true);
        // Lay the cylinder front-to-back (axis → Z), then tilt it so the back
        // (−Z) end rises ~1/3 of its length, angling it inline with the handle.
        // asin(2/3): with a centre pivot the end rises (height/2)·(2/3) = height/3.
        geo.rotateX(Math.PI / 2 + Math.asin(2 / 3));
        obj = new THREE.Mesh(geo, mat);
        // Raise the whole bar on Y by ~25% of the DEFAULT (len 4) length.
        yLift = 0.25 * (spec.dimZ * 1.35 * (4 / 5));
      }
      obj.renderOrder = 10; // draw after the model so it sits on top
      obj.position.copy(spec.pos);
      obj.position.y += yLift;
      // Angle the bumper/trigger end inward toward center. Sign mirrors per
      // side: left handle (−X) yaws −, right handle (+X) yaws +. No-op on the
      // circle sprite (it billboards).
      obj.rotation.y = (spec.pos.x < 0 ? -1 : 1) * yaw;
      this.bodyGroup.add(obj);
      markers[side] = obj;
    }
    this._gripMarkers = markers;
  }

  // Move the grip-sense bar meshes from their modeled spot (low on the back of
  // the controller, where they're hidden under the body) out to just beyond
  // the controller's left/right silhouette, so the bars — and the emissive
  // glow they get while a grip is held (setGripState) — are visible in use.
  // Opt-in per profile via gripBarsToSides; gripBarSideGap tunes the gap.
  _repositionGripBars(profile) {
    const map = profile.gripMeshes;
    if (!map || !profile.gripBarsToSides) return;
    const modelBox = new THREE.Box3().setFromObject(this.model);
    const centerX = (modelBox.min.x + modelBox.max.x) / 2;
    const gap = (modelBox.max.x - modelBox.min.x) * (profile.gripBarSideGap ?? 0.02);
    const parentScale = new THREE.Vector3();
    for (const side of ['left', 'right']) {
      const mesh = this.meshes[map[side]];
      if (!mesh) continue;
      const box = new THREE.Box3().setFromObject(mesh);
      const cx = (box.min.x + box.max.x) / 2;
      const halfW = (box.max.x - box.min.x) / 2;
      // Sit the bar fully OUTSIDE the side it's already on (derived from
      // geometry, so naming can't flip it).
      const onLeft = cx < centerX;
      const targetCx = onLeft ? modelBox.min.x - gap - halfW : modelBox.max.x + gap + halfW;
      // Convert the world-space shift to the mesh's local frame (model has a
      // uniform scale and no rotation at setup, so X maps straight through).
      mesh.parent.getWorldScale(parentScale);
      mesh.position.x += (targetCx - cx) / (parentScale.x || 1);
      mesh.updateMatrixWorld(true);
      const orig = this.originals[map[side]];
      if (orig) orig.posX = mesh.position.x; // keep rest pose consistent
    }
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
    // Tear down layout-editor listeners + handles.
    const el = this.renderer?.domElement;
    el?.removeEventListener('pointerdown', this._boundPointerDown);
    window.removeEventListener('pointermove', this._boundPointerMove);
    window.removeEventListener('pointerup', this._boundPointerUp);
    window.removeEventListener('keydown', this._boundKeyDown);
    if (this._selectionBox) { this.scene?.remove(this._selectionBox); this._selectionBox = null; }
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
