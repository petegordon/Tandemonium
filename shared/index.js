// ============================================================
// @usersfirst/controller-core — barrel exports
// ============================================================
//
// Convenience re-exports. Deep imports (subpath exports) are also supported:
//   import { ControllerManager } from '@usersfirst/controller-core/manager';
//   import { ControllerRegistry } from '@usersfirst/controller-core/drivers/controller-registry';
//
// See package.json `exports` for the full subpath map.

export {
  ControllerManager,
  Slot,
  MAX_CONTROLLERS,
  playerSlotIds,
  isPresentableEntry,
  gamepadHasActivity,
  gamepadHasFreshActivity,
  stableIdFor,
  makeSyntheticGamepad,
  resetSynthetic,
  applyParsedToSynthetic,
} from './manager.js';

export {
  SensorFusion,
  FUSION_CALIB_COUNT,
  FUSION_CALIB_COUNT_BT,
} from './sensor-fusion.js';

export { ControllerDriver } from './drivers/base-driver.js';
export { ControllerRegistry } from './drivers/controller-registry.js';
export { PlayStationDriver } from './drivers/playstation-driver.js';
export { SwitchProDriver } from './drivers/switch-pro-driver.js';
export { XboxDriver } from './drivers/xbox-driver.js';
export { SteamControllerDriver } from './drivers/steam-controller-driver.js';

export { DEVICES, PENDING_DEVICES, PROTOCOLS } from './devices.js';

export { analyzeImuStep } from './imu-analysis.js';

export {
  ControllerInventory,
  normalizeDescriptor,
  identityKey,
  capabilitiesFor,
  macOui,
  formatSerial,
  isMacSerial,
} from './controller-inventory.js';
