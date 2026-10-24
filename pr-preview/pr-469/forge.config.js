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
  },
  hooks: {
    // After packaging, drop the Steam Input files next to the exe under
    // controller_config/. Steam reads from <gameInstallDir>/controller_config/
    // at launch:
    //   - game_actions_<appid>.vdf : Action manifest (schema). Both app IDs
    //     ship so playtest (4510250) and release (4482940) both work.
    //   - controller_<type>.vdf    : Default bindings (per controller type)
    //     that map physical inputs to the actions declared in the IGA.
    //     Without these, Steam falls back to controller_base/empty.vdf and
    //     action handles never resolve. See docs/steam-input.md.
    postPackage: async (_forgeConfig, packageResult) => {
      const filesToShip = [
        // IGAs are deliberately NOT shipped here. Their presence in the
        // depot's controller_config/ dir flags our app as "Steam Input SDK
        // exclusive" at the Steam runtime layer, which suppresses Steam's
        // virtual XInput device emission to Electron. With no IGA, Steam
        // happily emits a normal virtual XInput pad that navigator.getGamepads()
        // can see, and the existing Gamepad-API steering path Just Works —
        // including gyro, when the binding configures Roll → Left Stick X.
        // See memory: dualsense-steam-input-working-recipe.
        //
        // Source IGAs are kept in steam/ for future use — custom actions
        // may be needed if Steam Controller v2 ships features that can't be
        // bound via stock template (advanced haptics, capacitive grip, etc.).
        // 'game_actions_4510250.vdf',  // intentionally not shipped
        // 'game_actions_4482940.vdf',  // intentionally not shipped

        // Big-Picture-authored bindings (NOT hand-edited — Steam rejects
        // hand-edited configs). Exported 2026-05-18 from a working setup with
        // gyro→Joystick Deflection→Left Stick X. New players who connect a
        // PS5 controller or a Steam Deck/v2-family controller will get our
        // gyro tilt-steering by default; they can still customize via Big
        // Picture per-user.
        'controller_ps5.vdf',       // DualSense
        'controller_neptune.vdf',   // Steam Deck / Steam Controller v2 family
      ];
      for (const outputPath of (packageResult.outputPaths || [])) {
        const cfgDir = path.join(outputPath, 'controller_config');
        fs.mkdirSync(cfgDir, { recursive: true });
        for (const vdf of filesToShip) {
          const src = path.join(__dirname, 'steam', vdf);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(cfgDir, vdf));
        }
      }
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],
};
