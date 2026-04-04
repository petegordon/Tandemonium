# 3D Controller Overlay

A transparent, always-on-top Electron overlay that displays a real-time 3D controller model with button presses, trigger pulls, stick deflection, gyro orientation, and touchpad tracking. Designed for streamers and gyro gaming enthusiasts.

Built as part of [Tandemonium](https://github.com/petegordon/Tandemonium), a tandem bike physics game with gyro steering support.

## Features

- **3D visualization** — DualSense and Switch Pro controller models with per-button glow, trigger rotation, stick tilt
- **Gyro support** — real-time orientation via WebHID with background calibration and drift correction
- **Gyro HUD** — arc sweep indicator, lean direction arrows, calibration hints with color-coded feedback
- **Controller hot-swap** — unplug one controller, plug in another, model and gyro switch automatically
- **Gamepad-driven settings** — button combos to open settings, toggle gyro, recalibrate; D-pad navigation through all options
- **Transparent overlay** — click-through mode for use with OBS, Streamlabs, or alongside any game
- **Customizable** — body/accent colors, opacity, camera presets, HUD position, remappable button combos

## Supported Controllers

| Controller | Buttons/Sticks | Gyro | Touchpad |
|-----------|---------------|------|----------|
| DualSense (PS5) | Yes | Yes | Yes |
| Switch Pro | Yes | Yes | — |
| Xbox (detection only) | — | — | — |

Xbox controllers are detected by the Gamepad API but not currently supported in Chromium on macOS.

## Button Combos (customizable)

| Action | Default | Description |
|--------|---------|-------------|
| Open/Close Settings | Select + Start | Toggle the settings panel |
| Toggle Gyro | Select + R3 | Enable/disable gyro input |
| Recalibrate | L3 + R3 | Reset gyro bias and orientation |

All combos can be remapped in settings. Saved to localStorage.

## Getting Started

```bash
cd controller-overlay
npm install
npm start
```

### Build Installers

```bash
npm run make           # ZIP (macOS + Windows) + Squirrel installer (Windows)
npm run make:dmg       # Polished macOS DMG with Applications symlink
```

## How It Works

1. Connect a DualSense or Switch Pro controller via USB
2. Press any button to activate the Gamepad API
3. The overlay auto-detects the controller type and loads the 3D model
4. Gyro auto-connects via WebHID — the arc HUD appears showing lean angle
5. Use **Select + Start** to open settings, or right-click anywhere

### Gyro Connection Flow

The overlay uses WebHID for gyro/touchpad data (separate from the Gamepad API which handles buttons/sticks):

1. Gamepad detected → 2-second delay for HID enumeration
2. `getDevices()` checks previously-approved devices
3. Falls back to `requestDevice()` (auto-approved in Electron)
4. Switch Pro: driver sends IMU enable commands with retries
5. Background calibration starts — gyro works immediately

### Window Display

By default, the overlay shows only the 3D controller and gyro HUD — no title bar, no buttons. Right-click to open settings and toggle visibility of the title bar, gyro toggle, and gear icon.

## Credits

3D controller models (OBJ) sourced from [larfingshnew/3d-controller-overlay](https://github.com/larfingshnew/3d-controller-overlay) and converted to GLB format using the included conversion scripts.

## License

[MIT](LICENSE)
