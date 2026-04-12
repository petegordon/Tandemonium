module.exports = {
  packagerConfig: {
    name: '3D Controller Overlay',
    executableName: '3d-controller-overlay',
    asar: true,
    icon: './src/assets/icon',
    extraResource: [],
  },
  makers: [
    // ── Windows: Squirrel installer (Setup.exe + auto-update support) ──
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: '3DControllerOverlay',
        setupExe: '3D-Controller-Overlay-Setup.exe',
        setupIcon: './src/assets/icon.ico',
        iconUrl: 'https://raw.githubusercontent.com/petegordon/Tandemonium/main/controller-overlay/src/assets/icon.ico',
        description: '3D controller overlay for streamers',
      },
    },
    // ── Cross-platform: ZIP (portable — no install needed) ──
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    // ── macOS: DMG with drag-to-Applications layout ──
    // Requires `appdmg` (native module) — install separately or use the
    // scripts/make-dmg.sh helper which uses hdiutil directly.
    // Uncomment when appdmg builds on your system:
    // {
    //   name: '@electron-forge/maker-dmg',
    //   config: {
    //     format: 'ULFO',
    //     icon: './src/assets/icon.icns',
    //     contents: [
    //       { x: 130, y: 220, type: 'file', path: '' },
    //       { x: 410, y: 220, type: 'link', path: '/Applications' },
    //     ],
    //     window: { size: { width: 540, height: 380 } },
    //   },
    // },
  ],
  plugins: [],
};
