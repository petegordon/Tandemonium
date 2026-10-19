// Injected before page scripts (evaluateOnNewDocument). Fakes the Gamepad API
// and WebHID so the UI audit can plug in 1-4 controllers of different types and
// press buttons on them. Driven from Puppeteer through window.__fake.
(() => {
  const GP_IDS = {
    xbox: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    dualsense: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
    switch: 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)',
    supernova: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
    generic: 'USB Gamepad (STANDARD GAMEPAD Vendor: 0079 Product: 0011)',
  };
  const BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15, home: 16 };

  const pads = []; // index -> state | null
  let ts = 0;
  const snapshot = (p, i) => p && ({
    id: p.id, index: i, connected: true, mapping: 'standard', timestamp: p.ts,
    axes: p.axes.slice(),
    buttons: p.buttons.map((v) => ({ pressed: v > 0.5, touched: v > 0, value: v })),
    vibrationActuator: { type: 'dual-rumble', playEffect: async () => 'complete', reset: async () => 'complete' },
    hapticActuators: [],
  });
  const getGamepads = () => {
    const out = [null, null, null, null];
    pads.forEach((p, i) => { out[i] = snapshot(p, i); });
    return out;
  };
  Object.defineProperty(Navigator.prototype, 'getGamepads', { value: getGamepads, configurable: true });

  // ── WebHID: Steam Controller via Puck (0x28de:0x1304), 53-byte STATE 0x45 ──
  // Button bits from shared/drivers/steam-controller-driver.js parseReport.
  const SC_BITS = {
    a: [1, 0x01], b: [1, 0x02], x: [1, 0x04], y: [1, 0x08], start: [1, 0x40], back: [2, 0x40],
    home: [3, 0x01], up: [2, 0x20], down: [2, 0x04], left: [2, 0x10], right: [2, 0x08],
    lb: [3, 0x08], rb: [2, 0x02],
  };
  const hidDevices = [];
  class FakeHid extends EventTarget {
    constructor(opts) {
      super();
      Object.assign(this, opts);
      this.opened = false;
      this.bytes = new Uint8Array(53);
      this.collections = [{ usagePage: 0xff00, usage: 0x0001, children: [], inputReports: [{ reportId: 0x45, items: [] }], outputReports: [], featureReports: [] }];
    }
    async open() { this.opened = true; this._start(); }
    async close() { this.opened = false; clearInterval(this._t); }
    async forget() {}
    async sendReport() {}
    async sendFeatureReport() {}
    async receiveFeatureReport() { return new DataView(new ArrayBuffer(64)); }
    _start() {
      clearInterval(this._t);
      this._t = setInterval(() => {
        if (!this.opened || !this.streams) return;
        const buf = new ArrayBuffer(53);
        const u8 = new Uint8Array(buf); u8.set(this.bytes);
        // accel z = +1g so fusion sees a resting pad
        u8[37] = 0x00; u8[38] = 0x40;
        const ev = new Event('inputreport');
        ev.device = this; ev.reportId = 0x45; ev.data = new DataView(buf);
        this.dispatchEvent(ev);
        if (typeof this.oninputreport === 'function') this.oninputreport(ev);
      }, 8);
    }
  }
  const hid = new EventTarget();
  hid.getDevices = async () => hidDevices.filter((d) => d.granted);
  hid.requestDevice = async () => { hidDevices.forEach((d) => { d.granted = true; }); return hidDevices.slice(); };
  Object.defineProperty(Navigator.prototype, 'hid', { get: () => hid, configurable: true });

  window.__fake = {
    addPad(type) {
      const i = pads.findIndex((p) => !p) >= 0 ? pads.findIndex((p) => !p) : pads.length;
      pads[i] = { id: GP_IDS[type] || type, axes: [0, 0, 0, 0], buttons: new Array(17).fill(0), ts: ++ts };
      const ev = new Event('gamepadconnected'); ev.gamepad = snapshot(pads[i], i);
      window.dispatchEvent(ev);
      return i;
    },
    removePad(i) {
      const ev = new Event('gamepaddisconnected'); ev.gamepad = snapshot(pads[i], i);
      pads[i] = null; window.dispatchEvent(ev);
    },
    press(i, name, ms = 250) {
      const p = pads[i]; const b = BTN[name];
      p.buttons[b] = 1; p.ts = ++ts;
      setTimeout(() => { p.buttons[b] = 0; p.ts = ++ts; }, ms);
    },
    axis(i, a, v) { pads[i].axes[a] = v; pads[i].ts = ++ts; },
    // Steam Controller bodies on one Puck: each body is its own HID interface.
    addPuck(bodies = 1, granted = true) {
      const out = [];
      for (let k = 0; k < bodies; k++) {
        const d = new FakeHid({ vendorId: 0x28de, productId: 0x1304, productName: 'Steam Controller Puck', granted, streams: true, iface: k + 2 });
        hidDevices.push(d); out.push(hidDevices.length - 1);
        if (granted) { const ev = new Event('connect'); ev.device = d; hid.dispatchEvent(ev); }
      }
      return out;
    },
    pressHid(h, name, ms = 250) {
      const d = hidDevices[h]; const [byte, bit] = SC_BITS[name];
      d.bytes[byte] |= bit;
      setTimeout(() => { d.bytes[byte] &= ~bit; }, ms);
    },
    state() { return { pads: pads.map((p) => p && p.id), hid: hidDevices.map((d) => ({ opened: d.opened, granted: d.granted })) }; },
  };
})();
