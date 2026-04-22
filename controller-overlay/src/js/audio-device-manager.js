// ============================================================
// AUDIO DEVICE MANAGER
// ============================================================
//
// Locates the DualSense's audio endpoints on the OS audio stack. Over
// Bluetooth, the controller pairs twice: once as HID (buttons/IMU/LEDs),
// and once as an audio device exposing an A2DP sink (speaker) plus an
// HFP gateway (microphone). These appear through MediaDevices just like
// any USB/BT headset.
//
// Over wired USB, the DualSense presents a USB Audio Class interface with
// a different label ("Wireless Controller" on macOS, often truncated on
// Windows). We match on a set of label fragments rather than a single
// exact string because vendors + OSes disagree on the human-readable name.
//
// Device labels are empty until the site has been granted microphone
// permission at least once — Chromium hides them otherwise to prevent
// fingerprinting. We call getUserMedia({audio:true}) once at init time,
// stop the returned tracks immediately, and then enumerate. The prompt
// is auto-granted in Electron (see electron/main.js setPermissionRequestHandler).

const DUALSENSE_LABEL_FRAGMENTS = [
  'wireless controller',       // macOS, most Linux
  'dualsense',                  // rare, some drivers
  'dualsense wireless',         // some Windows BT stacks
  'sony interactive',           // Sony-branded BT audio
  'ps5 controller',             // alternate OS naming
];

function normalize(s) {
  return (s || '').toLowerCase();
}

function matchesDualSense(label) {
  const n = normalize(label);
  if (!n) return false;
  return DUALSENSE_LABEL_FRAGMENTS.some((frag) => n.includes(frag));
}

export class AudioDeviceManager extends EventTarget {
  constructor() {
    super();
    this._input = null;         // MediaDeviceInfo (audioinput)
    this._output = null;        // MediaDeviceInfo (audiooutput)
    this._rescanTimer = null;
    this._permissionGranted = false;
    this._devicechange = this._devicechange.bind(this);
  }

  /**
   * One-time mic permission grant + initial scan. Safe to call multiple
   * times — subsequent calls short-circuit on the cached permission.
   */
  async init() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      console.warn('AudioDeviceManager: mediaDevices API unavailable');
      return;
    }

    if (!this._permissionGranted) {
      try {
        // Opens a dummy stream only to unlock device labels in Chromium.
        // We stop tracks immediately; the real capture happens in
        // DualSenseMic via its own getUserMedia with a specific deviceId.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        this._permissionGranted = true;
      } catch (err) {
        console.warn('AudioDeviceManager: mic permission denied:', err.message);
        // Enumeration still works but labels will be empty — match will fail.
      }
    }

    navigator.mediaDevices.addEventListener('devicechange', this._devicechange);
    await this.rescan();
  }

  dispose() {
    navigator.mediaDevices?.removeEventListener?.('devicechange', this._devicechange);
    if (this._rescanTimer) {
      clearTimeout(this._rescanTimer);
      this._rescanTimer = null;
    }
  }

  get input()  { return this._input; }
  get output() { return this._output; }
  get hasInput()  { return !!this._input; }
  get hasOutput() { return !!this._output; }

  /**
   * Debounced rescan. The BT audio endpoint often appears a few hundred
   * milliseconds (sometimes seconds) after the HID device — a single scan
   * at connect-time races the OS. Callers can fire-and-forget.
   */
  scheduleRescan(delayMs = 500) {
    if (this._rescanTimer) clearTimeout(this._rescanTimer);
    this._rescanTimer = setTimeout(() => {
      this._rescanTimer = null;
      this.rescan().catch((err) =>
        console.warn('AudioDeviceManager: rescan failed:', err.message));
    }, delayMs);
  }

  async rescan() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const prevIn = this._input?.deviceId;
    const prevOut = this._output?.deviceId;

    const inputs  = devices.filter((d) => d.kind === 'audioinput'  && matchesDualSense(d.label));
    const outputs = devices.filter((d) => d.kind === 'audiooutput' && matchesDualSense(d.label));

    // Prefer a concrete hardware deviceId over Chromium's 'default' /
    // 'communications' aliases. The aliases route to whatever the current
    // system default is — binding to them means Play Tone lands on the OS
    // default output instead of the DualSense hardware sink specifically.
    const isConcrete = (d) => d.deviceId !== 'default' && d.deviceId !== 'communications';
    this._input  = inputs.find(isConcrete)  || inputs[0]  || null;
    this._output = outputs.find(isConcrete) || outputs[0] || null;

    if (this._input?.deviceId !== prevIn || this._output?.deviceId !== prevOut) {
      this.dispatchEvent(new CustomEvent('change', {
        detail: { input: this._input, output: this._output },
      }));
    }
  }

  _devicechange() {
    // OS fires devicechange a few ms before labels settle; debounce.
    this.scheduleRescan(200);
  }

  /**
   * Debug helper — returns all enumerated audio devices so the settings
   * panel can surface them if auto-matching fails.
   */
  async listAllAudioDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput');
  }
}
