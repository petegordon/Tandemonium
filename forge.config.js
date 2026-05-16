const path = require('path');
const fs = require('fs');

module.exports = {
  packagerConfig: {
    asar: {
      unpack: '**/node_modules/steamworks.js/**',
    },
    icon: path.join(__dirname, 'assets', 'icon'),
    extraResource: [
      path.join(__dirname, 'steam_appid.txt'),
    ],
    name: 'Tandemonium',
  },
  hooks: {
    // After packaging, drop the Steam Input action manifests next to the
    // exe under controller_config/. Steam Input reads the manifest from
    // <gameInstallDir>/controller_config/game_actions_<appid>.vdf at launch.
    // Shipping both VDFs covers playtest (4510250) and release (4482940).
    postPackage: async (_forgeConfig, packageResult) => {
      for (const outputPath of (packageResult.outputPaths || [])) {
        const cfgDir = path.join(outputPath, 'controller_config');
        fs.mkdirSync(cfgDir, { recursive: true });
        for (const vdf of ['game_actions_4510250.vdf', 'game_actions_4482940.vdf']) {
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
