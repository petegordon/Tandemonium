# DualSense microphone + speaker in the controller overlay

Implements GitHub issue #269. Lets the overlay capture from the DualSense's
built-in microphone and play sound through its internal speaker, including
when the controller is connected over Bluetooth.

## Architecture

Three renderer-side modules plus an extension to the shared DualSense
driver:

| Module | File | Responsibility |
| --- | --- | --- |
| `AudioDeviceManager` | `controller-overlay/src/js/audio-device-manager.js` | Enumerate audio devices, unlock labels via a one-time `getUserMedia`, match DualSense endpoints, debounce rescans |
| `DualSenseMic` | `controller-overlay/src/js/dualsense-mic.js` | Capture stream, AnalyserNode-based level meter, enable/disable, optional passthrough monitor |
| `DualSenseSpeaker` | `controller-overlay/src/js/dualsense-speaker.js` | `setSinkId()` routing, `playTone`, `playClip`, `routeStream`, volume |
| Driver audio bytes | `shared/controllers/dualsense-driver.js` | `setMicMuteLed`, `setMicHardwareMuted`, `setSpeakerVolume`, `setMicGain`, `setHeadphoneVolume` via output reports 0x02 / 0x31 |

Electron side: `controller-overlay/electron/main.js` was extended to
auto-grant `media` permission so the one-time label-unlock prompt never
blocks the user.

## Why audio doesn't go through HID over Bluetooth

Over USB the DualSense exposes a USB Audio Class interface for capture
and playback. Over Bluetooth, audio is carried by **two separate BT
profiles that the OS owns**:

- **A2DP sink** — speaker (stereo, downlink only)
- **HFP gateway** — microphone (mono, narrowband/wideband)

These are *not* tunneled through HID reports. HID handles buttons,
sticks, IMU, touchpad, and control bytes (mute LED, volume setpoints).
Audio streams travel the OS audio stack, which means we reach them
through `navigator.mediaDevices` and `HTMLAudioElement.setSinkId()`, not
through `device.sendReport()`.

HID output-report audio bytes (`setMicMuteLed`, `setSpeakerVolume`,
`setMicGain`) still work over both transports — they're *control*, not
*stream* — but under Bluetooth the A2DP volume / HFP gain is typically
what the user actually hears; the HID bytes are best-effort mirroring.

## Lifecycle

1. User connects DualSense (USB or BT).
2. `ControllerRegistry.connect()` resolves to `DualSenseDriver`.
3. On first run, `AudioDeviceManager.init()` calls a dummy
   `getUserMedia({audio:true})` to unlock labels, then enumerates.
4. `AudioDeviceManager` emits `change` with matched `input` / `output`
   `MediaDeviceInfo`s. Label matching is substring-based on
   `"wireless controller"`, `"dualsense"`, `"sony interactive"`, etc.
5. `DualSenseMic.open(input.deviceId)` starts capture. Level meter
   updates at ~20 Hz.
6. `DualSenseSpeaker.setSink(output.deviceId)` binds future playback.
7. Hardware mute-button edges toggle `mic.setEnabled()` + the hardware
   mute LED via `driver.setMicMuteLed()`.
8. On HID disconnect: close mic, clear speaker sink, reset mute state.
   Manager stays alive so the next connect is cheap.

The manager triggers multiple debounced rescans (0 ms, 800 ms, 2500 ms)
after HID connect because Bluetooth audio endpoints can appear anywhere
from a few hundred ms to a few seconds after the HID device.

## Test plan

### Connectivity matrix

| Case | Expected behavior |
| --- | --- |
| BT-only pair | HID + mic + speaker all discovered within ~3 s |
| USB-only | Same as BT (USB Audio Class endpoints label-match) |
| BT HID + USB audio | Both HID and the USB audio endpoint light up |
| No mic permission granted | Status shows "Mic: Not found", speaker works |
| DualSense not paired for audio in OS | Status shows "Mic: Not found", "Speaker: Not found" — test-speaker button triggers a rescan |
| Rapid plug / unplug | No stuck AudioContexts, no orphan MediaStreams (verify in `chrome://media-internals`) |

