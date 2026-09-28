#!/usr/bin/env node
// smoke-slingshot-aim.mjs — the aim phase on phones (Phase 0 acceptance in
// docs/slingshot-design-plan.md), portrait 390×844 and landscape 844×390 with
// real CDP touch: the aim camera holds still, the aim visibly moves the bike
// (≥ 120 px), forks and pouch stay on screen, no text covers the bike, no
// pedal pads, pointercancel cancels out loud, right-click is ignored, a launch
// earns no achievement, and keyboard and gamepad can both launch.
//   node scripts/smoke-slingshot-aim.mjs [--shots <dir>]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT = process.cwd(); const PORT = 8923;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.json': 'application/json' };
const server = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  fs.stat(f, (e, st) => { if (e || st.isDirectory()) return r.writeHead(404).end(); r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url(); if (u.startsWith(`http://127.0.0.1:${PORT}`)) return req.continue();
  let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
  if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
  m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]);
  if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
  return req.abort();
});
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('  PAGEERROR:', e.message); });
// As the PR-preview workflow stamps it (no version.json locally: nothing to nag about).
await page.evaluateOnNewDocument(() => { window.__BUILD = { sha: 'abc1234', pr: 397, time: 'now' }; });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tandemonium_slingshot', JSON.stringify({ v: 2, coins: 0, best: 0, runs: 0, stage: 1, lv: {} })); } catch (e) {} });
const checks = [];
const check = (ok, msg) => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${msg}`); };
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();

// Everything measured in the page: camera pose, bike + forks projected to pixels.
const measure = () => page.evaluate(() => {
  const g = window._game, cam = g.camera, W = window.innerWidth, H = window.innerHeight;
  const THREE_V = cam.position.constructor;
  const px = (v) => { const p = v.clone().project(cam); return { x: (p.x + 1) / 2 * W, y: (1 - p.y) / 2 * H, z: p.z }; };
  const bikeC = px(g.bike.position.clone());
  // Far end of the aim guide on the road, in pixels (where the bike will go).
  let guideEndX = null;
  if (g._slingRig && g._slingRig.guide.visible) {
    const gd = g._slingRig.guide, len = gd.scale.z;
    const end = gd.position.clone(); end.x += Math.sin(gd.rotation.y) * len; end.z += Math.cos(gd.rotation.y) * len;
    guideEndX = px(end).x;
  }
  const rig = g._slingRig;
  const pts = rig ? [...rig.tips, rig.pouch.position].map(px) : [];
  const inView = pts.length > 0 && pts.every(p => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H && p.z < 1);
  // Bike's projected bounds (8 corners of its world box).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  g.bike.group.updateMatrixWorld(true);
  g.bike.group.traverse(o => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) {
      const v = new THREE_V(cx, cy, cz).applyMatrix4(o.matrixWorld); const p = px(v);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  });
  const bb = { left: Math.max(0, minX), right: Math.min(W, maxX), top: Math.max(0, minY), bottom: Math.min(H, maxY) };
  const texts = ['#sling-pull .sling-hint', '#sling-hud', '#countdown-flavor', '#sling-toast'].map(sel => {
    const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect(); const vis = getComputedStyle(el).opacity !== '0' && r.width > 0 && r.height > 0 && (el.textContent || '').trim() !== '';
    return vis ? { sel, r: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } } : null;
  }).filter(Boolean);
  const overlaps = texts.filter(t => t.r.left < bb.right && t.r.right > bb.left && t.r.top < bb.bottom && t.r.bottom > bb.top).map(t => t.sel);
  const hidden = (sel) => [...document.querySelectorAll(sel)].every(e => !e.offsetParent || getComputedStyle(e).display === 'none');
  return {
    state: g.state, pull: g._slingRun ? g._slingRun.pull : null,
    cam: { x: cam.position.x, y: cam.position.y, z: cam.position.z, rx: cam.rotation.x, ry: cam.rotation.y, rz: cam.rotation.z },
    bikeX: bikeC.x, guideEndX, inView, overlaps, pedalsHidden: hidden('#pedal-bar') && hidden('.versus-pedals'),
    earned: g.achievements.getEarnedIds().length,
    toast: document.getElementById('sling-toast').classList.contains('visible'),
  };
});
const camSame = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.01 &&
  Math.max(Math.abs(a.rx - b.rx), Math.abs(a.ry - b.ry), Math.abs(a.rz - b.rz)) < 0.1 * Math.PI / 180;
const waitState = (s, timeout = 120000) => page.waitForFunction((s) => window._game?.state === s, { timeout, polling: 100 }, s);
const cdp = await page.createCDPSession();
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }] });

async function toSlingshot(first) {
  if (first) {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window._game, { timeout: 30000 });
    await page.evaluate(() => document.getElementById('tap-to-start')?.click());
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => document.getElementById('btn-solo').click());
    await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card-slingshot'), { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#level-cards .level-card-slingshot').click());
    await waitState('slingGarage', 20000);
    await page.evaluate(() => Array.from(document.querySelectorAll('#sling-garage button')).find(b => /launch/i.test(b.textContent)).click());
  } else {
    await page.evaluate(() => window._game._resetGame());
  }
  await waitState('slingAim', 120000);
  await new Promise(r => setTimeout(r, 1500));
}

async function suite(label, vp) {
  console.log(`\n— ${label} (${vp.width}×${vp.height}) —`);
  await page.emulate({ viewport: { ...vp, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await toSlingshot(true);
  const cx = vp.width / 2, cy = vp.height * 0.45;
  const rest = await measure();
  if (label === 'portrait') {
    const badge = await page.evaluate(() => ({ text: document.getElementById('build-badge')?.textContent, stale: !!document.getElementById('build-stale') }));
    check(badge.text === 'PR #397 · abc1234' && !badge.stale, `build badge shows "${badge.text}", no false stale warning`);
  }
  check(rest.inView, 'both forks and the pouch are on screen');
  check(rest.pedalsHidden, 'no pedal pads');
  check(rest.overlaps.length === 0, `no text over the bike at rest${rest.overlaps.length ? ' (' + rest.overlaps.join(', ') + ')' : ''}`);
  const earnedBefore = rest.earned;

  const S = Math.min(vp.width, vp.height);
  const pullPx = Math.min(vp.height * 0.3 + 20, vp.height - cy - 10);
  const sidePx = vp.width * 0.25 + 10;
  async function holdAt(dx, dy) {
    await touch('touchStart', cx, cy);
    for (let i = 1; i <= 5; i++) { await touch('touchMove', cx + dx * i / 5, cy + dy * i / 5); await new Promise(r => setTimeout(r, 100)); }
    await new Promise(r => setTimeout(r, 1500));
    return measure();
  }
  const left = await holdAt(-sidePx, pullPx);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${label}-left.png` });
  await touch('touchMove', cx + sidePx, cy + pullPx); await new Promise(r => setTimeout(r, 1500));
  const right = await measure();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${label}-right.png` });
  check(camSame(rest.cam, left.cam) && camSame(rest.cam, right.cam), 'the aim camera does not move while aiming');
  const dxPx = Math.abs(left.bikeX - right.bikeX);
  check(dxPx >= 120, `full-left vs full-right moves the bike ${dxPx.toFixed(0)} px on screen (≥ 120)`);
  check(left.bikeX < rest.bikeX - 40 && right.bikeX > rest.bikeX + 40,
    `the bike follows the finger (left ${(left.bikeX - rest.bikeX).toFixed(0)} px, right +${(right.bikeX - rest.bikeX).toFixed(0)} px)`);
  check(left.guideEndX > left.bikeX && right.guideEndX < right.bikeX,
    'and flies back through the forks: pulled left aims right, pulled right aims left');
  check(left.inView && right.inView, 'forks and pouch stay on screen at full pull');
  check(left.overlaps.length === 0 && right.overlaps.length === 0, `no text over the bike while aiming${left.overlaps.length + right.overlaps.length ? ' (left: ' + left.overlaps.join(',') + ' right: ' + right.overlaps.join(',') + ')' : ''}`);

  // A system gesture stealing the finger cancels, and says so.
  await touch('touchCancel');
  await new Promise(r => setTimeout(r, 400));
  const cancelled = await measure();
  check(cancelled.state === 'slingAim' && cancelled.pull === 0 && cancelled.toast, 'pointercancel mid-pull: bands slack, "Cancelled" shown');

  // A right-click drag is not a pull.
  await page.mouse.move(cx, cy); await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx, cy + pullPx, { steps: 4 }); await new Promise(r => setTimeout(r, 800));
  const rc = await measure(); await page.mouse.up({ button: 'right' });
  check(rc.pull === 0, 'a right-click drag is ignored');

  // Touch launch; no achievement for being flung.
  await holdAt(0, pullPx);
  await touch('touchEnd');
  await waitState('playing', 60000);
  await new Promise(r => setTimeout(r, 2500));
  const flown = await measure();
  check(flown.earned === earnedBefore, `no achievement fires on a launch (${flown.earned - earnedBefore} new)`);

  // Keyboard: hold ↓, nudge →, release ↓ fires.
  await toSlingshot(false);
  await page.keyboard.down('ArrowDown'); await page.keyboard.down('ArrowRight');
  await new Promise(r => setTimeout(r, 1800));
  const kbHeld = await measure();
  await page.keyboard.up('ArrowRight'); await page.keyboard.up('ArrowDown');
  await waitState('playing', 60000).then(() => true, () => false);
  const kb = await measure();
  check(kbHeld.pull > 0.5 && kb.state === 'playing', `keyboard: hold ↓ draws (pull ${kbHeld.pull.toFixed(2)}), release fires`);

  // Gamepad / Deck: left stick down = pull, A fires.
  await toSlingshot(false);
  await page.evaluate(() => {
    const pad = { axes: [0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    window._game.input.getGamepadState = () => pad;
  });
  await page.evaluate(() => { window.__pad.axes = [-0.6, 1]; });
  await new Promise(r => setTimeout(r, 1500));
  const padHeld = await measure();
  await page.evaluate(() => { window.__pad.buttons[0] = { pressed: true, value: 1 }; });
  const padFired = await waitState('playing', 60000).then(() => true, () => false);
  await page.evaluate(() => { window.__pad.buttons[0] = { pressed: false, value: 0 }; window.__pad.axes = [0, 0]; });
  check(padHeld.pull > 0.9 && padFired, `gamepad: stick down draws (pull ${padHeld.pull.toFixed(2)}), A fires`);

  // Left stick as the pouch: pull back (and aside), then just let it go.
  await toSlingshot(false);
  await page.evaluate(() => { window.__pad.axes = [0.6, 1]; });
  await new Promise(r => setTimeout(r, 1800));
  const stickHeld = await measure();
  const stickAim = await page.evaluate(() => ({ side: window._game._slingRun.side }));
  await page.evaluate(() => { window.__pad.axes = [0, 0]; });            // let go
  const stickFired = await waitState('playing', 60000).then(() => true, () => false);
  const stickShot = await page.evaluate(() => ({ side: window._game._slingRun.side, pull: window._game._slingRun.pull, speed: window._game.bike.speed, max: window._game._slingStats.launchMax }));
  check(stickHeld.pull > 0.9 && stickFired && stickShot.pull > 0.9 && Math.abs(stickShot.side - stickAim.side) < 0.01 && stickShot.speed > stickShot.max * 0.85,
    `left stick: pull back, let go → fires with the held aim (pull ${stickShot.pull.toFixed(2)}, side ${stickShot.side.toFixed(2)}, ${stickShot.speed.toFixed(1)} m/s)`);

  // Easing the stick back slowly is a change of mind, not a shot.
  await toSlingshot(false);
  for (const ay of [1, 0.65, 0.4, 0.262, 0]) {               // pull 1 → 0.6 → 0.31 → 0.14 → home
    await page.evaluate((ay) => { window.__pad.axes = [0, ay]; }, ay);
    await new Promise(r => setTimeout(r, 2200));             // several frames at each step
  }
  const eased = await measure();
  check(eased.state === 'slingAim' && eased.pull === 0, 'left stick: easing it back slowly cancels (bands slack, no launch)');
  await page.evaluate(() => { delete window._game.input.getGamepadState; });
}

await suite('portrait', { width: 390, height: 844 });
await suite('landscape', { width: 844, height: 390 });
check(errors.length === 0, `no page errors (${errors.length})`);
await browser.close(); server.close();
const ok = checks.every(Boolean);
console.log(ok ? '✔ slingshot aim acceptance passed' : '✖ slingshot aim acceptance FAILED');
process.exit(ok ? 0 : 1);
