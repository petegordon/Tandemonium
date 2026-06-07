// ============================================================
// DEVICE DICTIONARY — single source of truth for known controllers
// ============================================================
//
// Each entry maps a physical controller (vendorId + productId) to a
// protocol implementation (one of the driver classes in ./drivers/*)
// plus per-device metadata: display name, capability flags, hardware
// feature inventory, the Gamepad-API id pattern that identifies it,
// and optional behavior quirks. Adding a controller that speaks an
// existing protocol is one entry; new protocols need a driver class
// too.
//
// Multiple entries may share the same vid:pid when a clone "spoofs"
// another's USB identity (e.g. GameSir Super Nova in DS4 mode reports
// Sony's `054c:09cc`). Such entries set `spoofs: { of, vendorId,
// productId }` so consumers (and the Test Report wizard's picker UI)
// can present the user with a choice instead of guessing wrong.
//
// Entry shape:
// {
//   name:             string  — display name shown in UI / logs
//   vendorId:         number  — USB vendor ID as enumerated
//   productId:        number  — USB product ID as enumerated
//   protocol:         string  — key in PROTOCOLS map
//   mode?:            string  — protocol sub-mode hint (e.g. 'ds4' | 'ds5')
//   imuSignature?:    string  — IMU layout family used by the driver's
//                               runtime IMU probe to disambiguate clones
//                               that share a vid:pid. PlayStation values:
//                               'sony-ds5' (IMU at byte 15) and the DS4
//                               layout at byte 12 ('gamesir-ds4'). NOTE: a
//                               real Sony DS4 also measures byte 12 (capture-
//                               confirmed), so 'sony-ds4' (byte 13) is a
//                               retained-but-unconfirmed label no known
//                               hardware actually uses.
//   capabilities:     { gyro, accel, touchpad } — WebHID features
//   features:         { faceButtons, systemButtons, triggers, shoulders,
//                       sticks, dpad, gyro, accel, touchpad, backPaddles,
//                       lightbar, rumble } — hardware inventory; drives
//                       the Test Report wizard's step list (a controller
//                       with `touchpad: false` skips the touchpad step)
//   gamepadIdPattern: RegExp  — primary Gamepad-API id matcher
//   gamepadIdMatch?:  RegExp  — secondary filter to disambiguate variants
//                               that share a vid:pid via the gamepad.id
//                               string (vs runtime user picker)
//   quirks?:          object  — flags consumers apply at runtime
//                               (e.g. { swapAB: true })
//   spoofs?:          { of, vendorId, productId } — present when this
//                               entry is a clone advertising another
//                               device's USB identity. `of` is the
//                               human-readable name of the spoofed device.
//   controllerProfile?: string — visualizer profile key (a key in the
//                               visualizer's PROFILES map). Defaults to
//                               `protocol` when missing — so Sony DS4/DS5
//                               entries get the existing `dualsense.glb`
//                               model for free. Set explicitly to point
//                               a clone at its own GLB asset, e.g.
//                               `controllerProfile: 'gamesir-super-nova'`
//                               once that model + PROFILES entry exists.
//   notes?:           string  — free-text shown in pickers/docs
// }
// ============================================================

import { PlayStationDriver } from './drivers/playstation-driver.js';
import { SwitchProDriver } from './drivers/switch-pro-driver.js';
import { XboxDriver } from './drivers/xbox-driver.js';
import { SteamControllerDriver } from './drivers/steam-controller-driver.js';

// Protocol id → driver class. The 'dualsense' key historically named
// just the DS5 protocol; it now covers PlayStation's DS4 + DS5 layouts
// (the class was renamed to PlayStationDriver to reflect that, but the
// key is preserved so the visualizer's PROFILES['dualsense'] GLB
// continues to load for all Sony entries without needing a per-entry
// controllerProfile override).
export const PROTOCOLS = {
  'dualsense':        PlayStationDriver,
  'switch-pro':       SwitchProDriver,
  'xbox':             XboxDriver,
  'steam-controller': SteamControllerDriver,
};

// ── Shared regex patterns (referenced by multiple entries) ──
const PLAYSTATION_ID = /playstation|dualsense|dualshock|054c/i;
const SWITCH_PRO_ID  = /pro controller|057e.*2009|nintendo/i;
const XBOX_ID        = /xbox|microsoft|045e/i;
const GAMESIR_ID     = /gamesir|super nova|cyclone|3537/i;
const STEAM_ID       = /steam controller|valve|28de/i;