### Functional checks

1. **Mic level meter** moves when the user speaks into the controller.
2. **Hardware mute button** toggles:
   - MediaStreamTrack.enabled flips (remote listeners hear silence)
   - HW LED goes solid when muted, off when live
   - UI mic-dot turns amber (muted) / green (live)
3. **Mic passthrough** checkbox routes mic to the system default
   output and ramps without clicking.
4. **Test tone** button plays an 880 Hz / 250 ms tone through the
   DualSense speaker.
5. **Speaker volume slider** changes playback loudness and sends a
   `setSpeakerVolume` HID byte (effective wired; mostly ignored on BT).
6. **Rescan** button forces an immediate enumeration — useful if the
   user paired audio after the overlay launched.

### Regression checks

- Gyro / sticks / buttons continue to work while mic is live.
- BT DualSense in 0x31 full-report mode: synthetic gamepad still flows.
- Rumble + lightbar + player LEDs unaffected by audio output reports
  (verify by toggling lightbar color while test tone plays).
- Click-through mode still excludes the audio panel from mouse events.

### Manual verification in dev

```bash
cd controller-overlay
npm start
# Open DevTools (Cmd+Shift+I). In Console:
> audioDevices                  # should show MediaDevices info
> await audioDevices.listAllAudioDevices()
> dualsenseMic.isOpen           # true once discovery completes
> dualsenseSpeaker.ready        # true once discovery completes
> await dualsenseSpeaker.playTone(440, 300)
```

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `setSinkId` requires a secure context | Feature silently unavailable in non-Electron web deploys over HTTP | Electron satisfies this; documented for future web deploy |
| Windows downgrades A2DP → SCO when HFP opens | Speaker quality drops to narrowband while mic is live | Planned toggle: "suspend speaker while passthrough is on" — not yet implemented |
| BT audio endpoint lags HID by several seconds | First-connect UX shows "Not found" briefly | Debounced rescans at 0 ms / 800 ms / 2500 ms; manual Rescan button for edge cases |
| Audio device labels are empty without prior `getUserMedia` grant | Label-matching fails, features appear missing | `AudioDeviceManager.init()` performs a one-time dummy capture; Electron auto-grants the permission |
| Device-label strings vary by OS + BT stack | Match miss on uncommon setups | Substring match on a panel of fragments; extensible array in `audio-device-manager.js` |
| DualSense output-report byte offsets differ USB vs BT | Corrupt output report → controller ignores all audio control bytes | Driver branches on `connectionType`; BT path includes CRC |
| Multiple DualSense controllers | Second controller's audio may match the first's slot | Out of scope — overlay currently assumes one controller |
| OS-level mute behavior varies | User's expectation of "muted" may diverge from what downstream consumers hear | Mirror three states: HW LED, `MediaStreamTrack.enabled`, UI dot color |
| A2DP latency (~150–250 ms) | Unsuitable for music/game audio mixing | Use only for notifications in the overlay; documented |
| `OfflineAudioContext` + `setSinkId` round-trip | Small delay before first tone plays | Acceptable for a test-tone button; preload clips if ever used for UI sounds |

## Files touched

```
controller-overlay/electron/main.js                (media permission)
controller-overlay/src/index.html                   (audio panel + CSS)
controller-overlay/src/js/app.js                    (wiring)
controller-overlay/src/js/audio-device-manager.js   (new)
controller-overlay/src/js/dualsense-mic.js          (new)
controller-overlay/src/js/dualsense-speaker.js      (new)
shared/controllers/dualsense-driver.js              (audio output-report bytes)
```

## Future work (not in this PR)

- Echo / noise cancellation passthrough (`audio_control` bits 6–7).
- Mix remote peer audio (Tandemonium lobby) into the DualSense speaker.
- Persist chosen device IDs so reconnect doesn't wait for label match.
- Surface all enumerated audio devices as a manual override select.
- Suspend A2DP while HFP mic opens on Windows to avoid SCO downgrade.
