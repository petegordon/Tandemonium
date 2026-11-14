#!/usr/bin/env node
// bike-ladder.mjs — stills of every bike on the chooser's pedestal for the Road to Gold Standard ladder image.
// Each bike is shot from the game's own bike chooser (stage lights, pedestal, outfit geese beside it), the
// preview turned to one fixed angle and rendered once at plate size.
//   node scripts/reel/bike-ladder.mjs                     every bike -> assets/ladder/plates/<key>.png
//   node scripts/reel/bike-ladder.mjs default,time_warp   just these
//   ANGLES=0,0.8,1.6 node scripts/reel/bike-ladder.mjs default   angle test sheet (<key>@<angle>.png)
// Special bikes are shot twice: <key>.png earned (in colour) and <key>_locked.png (the chooser's silhouette).
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, sleep } from '../lib/smoke-harness.mjs';

const OUT = process.env.OUT || path.join(process.cwd(), 'assets', 'ladder', 'plates');
const W = Number(process.env.W || 1200), H = Number(process.env.H || 900);
const ANGLE = Number(process.env.ANGLE || 0.75);
const ANGLES = process.env.ANGLES ? process.env.ANGLES.split(',').map(Number) : null;
const PULL = Number(process.env.PULL || 0.66), ZOOM = Number(process.env.ZOOM || 1.3);
const SETTLE = Number(process.env.SETTLE || 5000);
fs.mkdirSync(OUT, { recursive: true });

const h = await startHarness({ port: 8987 });
const page = await h.gamePage({ viewport: { width: 1600, height: 900 },
  storage: { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on' } });
await page.waitForFunction(() => window._game?.lobby?._presetKeys?.length > 4 && !!window._game.lobby._previewModel, { timeout: 180000 });

const keys = await page.evaluate(() => window._game.lobby._presetKeys.slice());
const want = process.argv[2] ? process.argv[2].split(',') : keys;
console.log('chooser keys:', keys.join(', '));

/** earn every achievement (all = true) or none, so bikes show earned or locked */
const setEarned = (all) => page.evaluate(async (all) => {
  const { ACHIEVEMENTS } = await import('/js/achievements.js');
  const ach = window._game.lobby._achievements;
  ach._earned = new Map(all ? ACHIEVEMENTS.map(a => [a.id, { id: a.id, earnedAt: 1 }]) : []);
}, all);

async function show(key) {
  await page.evaluate((key) => {
    const l = window._game.lobby;
    l._stopChooserAttract?.();
    l._presetIndex = l._presetKeys.indexOf(key);
    l._applyPresetToPreview();
  }, key);
  await page.waitForFunction((key) => {
    const l = window._game.lobby, sp = (l._specialPreviews || {})[key];
    if (sp) return !!(sp.model && sp.model.visible) && (!sp.stand || sp.actors?.length > 0);
    return !!l._previewModel && l._previewModel.visible;
  }, { timeout: 120000 }, key).catch(() => console.warn('  (timed out waiting for', key, ')'));
  await sleep(SETTLE);   // geese walk out + textures land
}

async function grab(file, angle) {
  const info = await page.evaluate(({ w, h, angle, pull, zoom }) => {
    const l = window._game.lobby, r = l._previewRenderer, cam = l._previewCamera;
    const name = document.getElementById('bike-name').textContent.trim();
    const hint = (document.getElementById('bike-hint')?.textContent || '').replace(/\s+/g, ' ').trim();
    const old = { pr: r.getPixelRatio(), aspect: cam.aspect, fov: cam.fov };
    const cv = r.domElement, ow = cv.width, oh = cv.height;
    if (l._previewPivot) l._previewPivot.rotation.y = angle;
    // a bike with its outfit geese: pull the geese in toward the pedestal and close the camera in, so the
    // bike reads at the same size as a bike shot alone (the chooser spreads them for its wide box)
    const sp = (l._specialPreviews || {})[l._presetKeys[l._presetIndex]];
    const tight = !!(sp && sp.stand && sp.stand.children.length);
    const moved = [];
    if (tight) for (const c of sp.stand.children) { moved.push([c, c.position.x]); c.position.x *= pull; }
    if (tight) cam.fov = old.fov / zoom;
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
    r.render(l._previewScene, cam);
    const url = cv.toDataURL('image/png');
    for (const [c, x] of moved) c.position.x = x;
    r.setSize(ow, oh, false);
    cam.aspect = old.aspect; cam.fov = old.fov; cam.updateProjectionMatrix();
    r.setPixelRatio(old.pr);
    return { name, hint, url, tight };
  }, { w: W, h: H, angle, pull: PULL, zoom: ZOOM });
  fs.writeFileSync(file, Buffer.from(info.url.split(',')[1], 'base64'));
  console.log('  ->', path.basename(file), '|', info.name, info.hint ? '| ' + info.hint : '');
  return info;
}

const metaFile = path.join(OUT, 'meta.json');
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};   // a partial run keeps the other bikes
const SPECIAL = new Set(['solo_flight', 'time_warp', 'gold_standard']);
for (const key of want) {
  if (!keys.includes(key)) { console.warn('no such bike', key); continue; }
  console.log(key);
  await setEarned(true);
  await show(key);
  if (ANGLES) { for (const a of ANGLES) await grab(path.join(OUT, `${key}@${a}.png`), a); continue; }
  meta[key] = (({ name, hint }) => ({ name, hint }))(await grab(path.join(OUT, `${key}.png`), ANGLE));
  if (SPECIAL.has(key)) {
    await setEarned(false);
    await show(key);
    meta[key + '_locked'] = (({ name, hint }) => ({ name, hint }))(await grab(path.join(OUT, `${key}_locked.png`), ANGLE));
  }
}
if (!ANGLES) fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
await h.finish();
