// ============================================================
// CONTROLLER PROFILES — per-controller 3D model configuration
// ============================================================

/**
 * Each profile defines:
 *  - model:          path to GLB file relative to src/
 *  - name:           display name
 *  - buttonMap:      Gamepad API button index → mesh name in GLB
 *  - axisMap:        Gamepad API axis index → { mesh, component: 'x'|'z' }
 *  - pressDepth:     how far buttons translate on press (metres)
 *  - triggerMaxAngle: max trigger rotation in radians (~30°)
 *  - stickMaxTilt:   max stick tilt in radians (~15°)
 *  - hasGyro:        whether WebHID gyro is supported
 *  - hasTouchpad:    whether WebHID touchpad is supported
 *  - bodyMesh:       mesh name for the controller body (gyro target)
 */

export const PROFILES = {
  dualsense: {
    model: 'assets/controllers/dualsense.glb',
    name: 'DualSense',

    // Gamepad API standard button index → mesh name
    buttonMap: {
      0:  'face_cross',       // Cross / A
      1:  'face_circle',      // Circle / B
      2:  'face_square',      // Square / X
      3:  'face_triangle',    // Triangle / Y
      4:  'bumper_l1',        // L1
      5:  'bumper_r1',        // R1
      8:  'button_create',    // Create / Share
      9:  'button_options',   // Options / Start
      12: 'dpad_up',
      13: 'dpad_down',
      14: 'dpad_left',
      15: 'dpad_right',
      16: 'button_ps',        // PS button
      17: 'button_mic',       // Mic / mute (procedurally added — not in GLB)
    },

    // Analog triggers (button index → mesh, animated by value 0-1)
    triggerMap: {
      6: 'trigger_l2',
      7: 'trigger_r2',
    },

    // Gamepad API axes → stick assemblies
    // Each stick has multiple meshes that tilt together, pivoting at the base
    // axes[0]=left X, axes[1]=left Y, axes[2]=right X, axes[3]=right Y
    stickMap: {
      left:  { meshes: ['stick_left', 'stick_left_ring', 'stick_left_base'], axisX: 0, axisY: 1 },
      right: { meshes: ['stick_right', 'stick_right_ring', 'stick_right_base'], axisX: 2, axisY: 3 },
    },

    pressDepth: 0.002,        // 2mm button press depth
    triggerMaxAngle: 0.52,    // ~30 degrees
    stickMaxTilt: 0.26,       // ~15 degrees

    hasGyro: true,
    // DualSense driver outputs (pitch, yaw, roll) directly — no transform needed
    gyroTransform: (gx, gy, gz) => [gx, gy, gz],
    hasTouchpad: true,
    touchpadMesh: 'touchpad',
    touchPoint1Mesh: 'touch_point1',
    touchPoint2Mesh: 'touch_point2',
    bodyMeshes: ['body_top', 'body_bottom', 'body_extra'],  // gyro applied to bodyGroup parent

    // "Pop-off" parts: float clear of the body (toggle in settings). Triggers +
    // bumpers flip UP to the top and EXTEND out the back, stacked bumper-then-
    // trigger (same scheme as the Steam Controller — see that profile for the
    // back/up meaning). DualSense geometry differs, so these may want their own
    // numbers, but they start matched for parity.
    floatParts: ['trigger_l2', 'trigger_r2', 'bumper_l1', 'bumper_r1'],
    floatFactor: 0.6,
    floatTuning: {
      bumper_l1:  { back: 0.12, up: 0.16, tiltUp: 65 },
      bumper_r1:  { back: 0.12, up: 0.16, tiltUp: 65 },
      trigger_l2: { back: 0.34, up: 0.34, tiltUp: 65 },
      trigger_r2: { back: 0.34, up: 0.34, tiltUp: 65 },
    },

    // Color groups for user-customizable body/accent colors
    bodyColorMeshes: [
      'body_top', 'face_cross', 'face_circle', 'face_square', 'face_triangle',
      'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right', 'touchpad',
      'button_create', 'button_options',
    ],
    accentColorMeshes: [
      'body_bottom', 'body_extra', 'bumper_l1', 'bumper_r1',
      'trigger_l2', 'trigger_r2', 'button_ps', 'button_mic',
    ],
    defaultBodyColor: '#e8e8ec',
    defaultAccentColor: '#1a1a1e',
    // Per-controller labels for the 2D button HUD. Keys are Gamepad-API
    // standard button indices; missing keys fall back to the default
    // ABXY/L1-R1-L2-R2 labels in the HTML markup. Use short text (≤3
    // chars) — the HUD elements are small.
    hudLabels: {
      0: '✕', 1: '○', 2: '□', 3: '△',   // ✕ ○ □ △
      4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2',
      8: 'Cre', 9: 'Opt', 16: 'PS', 17: 'TP',
    },
  },

  'switch-pro': {
    model: 'assets/controllers/switch-pro.glb',
    name: 'Switch Pro',
    buttonMap: {
      0:  'face_b',
      1:  'face_a',
      2:  'face_y',
      3:  'face_x',
      4:  'bumper_l',
      5:  'bumper_r',
      8:  'button_minus',
      9:  'button_plus',
      12: 'dpad_up',
      13: 'dpad_down',
      14: 'dpad_left',
      15: 'dpad_right',
      16: 'button_home',
      17: 'button_capture',
    },
    triggerMap: {
      6: 'trigger_zl',
      7: 'trigger_zr',
    },
    stickMap: {
      left:  { meshes: ['stick_left', 'stick_left_ring', 'stick_left_base'], axisX: 0, axisY: 1 },
      right: { meshes: ['stick_right', 'stick_right_ring', 'stick_right_base'], axisX: 2, axisY: 3 },
    },
    pressDepth: 0.002,
    triggerMaxAngle: 0.52,
    stickMaxTilt: 0.26,
    hasGyro: true,
    // Switch Pro driver remaps: output = {x: rawX, y: rawZ, z: rawY}
    // Swap pitch↔roll (gx↔gz) and negate both to match DualSense 3D orientation.
    gyroTransform: (gx, gy, gz) => [-gz, gy, -gx],
    hasTouchpad: false,
    bodyMeshes: ['body_top', 'body_bottom', 'body_extra'],
    bodyColorMeshes: [
      'body_top', 'face_a', 'face_b', 'face_x', 'face_y',
      'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
    ],
    accentColorMeshes: [
      'body_bottom', 'body_extra', 'bumper_l', 'bumper_r',
      'trigger_zl', 'trigger_zr', 'button_home',
      'button_minus', 'button_plus', 'button_capture',
    ],
    defaultBodyColor: '#2d2d2d',
    defaultAccentColor: '#1a1a1a',
    // Chromium remaps Nintendo Switch Pro to the Gamepad-API standard
    // layout (button 0 = bottom-of-face, etc.), so the labels reflect
    // whatever Nintendo's physical button is at that index position.
    hudLabels: {
      0: 'B',  1: 'A',  2: 'Y',  3: 'X',          // Nintendo: A right, B bottom
      4: 'L',  5: 'R',  6: 'ZL', 7: 'ZR',
      8: '−', 9: '+', 16: 'H', 17: 'Cap',    // − Plus Home Capture
    },
  },

  xbox: {
    model: 'assets/controllers/xbox.glb',
    name: 'Xbox',
    buttonMap: {
      0:  'face_a',
      1:  'face_b',
      2:  'face_x',
      3:  'face_y',
      4:  'bumper_lb',
      5:  'bumper_rb',
      8:  'button_view',
      9:  'button_menu',
      12: 'dpad_up',
      13: 'dpad_down',
      14: 'dpad_left',
      15: 'dpad_right',
      16: 'button_xbox',
    },
    triggerMap: {
      6: 'trigger_lt',
      7: 'trigger_rt',
    },
    stickMap: {
      left:  { meshes: ['stick_left', 'stick_left_ring', 'stick_left_base'], axisX: 0, axisY: 1 },
      right: { meshes: ['stick_right', 'stick_right_ring', 'stick_right_base'], axisX: 2, axisY: 3 },
    },
    pressDepth: 0.002,
    triggerMaxAngle: 0.52,
    stickMaxTilt: 0.26,
    hasGyro: false,
    hasTouchpad: false,
    bodyMeshes: ['body_top', 'body_bottom', 'body_extra'],
    bodyColorMeshes: [
      'body_top', 'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
    ],
    accentColorMeshes: [
      'body_bottom', 'body_extra', 'bumper_lb', 'bumper_rb',
      'trigger_lt', 'trigger_rt', 'button_xbox',
      'face_a', 'face_b', 'face_x', 'face_y',
      'button_view', 'button_menu',
    ],
    defaultBodyColor: '#f0f0f0',
    defaultAccentColor: '#1a1a1a',
    hudLabels: {
      0: 'A',  1: 'B',  2: 'X',  3: 'Y',
      4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
      8: 'Vw', 9: 'Mn', 16: 'Xb', 17: '',         // no standard 17 on Xbox
    },
  },

  // ─────────────────────────────────────────────────────────────
  // GameSir Super Nova (DS4 mode) — photogrammetry-sourced model
  // ─────────────────────────────────────────────────────────────
  //
  // Single monolithic mesh from a photogrammetry capture (~400K tris,
  // ~2.8 MB). Because the model isn't separated into per-button meshes,
  // **button presses / stick tilts / trigger pulls cannot animate** —
  // only whole-body gyro rotation works. The body mesh is named `node_0`
  // (the photogrammetry tool's auto-name; preserved on purpose so future
  // re-captures don't need a profile edit).
  //
  // To enable button animations on this controller, source or model a
  // GLB with separated meshes (see docs/OPTIMIZING-GLB.md "Blender
  // path") and replace this entry.
  'gamesir-super-nova': {
    model: 'assets/controllers/gamesir-super-nova.glb',
    name: 'GameSir Super Nova',
    buttonMap: {},          // empty — no separated button meshes to animate
    triggerMap: {},         // empty — no separated trigger meshes
    stickMap: {},           // empty — no separated stick meshes
    pressDepth: 0.002,
    triggerMaxAngle: 0.52,
    stickMaxTilt: 0.26,
    hasGyro: true,
    // GameSir DS4 mode uses Sony's IMU layout (the lab's DS4 fix lands
    // gyro already aligned to the visualizer's convention).
    gyroTransform: (gx, gy, gz) => [gx, gy, gz],
    hasTouchpad: false,     // single mesh — no touchpad sub-mesh to highlight
    bodyMeshes: ['node_0'], // whole-body rotation target for gyro orientation
    // No color customization for a textured photogrammetry model.
    bodyColorMeshes: [],
    accentColorMeshes: [],
    defaultBodyColor: '#ffffff',
    defaultAccentColor: '#ffffff',
    // Super Nova ships with Xbox-style labels printed on the pad
    // (A B X Y, LB/LT/RB/RT) — match what's physically on the device.
    hudLabels: {
      0: 'A',  1: 'B',  2: 'X',  3: 'Y',
      4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
      8: 'Vw', 9: 'Mn', 16: 'Hm', 17: '',
    },
  },

  // ─────────────────────────────────────────────────────────────
  // Steam Controller (2026) — Valve CAD-sourced model (CC BY-NC-SA)
  // ─────────────────────────────────────────────────────────────
  //
  // GLB derived from Valve's official engineering STL release
  // (gitlab.steamos.cloud/SteamHardware/SteamController). See
  // assets/controllers/STEAM_CONTROLLER_ATTRIBUTION.md for the full
  // license + conversion pipeline. The source is a single solid body
  // with no separated parts, so this profile is body-only — gyro
  // rotates the whole mesh; buttons/sticks/triggers don't animate.
  //
  // NOTE on licensing: this single asset is CC BY-NC-SA 4.0 — see the
  // attribution file. The rest of the visualizer is MIT.
  'steam-controller': {
    // GLB built from ceski-1/3d-controller-overlay's per-component Steam
    // Controller parts (Valve CC BY-NC-SA geometry, cleanly separated +
    // poly-reduced) via tools/build-steam-controller-glb.mjs. Each glTF node
    // is named by its source part filename (top_shell, left_trigger,
    // south_button, …). See STEAM_CONTROLLER_ATTRIBUTION.md.
    model: 'assets/controllers/steam-controller-split.glb',
    name: 'Steam Controller (2026)',
    // Standard Gamepad-API button index → part node name.
    buttonMap: {
      0:  'south_button',    // A
      1:  'east_button',     // B
      2:  'west_button',     // X
      3:  'north_button',    // Y
      4:  'left_shoulder',   // LB
      5:  'right_shoulder',  // RB
      8:  'back_button',     // View
      9:  'start_button',    // Menu
      10: 'left_stick_cap',  // L3 — stick click (also tilts with the stick group)
      11: 'right_stick_cap', // R3
      12: 'dpad_up',
      13: 'dpad_down',
      14: 'dpad_left',
      15: 'dpad_right',
      16: 'guide_button',    // Steam
      17: 'misc1',           // "…" quick-access button (central, between the trackpads)
      // Back paddles: no Standard-Gamepad index, so the overlay synthesizes
      // them at slots 18-21 from the driver's WebHID paddle bits (L4/L5/R4/R5).
      // Right = paddle1/3, left = paddle2/4 (verified from GLB X-centers);
      // upper/lower within a side (the 4-vs-5 split) is a best guess — swap the
      // two on a side if a press lights the wrong paddle.
      18: 'paddle2',  // L4 (left)
      19: 'paddle4',  // L5 (left)
      20: 'paddle1',  // R4 (right)
      21: 'paddle3',  // R5 (right)
    },
    triggerMap: {
      6: 'left_trigger',     // LT
      7: 'right_trigger',    // RT
    },
    // Each stick tilts as a group; the cap is also a buttonMap target
    // (L3/R3 click) so it gets both a tilt and a press — the visualizer
    // handles that dual role.
    stickMap: {
      left:  { meshes: ['left_stick_base', 'left_stick_ring', 'left_stick_cap'], axisX: 0, axisY: 1 },
      right: { meshes: ['right_stick_base', 'right_stick_ring', 'right_stick_cap'], axisX: 2, axisY: 3 },
    },
    // ceski's Steam parts have travel=0 (buttons highlight, don't sink), and
    // they're flush/thin — so a small dip + glow, not a deep press.
    pressDepth: 0.0005,
    triggerMaxAngle: 0.349,  // = info.txt trigger_max (~20°)
    stickMaxTilt: 0.436,     // = info.txt stick_max (~25°)
    hasGyro: true,
    // Axis remap is applied inside the driver (Y↔Z swap on gyro+accel —
    // see steam-controller-driver.js parseReport).
    gyroTransform: (gx, gy, gz) => [gx, gy, gz],
    hasTouchpad: true,
    // Two trackpads. Pad meshes: `touchpad` (mesh X-center < 0) = LEFT,
    // `misc2` (X-center > 0) = RIGHT — verified against left/right_shoulder
    // X-centers in the GLB. `touch_point1`/`touch_point2` are pre-modeled
    // indicator dots that sit at each pad's center; the visualizer moves them
    // to the finger position. `point` = driver touchPoints index (0 = left
    // pad @ STATE bytes 17/19, 1 = right pad @ 23/25).
    trackpads: [
      { pad: 'touchpad', indicator: 'touch_point1', point: 0 }, // LEFT
      { pad: 'misc2',    indicator: 'touch_point2', point: 1 }, // RIGHT
    ],
    // Raw samples are int16 LE centered at 0 (±32768). If the on-screen dot
    // moves mirrored or perpendicular to your finger, flip the matching flag:
    //   invertX → dot is left/right-mirrored;  invertY → up/down-mirrored;
    //   swapXY  → dot moves perpendicular to the finger.
    trackpadRange: 32768,
    trackpadInvertX: false,
    trackpadInvertY: true,
    trackpadSwapXY: false,
    // gyro rotates the whole model (bodyGroup); bodyMeshes is informational.
    bodyMeshes: ['top_shell', 'bottom_shell', 'misc1', 'left_gripsense', 'right_gripsense'],
    // "Pop-off" parts: triggers, bumpers, and the four back paddles float clear
    // of the body (toggle in settings). Auto-positioned radially; tune spread
    // via floatFactor / floatLateralBias, and per part via floatTuning.
    floatParts: [
      'left_trigger', 'right_trigger', 'left_shoulder', 'right_shoulder',
      'paddle1', 'paddle2', 'paddle3', 'paddle4',
    ],
    // Paddles sit edge-on at rest; turn their flat face to the camera when
    // popped so a press/highlight is obvious.
    floatFaceCamera: ['paddle1', 'paddle2', 'paddle3', 'paddle4'],
    floatFactor: 0.38,         // radial spread (tighter float, issue #61)
    floatLateralBias: 1.1,     // less sideways push than the 1.6 default
    // Per-part pop-off tuning. Triggers/bumpers flip UP to the top and extend
    // out the back (tighter than before). The four back paddles pop DOWN under
    // the body (negative `up`) instead of fanning out to the sides — they're in
    // floatFaceCamera, so they keep turning their flat face to the viewer.
    // Knobs are in model-radius units:
    //   back   — extend out the back, along the edge the parts sit on (−Z)
    //   up     — toward the top (+Y); negative = down, under the body
    //   side   — push out to its own side (±X)
    //   tiltUp — rotate the part about its own center toward the top (degrees)
    floatTuning: {
      left_shoulder:  { back: 0.08, up: 0.12, tiltUp: 65 },
      right_shoulder: { back: 0.08, up: 0.12, tiltUp: 65 },
      // Triggers sit ABOVE/behind the bumpers when popped. #61's tighter spread
      // packed them right on top of the bumpers (issue #75 — they overlapped),
      // so push the triggers further off the back surface to reopen the gap.
      left_trigger:   { back: 0.34, up: 0.36, tiltUp: 65 },
      right_trigger:  { back: 0.34, up: 0.36, tiltUp: 65 },
      // Paddles pop toward the CENTER (X) and along −Z, with a little drop, so
      // from the top view they sit between the handle ends toward the bottom of
      // the view and stay visible. Knobs (model-radius units):
      //   up<0   = down (−Y)
      //   back>0 = −Z, back<0 = +Z (toward camera). `offset.z = −radius·back`.
      //   side<0 = inward toward center (X)
      // #61 dropped them too far under the body (issue #75 — half hidden below);
      // raise them and pull them further toward the camera so they clear the
      // body's bottom edge instead of hiding behind it.
      paddle1: { up: -0.06, back: -0.58, side: -0.13 },
      paddle2: { up: -0.06, back: -0.58, side: -0.13 },
      paddle3: { up: -0.06, back: -0.58, side: -0.13 },
      paddle4: { up: -0.06, back: -0.58, side: -0.13 },
    },
    // Hand-tuned pop-off placement for the triggers + bumpers (issue #75),
    // captured from the Edit-Layout editor. This is the same shape the editor
    // persists to localStorage and overrides floatTuning's computed offset for
    // these parts: `offset` is the part's parent-local translation (model-radius
    // units, already scale-divided) and `euler` is its rotation in DEGREES. The
    // overlay applies this as the baseline; a user's own Edit-Layout tweaks
    // (saved to localStorage) still take precedence. Parts not listed here keep
    // their floatTuning offset.
    defaultLayout: {
      // Triggers nudged closer to the bumpers — the popped trigger↔bumper white
      // space (min surface gap ≈ 0.0044) is halved by moving each trigger ~0.002
      // toward its bumper along the gap (mostly +Z/forward, slight −Y). Leaves
      // half the gap so they still don't overlap (cf. #75). Was:
      //   left_trigger  [0.002, 0.0295, -0.0287], right_trigger [-0.0007, 0.0295, -0.0294]
      left_trigger:   { offset: [0.002, 0.029, -0.0266],   euler: [65, 0, 0] },
      right_trigger:  { offset: [-0.0008, 0.029, -0.0272], euler: [65, 0, 0] },
      left_shoulder:  { offset: [0.0007, 0.0098, -0.0024],  euler: [65, 0, 0] },
      right_shoulder: { offset: [-0.0006, 0.0098, -0.003],  euler: [65, 0, 0] },
    },
    // Capacitive grip sensors (digital): glow these meshes while the grip is
    // held (driver parsed.grips). Highlighted via overlay.setGripState.
    gripMeshes: { left: 'left_gripsense', right: 'right_gripsense' },
    // The grip-sense bar meshes are modeled low on the back of the controller,
    // where they're hidden under the body. Move them out beyond the left/right
    // silhouette so the bars and their grip glow are visible. gripBarSideGap is
    // the gap past the side edge, in model widths.
    gripBarsToSides: true,
    gripBarSideGap: 0.02,
    // Lift the glow up a little into the handle body (fraction toward the top).
    gripMarkerHeight: 0.1,
    // Nudge each glow outward into the handle (away from the body center), as a
    // fraction of the model width. Pushed farther out (was 0.06) so the glows
    // sit over the controller handles where the hands grip, instead of bunched
    // near the center (PR #76 feedback).
    gripMarkerSideOffset: 0.14,
    // Yaw each glow about the vertical axis (degrees) so its front (bumper/
    // trigger) end angles toward the controller's centerline — best seen in the
    // Top view. Sign is applied per side in code (left/right mirror).
    gripMarkerYaw: 18,
    // Two-tone (ceski/Larf SC2 look, issue #61): light body = shells only.
    // The grip-sense bars (left/right_gripsense) are deliberately NOT in a
    // theme group — they're driven on their own (a rest grey that lights to the
    // grip color while that side is gripped) so they read as the grip-sense
    // indicator instead of disappearing into the body color (PR #76, #74).
    // Everything else is dark accent — the trackpads, the system buttons
    // (view/menu/steam + the "…" quick-access), and the controls (sticks, face
    // buttons, dpad, shoulders, triggers, paddles).
    bodyColorMeshes: [
      'top_shell', 'bottom_shell',
    ],
    accentColorMeshes: [
      'misc1', 'misc2', 'touchpad', 'touch_point1', 'touch_point2',
      'back_button', 'start_button', 'guide_button',
      'south_button', 'east_button', 'west_button', 'north_button',
      'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
      'left_stick_base', 'left_stick_ring', 'left_stick_cap',
      'right_stick_base', 'right_stick_ring', 'right_stick_cap',
      'left_shoulder', 'right_shoulder', 'left_trigger', 'right_trigger',
      'paddle1', 'paddle2', 'paddle3', 'paddle4',
    ],
    defaultBodyColor: '#e6e6e6',   // rgb(230,230,230)
    defaultAccentColor: '#555555', // rgb(85,85,85)
    themeOnLoad: true, // the bare GLB has no materials — theme it on load (#61)
    hudLabels: {
      0: 'A',  1: 'B',  2: 'X',  3: 'Y',
      4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
      8: 'Vw', 9: 'Mn', 16: 'St', 17: '…',
    },
  },
};

/**
 * Auto-detect controller type from Gamepad API id string.
 * @param {string} id — Gamepad.id
 * @returns {string} profile key ('dualsense', 'switch-pro', 'xbox')
 */
export function detectControllerType(id) {
  const lower = id.toLowerCase();
  if (lower.includes('dualsense') || lower.includes('054c')) return 'dualsense';
  if (lower.includes('pro controller') || lower.includes('057e')) return 'switch-pro';
  if (lower.includes('xbox') || lower.includes('045e') || lower.includes('xinput')) return 'xbox';
  return 'dualsense'; // default fallback
}
