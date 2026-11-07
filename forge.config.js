const path = require('path');
const fs = require('fs');

module.exports = {
  packagerConfig: {
    // steamworks-ffi-node is pure JS + uses Koffi FFI; no native .node binary
    // to unpack from asar. Koffi itself does carry small .node bindings, so
    // we unpack koffi to ensure its loader can find them at runtime.
    asar: {
      unpack: '**/node_modules/koffi/**',
    },
    icon: path.join(__dirname, 'assets', 'icon'),
    extraResource: [
      path.join(__dirname, 'steam_appid.txt'),
      // Ship the Steamworks redistributable (steam_api64.dll) inside the
      // packaged app's resources/ folder. electron/main.js calls
      // steam.setSdkPath(path.join(process.resourcesPath, 'steamworks_sdk'))
      // when app.isPackaged so the FFI loader looks here.
      path.join(__dirname, 'steamworks_sdk'),
    ],
    name: 'Tandemonium',
    // macOS (#192). icon above resolves to assets/icon.icns there; CI makes it
    // from the 512 px Steam icon (scripts/make-icns.sh): iconutil is macOS-only.
    appBundleId: 'com.housetandem.tandemonium',
    appCategoryType: 'public.app-category.games',
    extendInfo: {
      NSCameraUsageDescription: 'Tandemonium uses your camera for the partner video in online rides and for ride clips.',
      NSMicrophoneUsageDescription: 'Tandemonium uses your microphone for voice in online rides and for ride clips.',
      NSCameraUseContinuityCameraDeviceType: true,
      NSBluetoothAlwaysUsageDescription: 'Tandemonium reads Bluetooth controllers for steering and gyro.',
      LSMinimumSystemVersion: '11.0',
    },
    // Dev-only pages and rendered output that must not ship (#505 fit viewer).
    ignore: [/^\/tools\/fit-viewer(\/|$)/, /^\/renders(\/|$)/],
  },
  // No Steam Input files ship: no controller_config/ in the depot. The game
  // runs in Steam's emulation mode on purpose — without an action manifest
  // Steam re-emits each captured controller as a virtual XInput pad, and the
  // player's layout (the official one routes the Steam Controller's gyro onto
  // the left stick) decides what it does. docs/steam-input.md has the model;
  // the layouts once shipped stay in steam/ as reference exports.
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],
};
