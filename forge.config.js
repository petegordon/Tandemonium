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
        // TEMP EXPERIMENT (issue #292): IGAs are temporarily NOT shipped to
        // test whether their presence in the depot is what flags us as
        // Steam-Input-API-aware (which suppresses virtual XInput emission).
        // Binding stays so Steam still has a default controller config.
        // Restore both IGA lines once we know the answer.
        // 'game_actions_4510250.vdf',
        // 'game_actions_4482940.vdf',
        'controller_ps5.vdf',
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
