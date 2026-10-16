import { launch, advance, sleep } from './lib.mjs';
const [steer, stab, amp] = (process.argv[2] || '1,0.35,0.6').split(',').map(Number); const GAINS = JSON.parse(process.argv[3] || '{}');
const s = await launch({ storage: { tandemonium_show_riders: 'on', tandemonium_show_solo: 'off' } });
const { page } = s;
await page.click('#tap-to-start').catch(() => {});
await sleep(500);
await page.evaluate((steer, stab, amp, GAINS) => { Object.assign(window.__reel.gains, GAINS);
  const g = window._game, R = window.__reel;
  const p2 = R.newInput();
  g.lobby._hideLobby();
  g._onLocalReady({ inputP2: p2, sourceType: 'keyboard' });
  R.attach(g.input, () => g.bike, { role: 'captain', steer, stab, sway: { amp, freq: 0.3, phase: 0 } });
  R.attach(p2, () => g.bike, { role: 'stoker', steer, stab, sway: { amp, freq: 0.3, phase: Math.PI } });
}, steer, stab, amp, GAINS);
await sleep(300);
await page.evaluate(() => { document.getElementById('instructions')?.click(); });
await page.waitForFunction(() => window._game.bike.modelLoaded, { timeout: 120000 });
for (let i = 0; i < (+process.argv[4] || 40); i++) {
  await advance(page, 0.5);
  console.log(await page.evaluate(() => { const g = window._game, b = g.bike, R = window.__reel;
    let auto = R.steerHelper.computeAutoSteer(b, g.collectibleManager, g.obstacleManager);
    return [g.state, 'v', b.speed.toFixed(1), 'lean', b.lean.toFixed(2), 'lat', b._lateralOffset.toFixed(2), 'h', (0).toFixed(1),
      'in', R.bots.map(x => x.leanOut.toFixed(2)).join('/'), 'd', b.distanceTraveled.toFixed(0), b.fallen ? 'FALL' : ''].join(' '); }));
}
await s.close();
