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
