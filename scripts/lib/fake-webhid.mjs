// fake-webhid.mjs — a scripted navigator.hid for the headless smokes.
//
// Replaces navigator.hid before the game loads. Each fake device replays input
// reports (recorded captures from scripts/fixtures/hid/, or built here) in a
// loop while it is open, so the real drivers and ControllerManager run on it:
// registry connect → driver init (BT feature read, IMU probe, Puck lizard-mode
// handshake) → HidEntry parsing → pool → seat.
//
//   await installFakeWebHid(page, [ hidDevice.dualsenseUsb('ds-a'), ... ]);   // before goto
//   const hid = fakeHid(page);
//   await hid.press('ds-a', PS_CROSS.ds5, 200);   // OR a bit into every report for 200 ms
//   await hid.disconnect('ds-a');                 // fires navigator.hid 'disconnect'
//   await hid.connect('ds-a');                    // a NEW HIDDevice object, as Chrome does
//   await hid.stats('ds-a');                      // { opened, connected, emitted, featureReads, featureSends }
//
// Devices added with `granted: false` aren't in getDevices() until a
// requestDevice() call matching their vid:pid grants them.
import fs from 'node:fs';
import path from 'node:path';

const FIXTURES = path.join(process.cwd(), 'scripts/fixtures/hid');

/** Reports of one capture step as [{ reportId, hex }]. */
export function fixtureReports(file, step = 'at-rest') {
  const j = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
  const s = j.steps.find((x) => x.id === step);
  if (!s) throw new Error(`fixture ${file} has no step ${step}`);
  return s.reports.map((r) => ({ reportId: r.reportId ?? 1, hex: r.bytes }));
}

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');
const s16 = (u8, o, v) => { const x = v & 0xffff; u8[o] = x & 0xff; u8[o + 1] = x >> 8; };

/**
 * DualSense USB report 0x01 at the driver's documented layout (no real capture
 * exists yet): sticks centred, dpad neutral, IMU at byte 15 with ~1 g on one
 * accel axis and a little gyro noise so the IMU probe scores it at rest.
 */
export function dualsenseUsbReports(n = 30) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const u8 = new Uint8Array(63);
    u8[0] = u8[1] = u8[2] = u8[3] = 128;
    u8[7] = 0x08;                          // dpad neutral, no face buttons
    const g = 15;
    s16(u8, g, (i % 3) - 1); s16(u8, g + 2, ((i + 1) % 3) - 1); s16(u8, g + 4, 0);
    s16(u8, g + 6, 40); s16(u8, g + 8, 8190); s16(u8, g + 10, -60);   // accel ≈ 1 g
    out.push({ reportId: 0x01, hex: hex(u8) });
  }
  return out;
}

const items = (bytes) => [{ reportSize: 8, reportCount: bytes }];

/** HID collections per transport, as the drivers' detectConnectionType reads them. */
export const COLLECTIONS = {
  psUsb: [{ usagePage: 0x01, usage: 0x05, inputReports: [{ reportId: 0x01, items: items(63) }], outputReports: [{ reportId: 0x02, items: items(47) }], featureReports: [{ reportId: 0x05, items: items(40) }] }],
  ds4Usb: [{ usagePage: 0x01, usage: 0x05, inputReports: [{ reportId: 0x01, items: items(63) }], outputReports: [{ reportId: 0x05, items: items(31) }], featureReports: [{ reportId: 0x02, items: items(36) }, { reportId: 0x11, items: items(48) }] }],
  ds4Bt: [{ usagePage: 0x01, usage: 0x05, inputReports: [{ reportId: 0x01, items: items(9) }, { reportId: 0x11, items: items(77) }], outputReports: [{ reportId: 0x11, items: items(77) }], featureReports: [{ reportId: 0x02, items: items(36) }] }],
  puck: [{ usagePage: 0xff00, usage: 0x01, inputReports: [{ reportId: 0x45, items: items(53) }, { reportId: 0x7b, items: items(53) }], outputReports: [], featureReports: [{ reportId: 0x01, items: items(64) }] }],
};

