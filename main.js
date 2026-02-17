// ============================================================
// TANDEMONIUM - Tandem Bicycle Physics Game
// ============================================================
// Architecture: Components separated for future multiplayer
// - PedalController: Rhythmic pedaling (assignable to Player 2)
// - BalanceController: Lean/balance (assignable to Player 1)
// - RiderComponent: Visual rider (front/rear independent)
// - TandemBike: Physics entity + visuals
// - ChaseCamera: Smooth third-person camera
// - World: Environment
// - HUD: On-screen display
// - Game: Main loop orchestration
// ============================================================

(function () {
    'use strict';

    // ============================================================
    // MOBILE DETECTION
    // ============================================================
    const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1);

    if (isMobile) {
        document.body.classList.add('is-mobile');
    }

    // ============================================================
    // INPUT MANAGER
    // Unified input: keyboard + touch + device motion
    // ============================================================
    class InputManager {
        constructor() {
            this.keys = {};
            this.touchLeft = false;
            this.touchRight = false;
            this.motionLean = 0;       // -1 to 1 from device tilt
            this.motionEnabled = false;
            this.motionReady = false;   // true after iOS permission granted
            this.rawGamma = 0;         // raw gamma from device orientation
            this.motionOffset = null;  // calibration offset (null = not calibrated)
            this._setupKeyboard();
            if (isMobile) {
                this._setupTouch();
                this._setupMotion();
                this._setupCalibration();
            }
        }

        _setupKeyboard() {
            window.addEventListener('keydown', (e) => {
                if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'].includes(e.code)) {
                    e.preventDefault();
                }
                this.keys[e.code] = true;
            });
            window.addEventListener('keyup', (e) => {
                this.keys[e.code] = false;
            });
        }

        _setupTouch() {
            const leftBtn = document.getElementById('touch-left');
            const rightBtn = document.getElementById('touch-right');

            const setTouch = (el, side, pressed) => {
                el.addEventListener(pressed ? 'touchstart' : 'touchend', (e) => {
                    e.preventDefault();
                    if (side === 'left') this.touchLeft = pressed;
                    else this.touchRight = pressed;
                }, { passive: false });
            };

            setTouch(leftBtn, 'left', true);
            setTouch(leftBtn, 'left', false);
            setTouch(rightBtn, 'right', true);
            setTouch(rightBtn, 'right', false);

            // Handle touchcancel (finger slides off)
            leftBtn.addEventListener('touchcancel', () => { this.touchLeft = false; });
            rightBtn.addEventListener('touchcancel', () => { this.touchRight = false; });

            // Handle finger leaving the button area
            leftBtn.addEventListener('touchmove', (e) => {
                const touch = e.touches[0];
                const rect = leftBtn.getBoundingClientRect();
                if (touch.clientX < rect.left || touch.clientX > rect.right ||
                    touch.clientY < rect.top || touch.clientY > rect.bottom) {
                    this.touchLeft = false;
                }
            }, { passive: false });
            rightBtn.addEventListener('touchmove', (e) => {
                const touch = e.touches[0];
                const rect = rightBtn.getBoundingClientRect();
                if (touch.clientX < rect.left || touch.clientX > rect.right ||
                    touch.clientY < rect.top || touch.clientY > rect.bottom) {
                    this.touchRight = false;
                }
            }, { passive: false });
        }

        _setupMotion() {
            // Check if we need iOS 13+ permission
            if (typeof DeviceMotionEvent !== 'undefined' &&
                typeof DeviceMotionEvent.requestPermission === 'function') {
                // iOS 13+ requires user gesture to enable motion
                this._showiOSPermission();
            } else if (typeof DeviceOrientationEvent !== 'undefined') {
                // Android / older iOS - just start listening
                this._startMotionListening();
            }
        }

        _showiOSPermission() {
            const overlay = document.getElementById('motion-permission');
            const btn = document.getElementById('motion-btn');
            overlay.style.display = 'flex';

            btn.addEventListener('click', async () => {
                try {
                    const response = await DeviceMotionEvent.requestPermission();
                    if (response === 'granted') {
                        this._startMotionListening();
                    }
                } catch (e) {
                    // Permission denied or error, fall back to no motion
                    console.warn('Motion permission denied:', e);
                }
                overlay.style.display = 'none';
            }, { once: true });
        }

        _startMotionListening() {
            this.motionReady = true;
            window.addEventListener('deviceorientation', (e) => {
                this.motionEnabled = true;
                if (e.gamma !== null) {
                    this.rawGamma = e.gamma;

                    // Auto-calibrate on first reading if not yet calibrated
                    if (this.motionOffset === null) {
                        this.motionOffset = this.rawGamma;
                    }

                    // Steering wheel mapping:
                    // Tilt relative to calibrated zero position.
                    // Drop left side (gamma decreases from offset) → go left (negative)
                    // Drop right side (gamma increases from offset) → go right (positive)
                    const relative = this.rawGamma - this.motionOffset;
                    // ~18 degrees of tilt from center = full lean input
                    this.motionLean = Math.max(-1, Math.min(1, relative / 18));
                }
            });
        }

        _setupCalibration() {
            const gauge = document.getElementById('tilt-gauge');
            const flash = document.getElementById('calibrate-flash');

            const doCalibrate = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.motionOffset = this.rawGamma;
                this.motionLean = 0;

                // Visual feedback
                if (flash) {
                    flash.style.display = 'block';
                    setTimeout(() => { flash.style.display = 'none'; }, 800);
                }
            };

            gauge.addEventListener('touchstart', doCalibrate, { passive: false });
            gauge.addEventListener('click', doCalibrate);
        }

        isPressed(code) {
            if (code === 'ArrowLeft') return !!this.keys[code] || this.touchLeft;
            if (code === 'ArrowRight') return !!this.keys[code] || this.touchRight;
            return !!this.keys[code];
        }

        getMotionLean() {
            if (!this.motionEnabled) return 0;
            return this.motionLean;
        }
    }

    // ============================================================
    // PEDAL CONTROLLER
    // Processes rhythmic alternating pedal input
    // Future multiplayer: assign to Player 2
    // ============================================================
    class PedalController {
        constructor(input) {
            this.input = input;
            this.lastPedal = null;
            this.pedalPower = 0;
            this.crankAngle = 0;
            this.prevLeft = false;
            this.prevRight = false;
            this.lastPedalTime = 0;
            this.wasCorrect = false;
            this.wasWrong = false;
        }

        update(dt) {
            const now = performance.now() / 1000;
            const leftHeld = this.input.isPressed('ArrowLeft');
            const rightHeld = this.input.isPressed('ArrowRight');
            const leftJust = leftHeld && !this.prevLeft;
            const rightJust = rightHeld && !this.prevRight;
            const braking = leftHeld && rightHeld;

            let acceleration = 0;
            let wobble = 0;
            this.wasCorrect = false;
            this.wasWrong = false;

            if (braking) {
                this.pedalPower *= 0.95;
                this.prevLeft = leftHeld;
                this.prevRight = rightHeld;
                return { acceleration: 0, wobble: 0, braking: true, crankAngle: this.crankAngle };
            }

            if (leftJust) {
                const gap = now - this.lastPedalTime;
                if (this.lastPedal !== 'left') {
                    this.wasCorrect = true;
                    const cadence = gap < 0.8 ? (0.8 - gap) * 0.4 : 0;
                    this.pedalPower = Math.min(this.pedalPower + 0.2 + cadence, 1.0);
                    acceleration = 0.35 + 0.6 * this.pedalPower;
                } else {
                    this.wasWrong = true;
                    this.pedalPower = Math.max(this.pedalPower - 0.15, 0);
                    acceleration = 0.06;
                    wobble = 0.5;
                }
                this.lastPedal = 'left';
                this.lastPedalTime = now;
                this.crankAngle += Math.PI / 2;
            }

            if (rightJust) {
                const gap = now - this.lastPedalTime;
                if (this.lastPedal !== 'right') {
                    this.wasCorrect = true;
                    const cadence = gap < 0.8 ? (0.8 - gap) * 0.4 : 0;
                    this.pedalPower = Math.min(this.pedalPower + 0.2 + cadence, 1.0);
                    acceleration = 0.35 + 0.6 * this.pedalPower;
                } else {
                    this.wasWrong = true;
                    this.pedalPower = Math.max(this.pedalPower - 0.15, 0);
                    acceleration = 0.06;
                    wobble = 0.5;
                }
                this.lastPedal = 'right';
                this.lastPedalTime = now;
                this.crankAngle += Math.PI / 2;
            }

            this.pedalPower *= (1 - 0.4 * dt);

            this.prevLeft = leftHeld;
            this.prevRight = rightHeld;

            return { acceleration, wobble, braking: false, crankAngle: this.crankAngle };
        }
    }

    // ============================================================
    // BALANCE CONTROLLER
    // Processes lean input for balance
    // Desktop: A/D keys. Mobile: device motion tilt.
    // Future multiplayer: assign to Player 1
    // ============================================================
    class BalanceController {
        constructor(input) {
            this.input = input;
        }

        update() {
            let leanInput = 0;

            // Keyboard input (always active)
            if (this.input.isPressed('KeyA')) leanInput -= 1;
            if (this.input.isPressed('KeyD')) leanInput += 1;

            // Device motion input (mobile)
            const motion = this.input.getMotionLean();
            if (motion !== 0) {
                leanInput += motion;
            }

            // Clamp combined
            leanInput = Math.max(-1, Math.min(1, leanInput));

            return { leanInput };
        }
    }

    // ============================================================
    // RIDER COMPONENT
    // Visual rider - front and rear are separate for multiplayer
    // ============================================================
    class RiderComponent {
        constructor(seatZ, color, name) {
            this.name = name;
            this.seatZ = seatZ;
            this.group = new THREE.Group();

            const bodyMat = new THREE.MeshPhongMaterial({ color, flatShading: true });
            const skinMat = new THREE.MeshPhongMaterial({ color: 0xffcc99, flatShading: true });
            const pantsMat = new THREE.MeshPhongMaterial({ color: 0x334455, flatShading: true });
            const shoeMat = new THREE.MeshPhongMaterial({ color: 0x222222, flatShading: true });

            // Torso
            this.torso = this._box(0.35, 0.45, 0.22, bodyMat, 0, 1.32, seatZ);
            // Head
            this.head = this._box(0.2, 0.22, 0.2, skinMat, 0, 1.66, seatZ);
            // Helmet
            this._box(0.24, 0.12, 0.24, bodyMat, 0, 1.82, seatZ);

            // Left leg
            this.leftThigh = this._box(0.11, 0.3, 0.12, pantsMat, -0.1, 0.93, seatZ);
            this.leftShin = this._box(0.09, 0.25, 0.1, pantsMat, -0.1, 0.65, seatZ);
            this.leftFoot = this._box(0.09, 0.06, 0.16, shoeMat, -0.1, 0.48, seatZ + 0.03);

            // Right leg
            this.rightThigh = this._box(0.11, 0.3, 0.12, pantsMat, 0.1, 0.93, seatZ);
            this.rightShin = this._box(0.09, 0.25, 0.1, pantsMat, 0.1, 0.65, seatZ);
            this.rightFoot = this._box(0.09, 0.06, 0.16, shoeMat, 0.1, 0.48, seatZ + 0.03);
        }

        _box(w, h, d, mat, x, y, z) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
            mesh.position.set(x, y, z);
            mesh.castShadow = true;
            this.group.add(mesh);
            return mesh;
        }

        animatePedaling(crankAngle, speed) {
            const amp = Math.min(speed * 0.03, 0.14);
            const lOff = Math.sin(crankAngle) * amp;
            const rOff = Math.sin(crankAngle + Math.PI) * amp;

            this.leftThigh.position.y = 0.93 + lOff * 0.5;
            this.leftShin.position.y = 0.65 + lOff;
            this.leftFoot.position.y = 0.48 + lOff;
            this.leftFoot.position.z = this.seatZ + 0.03 + lOff * 0.3;

            this.rightThigh.position.y = 0.93 + rOff * 0.5;
            this.rightShin.position.y = 0.65 + rOff;
            this.rightFoot.position.y = 0.48 + rOff;
            this.rightFoot.position.z = this.seatZ + 0.03 + rOff * 0.3;

            this.torso.position.y = 1.32 + Math.abs(Math.sin(crankAngle * 2)) * 0.015;
        }
    }

    // ============================================================
    // TANDEM BIKE
    // Physics state + visual model
    // ============================================================
    class TandemBike {
        constructor(scene) {
            this.group = new THREE.Group();

            // Physics state
            this.position = new THREE.Vector3(0, 0, 0);
            this.heading = 0;
            this.lean = 0;
            this.leanVelocity = 0;
            this.speed = 0;
            this.distanceTraveled = 0;

            // Fall state
            this.fallen = false;
            this.fallTimer = 0;

            // Shared materials
            this.frameMat = new THREE.MeshPhongMaterial({ color: 0x22cc55, flatShading: true });
            this.metalMat = new THREE.MeshPhongMaterial({ color: 0x999999, flatShading: true });
            this.wheelMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a, flatShading: true });
            this.seatMat = new THREE.MeshPhongMaterial({ color: 0x333333, flatShading: true });

            this._buildFrame();
            this._buildWheels();

            // Riders (separate components for multiplayer)
            this.frontRider = new RiderComponent(0.5, 0x3388dd, 'front');
            this.rearRider = new RiderComponent(-0.5, 0xdd3344, 'rear');
            this.group.add(this.frontRider.group);
            this.group.add(this.rearRider.group);

            scene.add(this.group);
        }

        _addBox(w, h, d, mat, x, y, z, rx, ry, rz) {
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
            m.position.set(x, y, z);
            if (rx) m.rotation.x = rx;
            if (ry) m.rotation.y = ry;
            if (rz) m.rotation.z = rz;
            m.castShadow = true;
            this.group.add(m);
            return m;
        }

        _buildFrame() {
            this._addBox(0.06, 0.06, 2.2, this.frameMat, 0, 0.55, 0);
            this._addBox(0.05, 0.05, 1.5, this.frameMat, 0, 0.92, 0);
            this._addBox(0.05, 0.45, 0.05, this.frameMat, 0, 0.75, 0.45);
            this._addBox(0.05, 0.45, 0.05, this.frameMat, 0, 0.75, -0.45);
            this._addBox(0.2, 0.04, 0.22, this.seatMat, 0, 1.0, 0.45);
            this._addBox(0.2, 0.04, 0.22, this.seatMat, 0, 1.0, -0.45);
            this._addBox(0.04, 0.5, 0.04, this.metalMat, 0, 0.46, 1.02, 0.18);
            this._addBox(0.04, 0.5, 0.04, this.metalMat, 0, 0.46, -1.02, -0.18);
            this._addBox(0.05, 0.3, 0.05, this.metalMat, 0, 0.92, 0.82);
            this._addBox(0.5, 0.035, 0.035, this.metalMat, 0, 1.06, 0.86);
            this._addBox(0.07, 0.05, 0.05, this.seatMat, -0.26, 1.06, 0.86);
            this._addBox(0.07, 0.05, 0.05, this.seatMat, 0.26, 1.06, 0.86);
        }

        _buildWheels() {
            this.frontWheelSpin = new THREE.Group();
            this.rearWheelSpin = new THREE.Group();

            this._buildWheel(this.frontWheelSpin, 1.1);
            this._buildWheel(this.rearWheelSpin, -1.1);

            const fwg = new THREE.Group();
            fwg.position.set(0, 0.33, 1.1);
            fwg.add(this.frontWheelSpin);
            this.group.add(fwg);

            const rwg = new THREE.Group();
            rwg.position.set(0, 0.33, -1.1);
            rwg.add(this.rearWheelSpin);
            this.group.add(rwg);
        }

        _buildWheel(spinGroup, zPos) {
            const tire = new THREE.Mesh(
                new THREE.TorusGeometry(0.32, 0.045, 8, 24),
                this.wheelMat
            );
            tire.rotation.y = Math.PI / 2;
            tire.castShadow = true;
            spinGroup.add(tire);

            const hub = new THREE.Mesh(
                new THREE.CylinderGeometry(0.035, 0.035, 0.07, 8),
                this.metalMat
            );
            hub.rotation.z = Math.PI / 2;
            spinGroup.add(hub);

            for (let i = 0; i < 8; i++) {
                const spoke = new THREE.Mesh(
                    new THREE.BoxGeometry(0.012, 0.55, 0.012),
                    this.metalMat
                );
                spoke.rotation.x = (Math.PI / 8) * i;
                spinGroup.add(spoke);
            }
        }

        update(pedalResult, balanceResult, dt) {
            if (this.fallen) {
                this.fallTimer -= dt;
                if (this.fallTimer <= 0) this._reset();
                this._applyTransform();
                return;
            }

            // --- Braking ---
            if (pedalResult.braking) {
                this.speed *= (1 - 2.5 * dt);
                if (this.speed < 0.05) this.speed = 0;
            }

            // --- Acceleration (impulse per pedal stroke, not continuous) ---
            this.speed += pedalResult.acceleration;

            // Friction
            this.speed *= (1 - 0.6 * dt);
            this.speed = Math.max(0, Math.min(this.speed, 16));

            // --- Balance physics ---
            const gravity = Math.sin(this.lean) * 12.0;
            const playerLean = balanceResult.leanInput * 11.0;
            const gyro = -this.lean * Math.min(this.speed * 0.55, 4.5);
            const damping = -this.leanVelocity * 2.8;

            const pedalWobble = pedalResult.wobble * (Math.random() - 0.5) * 8;

            const t = performance.now() / 1000;
            const lowSpeedWobble = Math.max(0, 1 - this.speed * 0.25) *
                (Math.sin(t * 2.7) * 1.2 + Math.sin(t * 4.3) * 0.5);

            let pedalLeanKick = 0;
            if (pedalResult.acceleration > 0 && !pedalResult.braking) {
                pedalLeanKick = (Math.random() - 0.5) * 0.8;
            }

            this.leanVelocity += (gravity + playerLean + gyro + damping +
                pedalWobble + lowSpeedWobble + pedalLeanKick) * dt;
            this.lean += this.leanVelocity * dt;

            // --- Steering from lean ---
            const turnRate = this.lean * this.speed * 0.35;
            this.heading += turnRate * dt;

            // --- Position ---
            this.position.x += Math.sin(this.heading) * this.speed * dt;
            this.position.z += Math.cos(this.heading) * this.speed * dt;
            this.distanceTraveled += this.speed * dt;

            // --- Fall detection ---
            if (Math.abs(this.lean) > 0.85) {
                this._fall();
            }

            // --- Wheel spin ---
            const spinRate = this.speed / 0.32;
            this.frontWheelSpin.rotation.x -= spinRate * dt;
            this.rearWheelSpin.rotation.x -= spinRate * dt;

            // --- Rider animation ---
            this.frontRider.animatePedaling(pedalResult.crankAngle, this.speed);
            this.rearRider.animatePedaling(pedalResult.crankAngle + Math.PI, this.speed);

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
    }

    // ============================================================
    // CHASE CAMERA
    // Smooth third-person follow camera
    // ============================================================
    class ChaseCamera {
        constructor(camera) {
            this.camera = camera;
            this.smoothPos = 4.0;
            this.smoothLook = 5.0;
            this.currentPos = new THREE.Vector3(0, 3.5, -7);
            this.currentLook = new THREE.Vector3(0, 1.2, 3);
            this.shakeAmount = 0;
        }

        update(bike, dt) {
            const fwd = new THREE.Vector3(
                Math.sin(bike.heading), 0, Math.cos(bike.heading)
            );

            const desiredPos = bike.position.clone()
                .add(fwd.clone().multiplyScalar(-7))
                .add(new THREE.Vector3(0, 3.5, 0));
            desiredPos.y = Math.max(desiredPos.y, 1.5);

            const desiredLook = bike.position.clone()
                .add(fwd.clone().multiplyScalar(3))
                .add(new THREE.Vector3(0, 1.2, 0));

            const pLerp = 1 - Math.exp(-this.smoothPos * dt);
            const lLerp = 1 - Math.exp(-this.smoothLook * dt);
            this.currentPos.lerp(desiredPos, pLerp);
            this.currentLook.lerp(desiredLook, lLerp);

            const shake = new THREE.Vector3();
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

    // ============================================================
    // WORLD
    // Ground, road, environment
    // ============================================================
    class World {
        constructor(scene) {
            this.scene = scene;
            this._buildGround();
            this._buildRoad();
            this._buildTrees();
            this._buildMarkers();
            this._buildLighting();
        }

        _buildGround() {
            const geo = new THREE.PlaneGeometry(600, 600, 1, 1);
            const mat = new THREE.MeshPhongMaterial({ color: 0x4a8a3a, flatShading: true });
            const ground = new THREE.Mesh(geo, mat);
            ground.rotation.x = -Math.PI / 2;
            ground.receiveShadow = true;
            this.scene.add(ground);

            const grid = new THREE.GridHelper(600, 300, 0x3d7530, 0x3d7530);
            grid.position.y = 0.01;
            grid.material.opacity = 0.3;
            grid.material.transparent = true;
            this.scene.add(grid);
        }

        _buildRoad() {
            const roadGeo = new THREE.PlaneGeometry(5, 600);
            const roadMat = new THREE.MeshPhongMaterial({ color: 0x555555, flatShading: true });
            const road = new THREE.Mesh(roadGeo, roadMat);
            road.rotation.x = -Math.PI / 2;
            road.position.y = 0.02;
            road.receiveShadow = true;
            this.scene.add(road);

            const dashMat = new THREE.MeshPhongMaterial({ color: 0xdddd00, flatShading: true });
            for (let z = -295; z < 300; z += 4) {
                const dash = new THREE.Mesh(
                    new THREE.PlaneGeometry(0.12, 1.8),
                    dashMat
                );
                dash.rotation.x = -Math.PI / 2;
                dash.position.set(0, 0.03, z);
                this.scene.add(dash);
            }

            const edgeMat = new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true });
            for (const xOff of [-2.3, 2.3]) {
                const edge = new THREE.Mesh(
                    new THREE.PlaneGeometry(0.1, 600),
                    edgeMat
                );
                edge.rotation.x = -Math.PI / 2;
                edge.position.set(xOff, 0.03, 0);
                this.scene.add(edge);
            }
        }

        _buildTrees() {
            const trunkMat = new THREE.MeshPhongMaterial({ color: 0x7a5230, flatShading: true });
            const leafMat = new THREE.MeshPhongMaterial({ color: 0x2d8a2d, flatShading: true });
            const leafMat2 = new THREE.MeshPhongMaterial({ color: 0x1f7a1f, flatShading: true });

            for (let i = 0; i < 80; i++) {
                const side = Math.random() > 0.5 ? 1 : -1;
                const x = side * (5 + Math.random() * 50);
                const z = (Math.random() - 0.5) * 500;
                const scale = 0.7 + Math.random() * 0.8;

                const trunk = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.12 * scale, 0.18 * scale, 2.0 * scale, 6),
                    trunkMat
                );
                trunk.position.set(x, scale, z);
                trunk.castShadow = true;
                this.scene.add(trunk);

                const mat = Math.random() > 0.5 ? leafMat : leafMat2;
                const canopy = new THREE.Mesh(
                    new THREE.SphereGeometry(1.0 * scale, 6, 5),
                    mat
                );
                canopy.position.set(x, 2.3 * scale, z);
                canopy.castShadow = true;
                this.scene.add(canopy);
            }
        }

        _buildMarkers() {
            const markerMat = new THREE.MeshPhongMaterial({ color: 0xcc4444, flatShading: true });
            const poleMat = new THREE.MeshPhongMaterial({ color: 0xdddddd, flatShading: true });

            for (let z = 50; z <= 250; z += 50) {
                for (const xSide of [-3.5, 3.5]) {
                    const pole = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.04, 0.04, 1.5, 6),
                        poleMat
                    );
                    pole.position.set(xSide, 0.75, z);
                    pole.castShadow = true;
                    this.scene.add(pole);

                    const sign = new THREE.Mesh(
                        new THREE.BoxGeometry(0.6, 0.35, 0.05),
                        markerMat
                    );
                    sign.position.set(xSide, 1.6, z);
                    sign.castShadow = true;
                    this.scene.add(sign);
                }
            }
        }

        _buildLighting() {
            const ambient = new THREE.AmbientLight(0x5566aa, 0.5);
            this.scene.add(ambient);

            this.sun = new THREE.DirectionalLight(0xffffdd, 1.1);
            this.sun.position.set(30, 40, 20);
            this.sun.castShadow = true;
            this.sun.shadow.mapSize.width = isMobile ? 1024 : 2048;
            this.sun.shadow.mapSize.height = isMobile ? 1024 : 2048;
            this.sun.shadow.camera.near = 1;
            this.sun.shadow.camera.far = 120;
            this.sun.shadow.camera.left = -35;
            this.sun.shadow.camera.right = 35;
            this.sun.shadow.camera.top = 35;
            this.sun.shadow.camera.bottom = -35;
            this.scene.add(this.sun);
            this.scene.add(this.sun.target);

            const hemi = new THREE.HemisphereLight(0x99bbff, 0x44aa44, 0.35);
            this.scene.add(hemi);
        }

        updateSun(bikePos) {
            this.sun.position.set(bikePos.x + 30, 40, bikePos.z + 20);
            this.sun.target.position.copy(bikePos);
            this.sun.target.updateMatrixWorld();
        }
    }

    // ============================================================
    // HUD
    // On-screen display (desktop + mobile)
    // ============================================================
    class HUD {
        constructor(input) {
            this.input = input;
            this.speedEl = document.getElementById('speed');
            this.distanceEl = document.getElementById('distance');
            this.statusEl = document.getElementById('status');
            this.pedalL = document.getElementById('pedal-l');
            this.pedalR = document.getElementById('pedal-r');
            this.tiltNeedle = document.getElementById('tilt-needle');
            this.tiltLabel = document.getElementById('tilt-label');
            this.crashOverlay = document.getElementById('crash-overlay');
            this.instructions = document.getElementById('instructions');
            this.instructionsVisible = true;
            this.crashFlash = 0;

            // Mobile touch button elements
            this.touchLeftEl = document.getElementById('touch-left');
            this.touchRightEl = document.getElementById('touch-right');
        }

        update(bike, input, pedalCtrl, dt) {
            const kmh = Math.round(bike.speed * 3.6);
            this.speedEl.textContent = 'Speed: ' + kmh + ' km/h';
            this.distanceEl.textContent = 'Distance: ' + Math.round(bike.distanceTraveled) + ' m';

            const leftHeld = input.isPressed('ArrowLeft');
            const rightHeld = input.isPressed('ArrowRight');
            const braking = leftHeld && rightHeld;

            // Desktop pedal indicators
            this.pedalL.className = 'pedal-key';
            this.pedalR.className = 'pedal-key';

            if (braking) {
                this.pedalL.className = 'pedal-key brake';
                this.pedalR.className = 'pedal-key brake';
            } else {
                if (leftHeld) {
                    this.pedalL.className = 'pedal-key ' + (pedalCtrl.wasWrong ? 'wrong' : 'active');
                }
                if (rightHeld) {
                    this.pedalR.className = 'pedal-key ' + (pedalCtrl.wasWrong ? 'wrong' : 'active');
                }
            }

            // Mobile touch button feedback
            if (isMobile && this.touchLeftEl && this.touchRightEl) {
                let lClass = 'touch-pedal touch-pedal-left';
                let rClass = 'touch-pedal touch-pedal-right';

                if (braking) {
                    lClass += ' brake';
                    rClass += ' brake';
                } else {
                    if (leftHeld) lClass += (pedalCtrl.wasWrong ? ' wrong' : ' pressed');
                    if (rightHeld) rClass += (pedalCtrl.wasWrong ? ' wrong' : ' pressed');
                }

                this.touchLeftEl.className = lClass;
                this.touchRightEl.className = rClass;
            }

            // Tilt gauge
            const tiltDeg = (bike.lean * 180 / Math.PI);
            const clampedDeg = Math.max(-90, Math.min(90, tiltDeg));
            this.tiltNeedle.setAttribute('transform', 'rotate(' + clampedDeg.toFixed(1) + ', 60, 60)');
            this.tiltLabel.textContent = Math.abs(tiltDeg).toFixed(1) + '\u00B0';
            const danger = Math.abs(bike.lean) / 0.85;
            if (danger > 0.75) {
                this.tiltLabel.style.color = '#ff4444';
            } else if (danger > 0.5) {
                this.tiltLabel.style.color = '#ffaa22';
            } else {
                this.tiltLabel.style.color = '#ffffff';
            }

            // Status text
            if (bike.fallen) {
                this.statusEl.textContent = 'CRASHED! Resetting...';
                this.statusEl.style.color = '#ff4444';
            } else if (bike.speed < 0.3 && bike.distanceTraveled > 0.5) {
                this.statusEl.textContent = isMobile ? 'Tap L R to pedal!' : 'Pedal! Alternate \u2190 \u2192';
                this.statusEl.style.color = '#ffdd44';
            } else {
                this.statusEl.textContent = '';
            }

            // Crash flash
            if (bike.fallen && this.crashFlash === 0) {
                this.crashFlash = 1;
                this.crashOverlay.style.background = 'rgba(255, 0, 0, 0.35)';
            }
            if (this.crashFlash > 0) {
                this.crashFlash -= dt * 2;
                if (this.crashFlash <= 0) {
                    this.crashFlash = 0;
                    this.crashOverlay.style.background = 'rgba(255, 0, 0, 0)';
                }
            }

            // Hide instructions on first input
            if (this.instructionsVisible && (leftHeld || rightHeld)) {
                this.instructions.style.opacity = '0';
                this.instructionsVisible = false;
                setTimeout(() => {
                    this.instructions.style.display = 'none';
                }, 800);
            }
        }
    }

    // ============================================================
    // GAME
    // Main loop orchestration
    // ============================================================
    class Game {
        constructor() {
            this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile });
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            document.body.appendChild(this.renderer.domElement);

            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(0x7ec8e3);
            this.scene.fog = new THREE.FogExp2(0x7ec8e3, 0.006);

            this.camera = new THREE.PerspectiveCamera(
                60, window.innerWidth / window.innerHeight, 0.1, 500
            );

            this.input = new InputManager();
            this.pedalCtrl = new PedalController(this.input);
            this.balanceCtrl = new BalanceController(this.input);
            this.world = new World(this.scene);
            this.bike = new TandemBike(this.scene);
            this.chaseCamera = new ChaseCamera(this.camera);
            this.hud = new HUD(this.input);

            this.lastTime = performance.now();

            window.addEventListener('resize', () => this._onResize());

            // Lock screen orientation on mobile if supported
            if (isMobile && screen.orientation && screen.orientation.lock) {
                screen.orientation.lock('landscape').catch(() => {});
            }

            this._loop();
        }

        _onResize() {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        }

        _loop() {
            requestAnimationFrame(() => this._loop());

            const now = performance.now();
            let dt = (now - this.lastTime) / 1000;
            this.lastTime = now;
            dt = Math.min(dt, 0.05);

            const pedalResult = this.pedalCtrl.update(dt);
            const balanceResult = this.balanceCtrl.update();

            this.bike.update(pedalResult, balanceResult, dt);

            if (this.bike.speed > 8) {
                this.chaseCamera.shakeAmount = Math.max(
                    this.chaseCamera.shakeAmount,
                    (this.bike.speed - 8) * 0.008
                );
            }
            if (this.bike.fallen) {
                this.chaseCamera.shakeAmount = 0.15;
            }

            this.chaseCamera.update(this.bike, dt);
            this.world.updateSun(this.bike.position);
            this.hud.update(this.bike, this.input, this.pedalCtrl, dt);
            this.renderer.render(this.scene, this.camera);
        }
    }

    // ============================================================
    // START
    // ============================================================
    window.addEventListener('load', () => {
        new Game();
    });

})();
