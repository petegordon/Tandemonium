// ============================================================
// @usersfirst/controller-visualizer — barrel exports
// ============================================================
//
// Peer dependency: `three` (the host app must provide it). The renderer
// imports `three` and `three/addons/...` via bare specifiers, so the host
// either runs a bundler that resolves them or sets up an import map (see
// apps/overlay for the importmap-based pattern used in plain Electron).

export { ControllerOverlay } from './controller-overlay.js';
export { GyroGimbal } from './gyro-gimbal.js';
export { PROFILES, detectControllerType } from './controller-profiles.js';