/** Ready-made device specs. `key` is the test's own name for the device. */
export const hidDevice = {
  dualsenseUsb: (key, extra = {}) => ({ key, vendorId: 0x054c, productId: 0x0ce6, productName: 'DualSense Wireless Controller', collections: COLLECTIONS.psUsb, reports: dualsenseUsbReports(), ...extra }),
  superNova: (key, extra = {}) => ({ key, vendorId: 0x054c, productId: 0x09cc, productName: 'Wireless Controller', collections: COLLECTIONS.ds4Usb, reports: fixtureReports('gamesir-super-nova-ds4_054c-09cc.json'), ...extra }),
  ds4Bt: (key, extra = {}) => ({ key, vendorId: 0x054c, productId: 0x05c4, productName: 'Wireless Controller', collections: COLLECTIONS.ds4Bt, reports: fixtureReports('sony-dualshock4-v1-bt_054c-05c4.json'), ...extra }),
  /** A Puck interface that enumerates but never streams (the idle receiver siblings). */
  puckIdleSibling: (key, extra = {}) => ({ key, vendorId: 0x28de, productId: 0x1304, productName: "Steam Controller Puck", collections: COLLECTIONS.puck, reports: [], ...extra }),
  steamPuck: (key, extra = {}) => ({ key, vendorId: 0x28de, productId: 0x1304, productName: 'Steam Controller Puck', collections: COLLECTIONS.puck, reports: fixtureReports('steam-controller-puck_28de-1304.json'), ...extra }),
};

/** Where each family's "cross / A" bit sits in the report (report id stripped). */
export const FACE_A = {
  ds5Usb: { offset: 7, mask: 0x20 },     // DualSense USB: face byte 7, cross = 0x20
  ds4Usb: { offset: 4, mask: 0x20 },     // DS4 USB: face byte 4
  ds4Bt: { offset: 6, mask: 0x20 },      // DS4 BT: +2 header
  steam: { offset: 1, mask: 0x01 },      // Steam STATE 0x45: btn0 bit 0 = A
};

