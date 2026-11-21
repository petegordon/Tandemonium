// node scripts/ui-audit/capture.mjs <outDir> <scenario...>
// Pads in Pete's priority order: dualsense, puck (Steam Controller via WebHID),
// switch, supernova (GameSir Super Nova, DS4 mode), xbox.
import { start, wait, click, fake } from './harness.mjs';

const [out, ...want] = process.argv.slice(2);
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tandemonium/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
const RETURNING = { tandemonium_started: '1', tandemonium_tutorial_done: 'audit' };
const FIRST_RUN_STARTED = { tandemonium_started: '1' };

const h = await start({ out });

async function run(page, prefix, steps) {
  for (const s of steps) {
    try {
      if (s.do) await s.do(page);
      await wait(s.wait ?? 900);
      if (s.id) await h.shot(page, `${prefix}-${s.id}`, { title: s.title, scenario: prefix, pads: page.padsDesc });
    } catch (e) {
      console.log(`✗ ${prefix}-${s.id || '(action)'}: ${e.message.split('\n')[0]}`);
    }
  }
  const errs = page.logs.filter((l) => /pageerror|Uncaught/i.test(l));
  if (errs.length) console.log('  page errors:\n  ' + [...new Set(errs)].slice(0, 8).join('\n  '));
}
const electron = (page) => page.setUserAgent(ELECTRON_UA);
const gp = (i, b) => (page) => fake(page, 'press', i, b);
const hid = (k, b) => (page) => fake(page, 'pressHid', k, b);
const ev = (fn) => (page) => page.evaluate(fn);
async function openE(opts) {
  const p = await h.open({ setup: electron, storage: RETURNING, ...opts });
  p.padsDesc = [...(opts.pads || []), ...(opts.pucks ? [`puck×${opts.pucks}`] : [])].join(', ') || 'none';
  return p;
}
// DualSense: ✕ = button 0 (a), ◯ = button 1 (b).
const X = gp(0, 'a'), O = gp(0, 'b'), DN = gp(0, 'down'), UP = gp(0, 'up'), RT = gp(0, 'right'), LT = gp(0, 'left');

