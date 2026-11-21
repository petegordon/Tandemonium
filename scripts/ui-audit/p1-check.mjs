// Does pressing a controller button on the first screen make it P1? (#428 bug 2)
import { start, wait, click, fake } from './harness.mjs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tandemonium/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
const h = await start({ out: process.argv[2] });
const state = (p) => p.evaluate(() => {
  const m = window._game?.lobby?.controllerManager; const s = m?.getSlot('P1');
  return { p1: s?.state, label: s?.controllerLabel?.slice(0, 30), gpIndex: window._game?.lobby?.input?.gamepadIndex, captainSeat: document.getElementById('host-seat-captain')?.who };
});
for (const press of [false, true]) {
  const p = await h.open({ setup: (pg) => pg.setUserAgent(UA), storage: { tandemonium_started: '1', tandemonium_tutorial_done: 'audit' }, pads: ['dualsense', 'switch', 'supernova'] });
  await wait(2500);
  if (press) { await fake(p, 'press', 1, 'a'); await wait(800); }   // the SWITCH presses on the first screen
  console.log(press ? 'pressed Switch on mode:' : 'no press:', JSON.stringify(await state(p)));
  await click(p, '#btn-together'); await wait(1000); await click(p, '#btn-captain'); await wait(3000);
  console.log('  captain room:', JSON.stringify(await state(p)));
  await p.close();
}
await h.close();
