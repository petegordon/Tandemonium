// fake-gamepads.mjs — a scripted Gamepad API for the headless smokes.
//
// Replaces navigator.getGamepads() before the game loads, so pads go through
// the real path: ControllerManager claims, orphans and reclaims them, the lobby
// seats them, InputManager reads them. Nothing in the game is patched.
//
//   await installFakeGamepads(page);          // before page.goto (harness `before`)
//   const pads = fakePads(page);
//   const i = await pads.plug('dualsense');   // → gamepad index; fires gamepadconnected
//   await pads.press(i, 'A');                 // down for 150 ms, then up
//   await pads.hold(i, 'RT', true);           // stays down until hold(i, 'RT', false)
//   await pads.stick(i, 'LX', -0.8);          // left stick x
//   await pads.unplug(i);                     // slot goes null; fires gamepaddisconnected
//   await pads.replug(i);                     // same id + index back
//
// A pad's `id` string is what Chrome reports for that model, so the registry
// picks the real name, glyph family and A/B swap for it.

/** Chrome's Gamepad.id for each model the bench covers. */
export const PAD_IDS = {
  xbox: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
  dualsense: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
  ds4: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
  switchpro: 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)',
  steam: 'Steam Controller (Vendor: 28de Product: 1304)',
  generic: 'Some Pad (Vendor: 1234 Product: 5678)',
};

/** Standard-mapping button indices. */
export const BUTTONS = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9,
  LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16,
};
export const AXES = { LX: 0, LY: 1, RX: 2, RY: 3 };

function browserFake(PAD_IDS, BUTTONS, AXES) {
  const slots = [null, null, null, null];
  const parked = {};   // index → pad object while unplugged (for replug)
  const btn = () => ({ pressed: false, touched: false, value: 0 });
  const make = (id, index) => ({
    id, index, connected: true, mapping: 'standard', timestamp: performance.now(),
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, btn),
    vibrationActuator: { type: 'dual-rumble', playEffect: async () => 'complete', reset: async () => 'complete' },
    hapticActuators: [],
  });
  const fire = (type, gamepad) => {
    const ev = new Event(type);
    Object.defineProperty(ev, 'gamepad', { value: gamepad });
    window.dispatchEvent(ev);
  };
  const touch = (p) => { p.timestamp = performance.now(); };
  const api = {
    plug(model, index = null) {
      const id = PAD_IDS[model] || model;
      const i = index != null ? index : slots.findIndex((s) => s === null);
      if (i < 0) throw new Error('fake gamepads: all 4 slots full');
      const p = make(id, i);
      slots[i] = p;
      fire('gamepadconnected', p);
      return i;
    },
    unplug(i) {
      const p = slots[i];
      if (!p) return false;
      p.connected = false;
      parked[i] = p;
      slots[i] = null;
      fire('gamepaddisconnected', p);
      return true;
    },
    replug(i) {
      const p = parked[i];
      if (!p || slots[i]) return false;
      p.connected = true;
      p.buttons.forEach((b) => { b.pressed = false; b.value = 0; });
      p.axes.fill(0);
      touch(p);
      slots[i] = p;
      delete parked[i];
      fire('gamepadconnected', p);
      return true;
    },
    hold(i, name, down) {
      const p = slots[i];
      if (!p) return false;
      const b = p.buttons[typeof name === 'number' ? name : BUTTONS[name]];
      b.pressed = !!down; b.touched = !!down; b.value = down ? 1 : 0;
      touch(p);
      return true;
    },
    press(i, name, ms = 150) {
      if (!api.hold(i, name, true)) return false;
      setTimeout(() => api.hold(i, name, false), ms);
      return true;
    },
    stick(i, axis, v) {
      const p = slots[i];
      if (!p) return false;
      p.axes[typeof axis === 'number' ? axis : AXES[axis]] = v;
      touch(p);
      return true;
    },
    list() { return slots.map((p) => (p ? { index: p.index, id: p.id } : null)); },
  };
  const getGamepads = () => slots.slice();
  Object.defineProperty(Navigator.prototype, 'getGamepads', { value: getGamepads, configurable: true, writable: true });
  window.__fakePads = api;
}

/** Install the fake. Call before navigation; pads plugged here exist at boot. */
export async function installFakeGamepads(page, { atBoot = [] } = {}) {
  await page.evaluateOnNewDocument(browserFake, PAD_IDS, BUTTONS, AXES);
  if (atBoot.length) {
    await page.evaluateOnNewDocument((models) => { for (const m of models) window.__fakePads.plug(m); }, atBoot);
  }
}

/** Node-side handle for driving the fake pads on `page`. */
export function fakePads(page) {
  const call = (fn, ...args) => page.evaluate((f, a) => window.__fakePads[f](...a), fn, args);
  return {
    plug: (model, index) => call('plug', model, index ?? null),
    unplug: (i) => call('unplug', i),
    replug: (i) => call('replug', i),
    hold: (i, b, down) => call('hold', i, b, down),
    press: (i, b, ms) => call('press', i, b, ms ?? 150),
    stick: (i, a, v) => call('stick', i, a, v),
    list: () => call('list'),
    /** press and wait long enough for a couple of game frames to see it. */
    async tap(i, b, ms = 180) { await call('press', i, b, ms); await new Promise((r) => setTimeout(r, ms + 120)); },
  };
}