const PS_CAPS     = { gyro: true,  accel: true,  touchpad: true  };
const SWITCH_CAPS = { gyro: true,  accel: true,  touchpad: false };
const NO_CAPS     = { gyro: false, accel: false, touchpad: false };

// ── Feature inventory presets ──
// Used by the Test Report wizard to decide which steps to prompt for.
// A `false` flag tells the wizard to skip that step entirely instead of
// asking the user to press a button they don't have.
const PS_FEATURES = {
  faceButtons: true, systemButtons: true, triggers: 'analog', shoulders: true,
  sticks: 2, dpad: true, gyro: true, accel: true, touchpad: true,
  backPaddles: false, lightbar: true, rumble: true,
};
const PS_EDGE_FEATURES = { ...PS_FEATURES, backPaddles: true };
const SWITCH_FEATURES = {
  faceButtons: true, systemButtons: true, triggers: 'analog', shoulders: true,
  sticks: 2, dpad: true, gyro: true, accel: true, touchpad: false,
  backPaddles: false, lightbar: false, rumble: true,
};
const XBOX_FEATURES = {
  faceButtons: true, systemButtons: true, triggers: 'analog', shoulders: true,
  sticks: 2, dpad: true, gyro: false, accel: false, touchpad: false,
  backPaddles: false, lightbar: false, rumble: true,
};
const GAMESIR_DS4_FEATURES = {
  faceButtons: true, systemButtons: true, triggers: 'analog', shoulders: true,
  sticks: 2, dpad: true, gyro: true, accel: true, touchpad: true,
  backPaddles: true, lightbar: false, rumble: true,
};

