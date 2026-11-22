const path = require('path');
const fs = require('fs');

// What the desktop package leaves out. The app serves its own folder as tandemonium://app
// (electron/main.js), so everything packaged is readable by the game page: only what the
// running game loads belongs in it. Each rule is matched against a path from the app
// folder, starting with "/". Left out:
//   - the API's source and migrations, the docs, the unit tests, and the build, smoke and
//     capture scripts: nothing in index.html, js/, shared/ or electron/ loads them
//   - local settings and secrets (.env files), CI and editor folders
//   - Steamworks exports and upload output, tools with their own entry point, old copies
//   - dev-only pages and rendered output (#505 fit viewer)
// The pages under test/ (Options > Dev tools opens test/index.html) do ship.
const PACKAGE_IGNORE = [
  /(^|\/)\.env[^/]*$/,
  /^\/\.(github|claude|wrangler|vscode)(\/|$)/,
  /^\/worker(\/|$)/,
  /^\/docs(\/|$)/,
  /^\/test\/unit(\/|$)/,
  /^\/scripts(\/|$)/,
  /^\/steam(\/|$)/,
  /^\/steam_output(\/|$)/,
  /^\/builds(\/|$)/,
  /^\/(tandy-agent|test_multiplayer|peerjs-server|backup-game|types)(\/|$)/,
  /^\/tools\/(fit-viewer|gamepad-test)(\/|$)/,
  /^\/renders(\/|$)/,
  /^\/[^/]+\.(md|docx)$/,
];

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
    // Universal merge: koffi ships both darwin_arm64 and darwin_x64 prebuilts and
    // the Steam dylib is already universal, so these files are the same in both
    // halves; let them through as-is.
    osxUniversal: { x64ArchFiles: '**/{koffi,steamworks_sdk}/**' },
    extendInfo: {
      NSBluetoothAlwaysUsageDescription: 'Tandemonium reads Bluetooth controllers for steering and gyro.',
      LSMinimumSystemVersion: '11.0',
    },
    ignore: PACKAGE_IGNORE,
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