const SCENARIOS = {
  async boot() {
    let p = await h.open({});
    p.padsDesc = 'none';
    await run(p, 'boot', [{ id: 'browser-gate', title: 'First launch: browser "Click to start"', wait: 300 }]);
    await p.close();
    p = await h.open({ setup: electron, pads: ['dualsense'] });
    p.padsDesc = 'dualsense';
    await run(p, 'boot', [
      { id: 'electron-gate', title: 'First launch: desktop app', wait: 200 },
      { id: 'electron-after-x', title: 'After pressing ✕', do: X, wait: 1500 },
    ]);
    await p.close();
  },

  // Mode screen + every popup, driven by DualSense; ◯ should close each one.
  async lobby() {
    const p = await openE({ pads: ['dualsense'] });
    await run(p, 'lobby', [
      { id: 'mode', title: 'Mode select (DualSense, focus on RIDE TOGETHER)' },
      { id: 'mode-d1', title: 'D-pad ↓', do: DN },
      { id: 'mode-d2', title: 'D-pad ↓ ×2', do: DN },
      { id: 'mode-d3', title: 'D-pad ↓ ×3', do: DN },
      { id: 'mode-d4', title: 'D-pad ↓ ×4', do: DN },
      { id: 'mode-d5', title: 'D-pad ↓ ×5', do: DN },
      { id: 'mode-left', title: 'D-pad ← from buttons', do: async (pg) => { for (let i = 0; i < 5; i++) { await UP(pg); await wait(350); } await LT(pg); } },
      { id: 'mode-right', title: 'D-pad → ×2 (to right toggles)', do: async (pg) => { await RT(pg); await wait(350); await RT(pg); } },
      { id: 'help', title: 'Help (?)', do: (pg) => click(pg, '#toggle-help') },
      { id: 'help-closed', title: 'Help after ◯', do: O },
      { do: (pg) => pg.keyboard.press('Escape') },
      { do: (pg) => click(pg, '#help-modal-inner ~ * , #help-modal button').catch(() => {}) },
      { id: 'leaderboard', title: 'Leaderboard (☆)', do: (pg) => click(pg, '#toggle-leaderboard'), wait: 1500 },
      { id: 'leaderboard-closed', title: 'Leaderboard after ◯', do: O },
      { id: 'profile', title: 'Profile popup', do: (pg) => click(pg, '#toggle-profile') },
      { id: 'profile-closed', title: 'Profile after ◯', do: O },
      { id: 'music', title: 'Music / volume picker', do: (pg) => click(pg, '#toggle-music') },
      { id: 'music-closed', title: 'Music after ◯', do: O },
      { id: 'settings', title: 'Settings (⚙)', do: (pg) => click(pg, '#ctrl-settings-btn'), wait: 1200 },
      { id: 'settings-closed', title: 'Settings after ◯', do: O },
      { id: 'credits', title: 'Credits (©)', do: (pg) => click(pg, '#credits-btn') },
      { id: 'credits-closed', title: 'Credits after ◯', do: O },
      { id: 'phone', title: 'Phone as controller', do: (pg) => click(pg, '#btn-mode-phone'), wait: 1500 },
      { id: 'phone-closed', title: 'Phone after ◯', do: O },
      { id: 'garage', title: 'Garage', do: (pg) => click(pg, '#btn-garage'), wait: 3000 },
      { id: 'garage-closed', title: 'Garage after ◯', do: O, wait: 1500 },
    ]);
    await p.close();
  },

  async ctrltest() {
    const p = await openE({ pads: ['dualsense'] });
    await run(p, 'lobby', [{ id: 'ctrl-test', title: 'Controller test (🎮) — leaves the lobby', do: (pg) => click(pg, '#ctrl-test-btn'), wait: 3000 }]);
    await p.close();
  },

  // First-time player: SOLO jumps straight into the tutorial.
  async firstsolo() {
    const p = await openE({ pads: ['dualsense'], storage: FIRST_RUN_STARTED });
    await run(p, 'first', [
      { id: 'solo-click', title: 'First-time player presses SOLO RIDE', do: (pg) => click(pg, '#btn-solo'), wait: 400 },
      { id: 'solo-2s', title: '…2 s later', wait: 1600 },
      { id: 'solo-6s', title: '…6 s later (tutorial)', wait: 4000 },
      { id: 'tut-complete', title: 'Tutorial complete', do: ev(() => window._game._tutorialComplete()), wait: 2500 },
    ]);
    await p.close();
  },

  async solo() {
    const p = await openE({ pads: ['dualsense'] });
    await run(p, 'solo', [
      { id: 'level', title: 'Solo: level select', do: (pg) => click(pg, '#btn-solo'), wait: 1500 },
      { id: 'level-r', title: 'D-pad →', do: RT },
      { id: 'level-d1', title: 'D-pad ↓', do: DN },
      { id: 'level-d2', title: 'D-pad ↓ ×2', do: DN },
      { id: 'level-d3', title: 'D-pad ↓ ×3', do: DN },
      { id: 'level-d4', title: 'D-pad ↓ ×4', do: DN },
      { id: 'start', title: 'START RIDE', do: (pg) => click(pg, '#btn-start-ride'), wait: 1500 },
      { id: 'start-3s', title: '…3 s', wait: 1500 },
      { id: 'start-x', title: 'Press ✕', do: X, wait: 1500 },
      { id: 'playing', title: 'Riding', wait: 4000 },
      { id: 'pause-options', title: 'Options/Start button (pause)', do: gp(0, 'start'), wait: 1200 },
      { id: 'pause-o', title: '◯ closes pause?', do: O, wait: 1200 },
      { id: 'pause-share', title: 'Create/Back button', do: gp(0, 'back'), wait: 1200 },
      { do: O, wait: 800 },
      { id: 'options', title: 'In-ride options', do: ev(() => window._game._openOptions()), wait: 1200 },
      { do: O, wait: 800 },
      { id: 'gameover', title: 'Crash / game over', do: ev(() => window._game._showGameOver()), wait: 2500 },
      { id: 'gameover-d1', title: 'Game over D-pad ↓', do: DN },
      { id: 'victory', title: 'Victory', do: ev(() => { document.getElementById('gameover-overlay').style.display = 'none'; window._game._showVictory(); }), wait: 3000 },
      { id: 'victory-d1', title: 'Victory D-pad ↓', do: DN },
      { id: 'demo-end', title: 'Demo end', do: ev(() => { document.getElementById('victory-overlay').style.display = 'none'; window._game._showDemoEnd(); }), wait: 1500 },
      { id: 'disconnect', title: 'Partner disconnected', do: ev(() => { document.getElementById('demo-end-overlay').style.display = 'none'; window._game._showDisconnect('Partner left'); }), wait: 1200 },
    ]);
    await p.close();
  },

  async together() {
    const p = await openE({ pads: ['dualsense'] });
    await run(p, 'mp', [
      { id: 'role', title: 'Ride together: choose seat', do: (pg) => click(pg, '#btn-together'), wait: 1500 },
      { id: 'role-d1', title: 'D-pad ↓', do: DN },
      { id: 'role-d2', title: 'D-pad ↓ ×2', do: DN },
      { id: 'host', title: 'Captain: room code (1 pad)', do: (pg) => click(pg, '#btn-captain'), wait: 2500 },
      { id: 'host-o', title: '◯ back', do: O, wait: 1200 },
      { id: 'join', title: 'Stoker: enter code (DualSense spinners)', do: (pg) => click(pg, '#btn-stoker'), wait: 1500 },
      { id: 'join-up', title: 'Spinner ↑', do: UP },
      { id: 'join-o', title: '◯ back', do: O, wait: 1200 },
      { id: 'room', title: 'Room (forced, no partner)', do: ev(() => { const l = window._game.lobby; l._showStep(l.roomStep); }), wait: 1500 },
    ]);
    await p.close();
  },

  // The join step's spinner hints per controller type.
  async joinglyphs() {
    for (const t of ['switch', 'supernova', 'xbox']) {
      const p = await openE({ pads: [t] });
      await run(p, `join-${t}`, [
        { do: (pg) => click(pg, '#btn-together'), wait: 1200 },
        { id: 'role', title: `Choose seat (${t})` },
        { id: 'join', title: `Join code (${t})`, do: (pg) => click(pg, '#btn-stoker'), wait: 1500 },
      ]);
      await p.close();
    }
    const p = await openE({ pucks: 1 });
    await run(p, 'join-puck', [
      { id: 'mode', title: 'Mode select, Steam Controller (Puck) only', wait: 1500 },
      { id: 'mode-a', title: 'Puck A pressed', do: hid(0, 'a'), wait: 1200 },
      { id: 'mode-down', title: 'Puck D-pad ↓', do: hid(0, 'down'), wait: 900 },
      { do: (pg) => click(pg, '#btn-together'), wait: 1200 },
      { id: 'join', title: 'Join code (Steam Controller)', do: (pg) => click(pg, '#btn-stoker'), wait: 1500 },
    ]);
    await p.close();
  },

  // Local co-op from the captain step with several controllers.
  async localcoop() {
    const p = await openE({ pads: ['dualsense', 'switch'], pucks: 1 });
    await run(p, 'coop', [
      { do: (pg) => click(pg, '#btn-together'), wait: 1200 },
      { id: 'host-3pads', title: 'Captain step with DualSense + Switch Pro + Steam Controller', do: (pg) => click(pg, '#btn-captain'), wait: 3000 },
      { id: 'host-p2-x', title: 'Switch Pro presses A (join as P2)', do: gp(1, 'a'), wait: 1500 },
      { id: 'host-level', title: 'After joining', wait: 1500 },
    ]);
    await p.close();
  },

  async versus() {
    const setups = [
      ['v2', ['dualsense'], 1],
      ['v4', ['dualsense', 'switch', 'supernova'], 1],
    ];
    for (const [tag, pads, pucks] of setups) {
      const p = await openE({ pads, pucks });
      const steps = [
        { do: (pg) => click(pg, '#btn-together'), wait: 1200 },
        { id: 'empty', title: `Versus: ${p.padsDesc}, nobody joined`, do: (pg) => click(pg, '#btn-versus'), wait: 2000 },
        { id: 'j1', title: 'DualSense presses ✕', do: X, wait: 1200 },
        { id: 'jpuck', title: 'Steam Controller presses A', do: hid(0, 'a'), wait: 1500 },
      ];
      if (pads.length > 1) steps.push(
        { id: 'j3', title: 'Switch Pro presses A', do: gp(1, 'a'), wait: 1200 },
        { id: 'j4', title: 'Super Nova presses ✕', do: gp(2, 'a'), wait: 1200 },
        { id: 'team', title: 'Super Nova → (switch team)', do: gp(2, 'right'), wait: 1000 },
      );
      steps.push(
        { id: 'level', title: 'CHOOSE LEVEL', do: (pg) => click(pg, '#btn-versus-continue'), wait: 2000 },
        { id: 'race', title: 'START RIDE → split screen', do: (pg) => click(pg, '#btn-start-ride'), wait: 5000 },
        { id: 'race-8s', title: 'Racing', wait: 4000 },
        { id: 'results', title: 'Versus results', do: ev(() => { const g = window._game; if (g.versusRigs?.length) g._finishVersusRace(g.versusRigs[0]); }), wait: 6000 },
      );
      await run(p, `vs-${tag}`, steps);
      await p.close();
    }
  },

  async hotplug() {
    const p = await openE({ pads: [] });
    await run(p, 'hot', [
      { id: 'mode-none', title: 'No controller' },
      { id: 'plug-ds', title: 'DualSense plugged in', do: (pg) => fake(pg, 'addPad', 'dualsense'), wait: 1500 },
      { id: 'plug-ds-x', title: 'DualSense ✕', do: X, wait: 1500 },
      { do: (pg) => click(pg, '#btn-solo'), wait: 1200 },
      { do: (pg) => click(pg, '#btn-start-ride'), wait: 4000 },
      { do: X, wait: 4000 },
      { id: 'ride', title: 'Riding' },
      { id: 'unplug', title: 'DualSense unplugged mid-ride', do: (pg) => fake(pg, 'removePad', 0), wait: 2000 },
      { id: 'replug', title: 'Plugged back in', do: (pg) => fake(pg, 'addPad', 'dualsense'), wait: 2000 },
    ]);
    await p.close();
  },

  // Browser (not desktop app): the WebHID "Pair it" paths are visible.
  async browser() {
    const p = await h.open({ storage: RETURNING, pads: ['dualsense'] });
    p.padsDesc = 'dualsense (browser)';
    await run(p, 'web', [
      { id: 'mode', title: 'Browser: mode select (Pair it visible)' },
      { do: (pg) => click(pg, '#btn-together'), wait: 1200 },
      { id: 'versus', title: 'Browser: versus step', do: (pg) => click(pg, '#btn-versus'), wait: 1500 },
      { id: 'pair', title: 'Pair it (WebHID picker granted)', do: (pg) => click(pg, '#btn-versus-connect-hid'), wait: 1500 },
    ]);
    await p.close();
  },
};

for (const name of want.length ? want : Object.keys(SCENARIOS)) {
  console.log(`\n=== ${name}`);
  try { await SCENARIOS[name](); } catch (e) { console.log(`✗ scenario ${name}: ${e.stack}`); }
}
await h.close();