export const DEVICES = [
  // ── Sony DualSense (PS5) ──
  // imuSignature: 'sony-ds5' — IMU at byte 15 (DualSense layout)
  { name: 'Sony DualSense',         vendorId: 0x054c, productId: 0x0ce6, protocol: 'dualsense', mode: 'ds5', imuSignature: 'sony-ds5', capabilities: PS_CAPS, features: PS_FEATURES, gamepadIdPattern: PLAYSTATION_ID },
  { name: 'Sony DualSense Edge',    vendorId: 0x054c, productId: 0x0df2, protocol: 'dualsense', mode: 'ds5', imuSignature: 'sony-ds5', capabilities: PS_CAPS, features: PS_EDGE_FEATURES, gamepadIdPattern: PLAYSTATION_ID },

  // ── Sony DualShock 4 (PS4) ──
  // Same protocol class as DualSense; mode='ds4' selects the DS4 input-report
  // layout. A Bluetooth capture of a real DS4 v1 (test/fixtures/
  // sony-dualshock4-v1-bt_054c-05c4.json) confirmed its IMU sits at byte 12
  // (USB) / 14 (BT) — the SAME layout as the GameSir clones, not the byte-13
  // layout once assumed. PlayStationDriver.init defers to the documented
  // default offset, overriding only when it scores implausibly. imuSignature
  // 'sony-ds4' is retained but cannot distinguish a real DS4 from a GameSir at
  // the same vid:pid (identical IMU layout).
  { name: 'Sony DualShock 4 v1',    vendorId: 0x054c, productId: 0x05c4, protocol: 'dualsense', mode: 'ds4', imuSignature: 'sony-ds4', capabilities: PS_CAPS, features: PS_FEATURES, gamepadIdPattern: PLAYSTATION_ID },
  { name: 'Sony DualShock 4 v2',    vendorId: 0x054c, productId: 0x09cc, protocol: 'dualsense', mode: 'ds4', imuSignature: 'sony-ds4', capabilities: PS_CAPS, features: PS_FEATURES, gamepadIdPattern: PLAYSTATION_ID },

  // ── GameSir DS4-mode family ──
  // Both Super Nova and Cyclone 2 spoof Sony's DS4 v2 USB identity
  // (054c:09cc) and share the GameSir DS4-clone input-report layout
  // (IMU at byte 12, validated via Test Report wizard captures of both
  // pads). imuSignature: 'gamesir-ds4' lets the IMU probe identify
  // them as a family at runtime and pick a GameSir entry over the Sony
  // DS4 v2 entry without user input.
  //
  // Difference between the two GameSir pads: Super Nova's back paddles
  // expose independent HID bits we could map; Cyclone 2's back paddles
  // remap to the A/B face buttons on the controller side, so they
  // generate no new HID data and `backPaddles: false` for Cyclone 2.
  // The IMU probe can't tell Super Nova and Cyclone 2 apart (both at
  // offset 12) — the spoof-picker UI handles that final disambiguation.
  {
    name: 'GameSir Super Nova (DS4 mode)',
    vendorId: 0x054c, productId: 0x09cc,
    protocol: 'dualsense', mode: 'ds4', imuSignature: 'gamesir-ds4',
    capabilities: PS_CAPS,
    features: GAMESIR_DS4_FEATURES,
    gamepadIdPattern: PLAYSTATION_ID,
    spoofs: { of: 'Sony DualShock 4 v2', vendorId: 0x054c, productId: 0x09cc },
    // Photogrammetry-sourced GLB; monolithic mesh so gyro rotation works
    // but per-button animation doesn't. See packages/visualizer/src/
    // controller-profiles.js → 'gamesir-super-nova' for the limitations.
    controllerProfile: 'gamesir-super-nova',
    notes: 'GameSir clone reporting Sony 054c:09cc. IMU layout matches Sony DS4 (offsets 12/18); has independent back paddles.',
  },
  {
    name: 'GameSir Cyclone 2 (DS4 mode)',
    vendorId: 0x054c, productId: 0x09cc,
    protocol: 'dualsense', mode: 'ds4', imuSignature: 'gamesir-ds4',
    capabilities: PS_CAPS,
    features: { ...GAMESIR_DS4_FEATURES, backPaddles: false },
    gamepadIdPattern: PLAYSTATION_ID,
    spoofs: { of: 'Sony DualShock 4 v2', vendorId: 0x054c, productId: 0x09cc },
    notes: 'GameSir clone reporting Sony 054c:09cc. IMU layout matches Sony DS4 (offsets 12/18). Has physical back paddles BUT they rebind to A/B at the firmware level — no independent HID bits, so the wizard skips the back-paddles step.',
  },

  // ── Nintendo Switch Pro ──
  { name: 'Nintendo Switch Pro',    vendorId: 0x057e, productId: 0x2009, protocol: 'switch-pro', capabilities: SWITCH_CAPS, features: SWITCH_FEATURES, gamepadIdPattern: SWITCH_PRO_ID },

  // ── GameSir Cyclone (Switch mode) ──
  // Same vid:pid as Switch Pro but reports gamepad.id as "Gamepad" rather
  // than "Pro Controller" — the secondary filter catches that. Uses
  // Nintendo A/B button order, hence the swapAB quirk.
  {
    name: 'GameSir Cyclone (Switch mode)',
    vendorId: 0x057e, productId: 0x2009,
    protocol: 'switch-pro',
    capabilities: SWITCH_CAPS,
    features: { ...SWITCH_FEATURES, backPaddles: true },
    gamepadIdPattern: SWITCH_PRO_ID,
    gamepadIdMatch: /^Gamepad/i,
    spoofs: { of: 'Nintendo Switch Pro', vendorId: 0x057e, productId: 0x2009 },
    quirks: { swapAB: true },
    notes: 'GameSir clone reporting Nintendo 057e:2009 with Nintendo-style A/B order.',
  },

  // ── Xbox family (identity-only — Gamepad API handles input) ──
  { name: 'Xbox Wireless (BT)',     vendorId: 0x045e, productId: 0x0b12, protocol: 'xbox', capabilities: NO_CAPS, features: XBOX_FEATURES, gamepadIdPattern: XBOX_ID },
  { name: 'Xbox Series X|S',        vendorId: 0x045e, productId: 0x0b13, protocol: 'xbox', capabilities: NO_CAPS, features: XBOX_FEATURES, gamepadIdPattern: XBOX_ID },
  { name: 'Xbox Elite v2',          vendorId: 0x045e, productId: 0x02fd, protocol: 'xbox', capabilities: NO_CAPS, features: { ...XBOX_FEATURES, backPaddles: true }, gamepadIdPattern: XBOX_ID },
  { name: 'Xbox One',               vendorId: 0x045e, productId: 0x02e0, protocol: 'xbox', capabilities: NO_CAPS, features: XBOX_FEATURES, gamepadIdPattern: XBOX_ID },
  { name: 'Xbox 360',               vendorId: 0x045e, productId: 0x028e, protocol: 'xbox', capabilities: NO_CAPS, features: XBOX_FEATURES, gamepadIdPattern: XBOX_ID },

  // ── Steam Controller (2026) — two USB identities for one physical pad ──
  //
  // The 2026 Steam Controller exposes two completely different USB
  // identities depending on how the controller body is connected:
  //
  //   0x1302 — controller body plugged directly via USB-C cable.
  //            Single HID interface. Streams Steam Input HID format
  //            immediately at ~249 Hz on connect — no mode switch
  //            needed. THIS IS THE EASY PATH.
  //
  //   0x1304 — wireless Puck dongle plugged into USB; controller body
  //            pairs to it over RF. Five HID interfaces, all
  //            vendor-defined (no standard gamepad usage page). Puck
  //            defaults to keyboard+mouse fallback mode — iface[3] is
  //            silent until a CLEAR_DIGITAL_MAPPINGS feature report is
  //            sent + repeated every 800ms (the "lizard mode disable"
  //            handshake documented in ddeverill/SteamlessController and
  //            libsdl-org/SDL's hidapi_steam.c).
  //
  // Both entries point at the same protocol + visualizer profile; the
  // driver branches on this.device.productId for the Puck-specific init.
  //
  // The Gamepad API never enumerates either of these (vendor-defined HID
  // in both cases). The overlay's HID pool path is what brings them in:
  // the registry's HID filter list includes them (capabilities are no
  // longer NO_CAPS so getHIDFilters returns them), they're paired via
  // navigator.hid.requestDevice on first connect, the manager pools each
  // approved device, the driver's parseReport runs on each inputreport.
  // For the Puck, only one of its five interfaces will receive feature
  // reports successfully; the rest silently no-op (4× ~no-overhead pool
  // entries that emit no inputreports either).
  //
  // See issue #8 for the full investigation: capture timeline, 53-byte
  // STATE-report layout, prior art survey, the lizard-mode bytes, and
  // the 0x42-vs-0x45 reportId discrepancy that's resolved at runtime by
  // the driver (it accepts whichever id the firmware actually emits).
  {
    name: 'Steam Controller 2026 (direct USB-C)',
    vendorId: 0x28de, productId: 0x1302,
    protocol: 'steam-controller',
    capabilities: PS_CAPS,
    features: { faceButtons: true, systemButtons: true, triggers: 'analog', shoulders: true, sticks: 2, dpad: true, gyro: true, accel: true, touchpad: true, backPaddles: true, lightbar: false, rumble: true },
    gamepadIdPattern: STEAM_ID,
    controllerProfile: 'steam-controller',
    notes: 'Controller body plugged in directly over USB-C. One HID interface; Steam Input HID format flows on connect, no mode switch needed. Visualizer GLB is CC BY-NC-SA 4.0; see packages/visualizer/assets/controllers/STEAM_CONTROLLER_ATTRIBUTION.md.',
  },
  {
    name: 'Steam Controller 2026 (via Puck)',
    vendorId: 0x28de, productId: 0x1304,
    protocol: 'steam-controller',
    capabilities: PS_CAPS,
    features: { faceButtons: true, systemButtons: true, triggers: 'analog', shoulders: true, sticks: 2, dpad: true, gyro: true, accel: true, touchpad: true, backPaddles: true, lightbar: false, rumble: true },
    gamepadIdPattern: STEAM_ID,
    controllerProfile: 'steam-controller',
    notes: 'Wireless Puck dongle. Driver sends CLEAR_DIGITAL_MAPPINGS feature report on init + every 800ms to keep the controller out of keyboard/mouse fallback. Only one of the Puck\'s 5 HID interfaces (iface[3]) emits 53-byte STATE reports.',
  },
];

// ── Pending entries — known controllers, pid not yet captured ──
//
// Documented here so the intent is visible; NOT registered in DEVICES yet.
// Move an entry up into DEVICES once a Test Report capture confirms the
// vid:pid and we know which protocol/mode to dispatch.

export const PENDING_DEVICES = [
  // (none currently — Steam Controller 2026 was promoted to DEVICES
  // on 2026-05-24 after the Puck's vid:pid 28de:1304 was captured)
];