function browserFakeHid(specs) {
  const parse = (h) => Uint8Array.from(h.trim().split(/\s+/).map((b) => parseInt(b, 16)));
  const recs = new Map();   // key → { spec, device, granted, connected, timer, i, overrides, stats }
  const hid = new EventTarget();
  const fire = (target, type, props) => { const ev = new Event(type); for (const [k, v] of Object.entries(props)) Object.defineProperty(ev, k, { value: v }); target.dispatchEvent(ev); };

  class FakeHIDDevice extends EventTarget {
    constructor(rec) {
      super();
      this._rec = rec;
      this.vendorId = rec.spec.vendorId; this.productId = rec.spec.productId;
      this.productName = rec.spec.productName; this.collections = rec.spec.collections || [];
      this.opened = false; this.oninputreport = null;
      this.__fakeKey = rec.spec.key;
    }
    async open() { if (!this._rec.connected || this._rec.device !== this) throw new DOMException('Device not connected', 'NotFoundError'); this.opened = true; startStream(this._rec); }
    async close() { this.opened = false; stopStream(this._rec); }
    async forget() { this._rec.granted = false; await this.close(); }
    async sendReport(id, data) { if (!this.opened) throw new DOMException('closed', 'InvalidStateError'); this._rec.stats.outputSends++; }
    async sendFeatureReport(id, data) { if (!this.opened) throw new DOMException('closed', 'InvalidStateError'); this._rec.stats.featureSends++; }
    async receiveFeatureReport(id) { if (!this.opened) throw new DOMException('closed', 'InvalidStateError'); this._rec.stats.featureReads++; return new DataView(new ArrayBuffer(64)); }
  }

  const reportFor = (rec) => {
    const r = rec.reports[rec.i++ % rec.reports.length];
    const u8 = r.bytes.slice();
    for (const o of rec.overrides.values()) if (o.offset < u8.length) u8[o.offset] |= o.mask;
    return { reportId: r.reportId, data: new DataView(u8.buffer) };
  };
  function startStream(rec) {
    if (rec.timer || !rec.reports.length) return;   // an idle interface (Puck sibling) never streams
    rec.timer = setInterval(() => {
      const d = rec.device;
      if (!d || !d.opened || !rec.connected) return;
      const { reportId, data } = reportFor(rec);
      rec.stats.emitted++;
      const ev = new Event('inputreport');
      Object.defineProperty(ev, 'reportId', { value: reportId });
      Object.defineProperty(ev, 'data', { value: data });
      Object.defineProperty(ev, 'device', { value: d });
      if (typeof d.oninputreport === 'function') d.oninputreport(ev);
      d.dispatchEvent(ev);
    }, rec.spec.intervalMs || 8);
  }
  function stopStream(rec) { if (rec.timer) { clearInterval(rec.timer); rec.timer = null; } }

  function add(spec) {
    const rec = {
      spec, granted: spec.granted !== false, connected: spec.connected !== false, timer: null, i: 0,
      reports: spec.reports.map((r) => ({ reportId: r.reportId, bytes: parse(r.hex) })),
      overrides: new Map(), stats: { emitted: 0, featureReads: 0, featureSends: 0, outputSends: 0, objects: 1 },
    };
    rec.device = new FakeHIDDevice(rec);
    recs.set(spec.key, rec);
    return rec;
  }
  for (const s of specs) add(s);

  hid.getDevices = async () => [...recs.values()].filter((r) => r.granted && r.connected).map((r) => r.device);
  hid.requestDevice = async ({ filters = [] } = {}) => {
    const match = (r) => !filters.length || filters.some((f) => (f.vendorId == null || f.vendorId === r.spec.vendorId) && (f.productId == null || f.productId === r.spec.productId));
    const picked = [...recs.values()].filter((r) => r.connected && !r.granted && match(r));
    picked.forEach((r) => { r.granted = true; });
    return picked.map((r) => r.device);
  };
  Object.defineProperty(Navigator.prototype, 'hid', { get: () => hid, configurable: true });

  window.__fakeHid = {
    add(spec) { const r = add(spec); if (r.granted && r.connected) fire(hid, 'connect', { device: r.device }); return spec.key; },
    disconnect(key) {
      const r = recs.get(key); if (!r || !r.connected) return false;
      r.connected = false; r.device.opened = false; stopStream(r);
      fire(hid, 'disconnect', { device: r.device });
      return true;
    },
    /** Reconnect: Chrome hands out a NEW HIDDevice object for the same unit. */
    connect(key) {
      const r = recs.get(key); if (!r || r.connected) return false;
      r.connected = true; r.i = 0; r.overrides.clear();
      r.device = new FakeHIDDevice(r); r.stats.objects++;
      if (r.granted) fire(hid, 'connect', { device: r.device });
      return true;
    },
    hold(key, offset, mask, on) {
      const r = recs.get(key); if (!r) return false;
      const id = offset + ':' + mask;
      if (on) r.overrides.set(id, { offset, mask }); else r.overrides.delete(id);
      return true;
    },
    press(key, offset, mask, ms = 200) {
      if (!window.__fakeHid.hold(key, offset, mask, true)) return false;
      setTimeout(() => window.__fakeHid.hold(key, offset, mask, false), ms);
      return true;
    },
    device(key) { const r = recs.get(key); return r ? r.device : null; },
    stats(key) { const r = recs.get(key); return r ? { opened: r.device.opened, connected: r.connected, granted: r.granted, ...r.stats } : null; },
    keys() { return [...recs.keys()]; },
  };
}

/** Install the fake with the devices present (and granted) at boot. */
export async function installFakeWebHid(page, specs = []) {
  await page.evaluateOnNewDocument(browserFakeHid, specs);
}

/** Node-side handle for driving the fake HID devices on `page`. */
export function fakeHid(page) {
  const call = (fn, ...args) => page.evaluate((f, a) => window.__fakeHid[f](...a), fn, args);
  return {
    add: (spec) => call('add', spec),
    disconnect: (key) => call('disconnect', key),
    connect: (key) => call('connect', key),
    hold: (key, bit, on) => call('hold', key, bit.offset, bit.mask, on),
    press: (key, bit, ms = 200) => call('press', key, bit.offset, bit.mask, ms),
    stats: (key) => call('stats', key),
    keys: () => call('keys'),
  };
}
