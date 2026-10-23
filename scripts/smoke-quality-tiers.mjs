#!/usr/bin/env node
// smoke-quality-tiers.mjs — the High / Medium / Low quality tiers in a real
// browser: what each boots with, switching live from Options, the one-time
// move of an old two-tier "Low" to Medium, and Low's riders default.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = process.cwd(); const PORT = 8936;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.json':'application/json' };
const server = http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
  fs.stat(f,(e,st)=>{if(e||st.isDirectory())return res.writeHead(404).end();res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser = await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});

let failed = 0;
const check = (ok, label, extra) => { console.log(`  ${ok ? 'ok ' : 'FAIL'} ${label}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); if (!ok) failed++; };

async function boot({ query = '', storage = {} } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
    let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
    if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
    m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
    if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
    return req.abort();});
  page.on('pageerror', (e) => console.log('   pageerror:', String(e).slice(0, 160)));
  // Seed storage once per tab; a reload (Display Testing) keeps what the page saved.
  await page.evaluateOnNewDocument((s) => { try { if (sessionStorage.getItem('smoke_seeded')) return; sessionStorage.setItem('smoke_seeded', '1'); localStorage.clear(); localStorage.setItem('tandemonium_tutorial_done', 'smoke'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch {} }, storage);
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window._game, { timeout: 60000 });
  await page.waitForFunction(() => window._game.world._treeModelReady, { timeout: 60000 });
  return page;
}

const state = (page) => page.evaluate(() => {
  const G = window._game, W = G.world;
  return {
    tier: G._quality, auto: G._qualityAuto, low: G._lowQuality, riders: G._showRiders,
    ratio: G.renderer.getPixelRatio(), shadows: G.renderer.shadowMap.enabled,
    far: G.camera.far, fog: G.scene.fog.density,
    treeBatch: !!W._treeBatch, treesInScene: W._treePool.filter((t) => t.mesh.parent === G.scene).length,
    cloudsMerged: W._cloudPool.every((c) => c.group.children.length === 1),
    pref: localStorage.getItem('tandemonium_quality'),
    active: ['high', 'medium', 'low', 'auto'].filter((t) => document.getElementById('opt-' + t)?.classList.contains('active')),
    autoLabel: document.getElementById('opt-auto')?.textContent,
  };
});

console.log('?quality=low boots the new Low');
{
  const page = await boot({ query: '?quality=low' });
  const s = await state(page);
  check(s.tier === 'low' && s.low, 'tier is Low (and does everything the old Low did)', s.tier);
  check(!s.riders, 'riders default off on Low');
  check(s.ratio <= 1 && !s.shadows, 'reduced resolution, no shadows', { ratio: s.ratio, shadows: s.shadows });
  check(s.treeBatch && s.treesInScene === 0, 'trees drawn as one batch');
  check(s.cloudsMerged, 'each cloud is one merged mesh (every tier)');
  check(s.far === 220 && s.fog === 0.012, 'shorter view distance + closer fog', { far: s.far, fog: s.fog });
  await page.close();
}

console.log('A saved two-tier "Low" becomes Medium');
{
  const page = await boot({ storage: { tandemonium_quality: 'low' } });
  const s = await state(page);
  check(s.tier === 'medium' && s.pref === 'medium', 'old Low → Medium', { tier: s.tier, pref: s.pref });
  check(s.riders && !s.treeBatch && s.cloudsMerged && s.ratio === 0.5, 'Medium = the old Low: riders kept, half resolution, trees as before, clouds merged', s);
  await page.close();
}

console.log('Explicit High, then switching live in Options');
{
  const page = await boot({ storage: { tandemonium_quality: 'high', tandemonium_quality_v: '3' } });
  let s = await state(page);
  check(s.tier === 'high' && !s.low && s.riders, 'High boots High with riders', { tier: s.tier, riders: s.riders });
  check(s.cloudsMerged, 'clouds are merged on High too');
  await page.evaluate(() => window._game._openOptions());
  await page.evaluate(() => document.getElementById('opt-low').click());
  await page.waitForFunction(() => !window._game._showRiders, { timeout: 30000 }).catch(() => {});
  s = await state(page);
  check(s.tier === 'low' && s.pref === 'low', 'Options → Low applies and saves', { tier: s.tier, pref: s.pref });
  check(s.treeBatch && s.far === 220, 'trees batched, view shortened — live');
  check(!s.riders, 'riders swap off in the lobby');
  check(s.active.join() === 'low', 'only Low is highlighted', s.active);
  await page.evaluate(() => document.getElementById('opt-medium').click());
  await page.waitForFunction(() => window._game._showRiders, { timeout: 30000 }).catch(() => {});
  s = await state(page);
  check(s.tier === 'medium' && !s.treeBatch && s.treesInScene > 0 && s.cloudsMerged && s.far === 500, 'Options → Medium restores trees and view (clouds stay merged)', s);
  check(s.riders, 'riders come back above Low');
  await page.evaluate(() => document.getElementById('opt-auto').click());
  s = await state(page);
  check(s.pref === 'auto' && s.auto && /^Auto \(/.test(s.autoLabel), 'Auto says what it picked', s.autoLabel);
  await page.close();
}

console.log('An explicit Show Riders choice wins on Low');
{
  const page = await boot({ query: '?quality=low', storage: { tandemonium_show_riders: 'on' } });
  const s = await state(page);
  check(s.tier === 'low' && s.riders, 'Low + Show Riders on = riders on', { tier: s.tier, riders: s.riders });
  await page.close();
}

console.log('Medium → High live: the ground really gets shadows');
{
  const page = await boot({ storage: { tandemonium_quality: 'medium', tandemonium_quality_v: '3' } });
  const shadowed = () => page.evaluate(() => {
    const G = window._game, p = G.renderer.properties.get(G.world.floor.material).currentProgram;
    return !!(p && p.getUniforms().map.directionalShadowMap);
  });
  const before = await shadowed();
  await page.evaluate(() => { window._game._openOptions(); document.getElementById('opt-high').click(); window._game._closeOptions(); });
  await new Promise((r) => setTimeout(r, 1500));
  const after = await shadowed();
  check(!before && after, 'switching to High recompiles the ground with shadows', { before, after });
  await page.close();
}

console.log('Low keeps its 360-line target when the window is resized');
{
  const page = await boot({ query: '?quality=low' });
  await page.setViewport({ width: 1280, height: 900 });
  await page.waitForFunction(() => innerHeight === 900, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 300));
  const r = await page.evaluate(() => ({ ratio: window._game.renderer.getPixelRatio(), h: innerHeight }));
  check(Math.abs(r.ratio * r.h - 360) < 1, 'resize recomputes the render resolution', r);
  await page.close();
}

console.log('TV test switches: ?lines= and ?aa=');
{
  const page = await boot({ query: '?quality=low&lines=540&aa=1' });
  const r = await page.evaluate(() => ({ ratio: window._game.renderer.getPixelRatio(), h: innerHeight, aa: window._game.renderer.getContext().getContextAttributes().antialias, tier: window._game._quality }));
  check(r.tier === 'low' && Math.abs(r.ratio * r.h - 540) < 1, '?lines=540 renders Low at 540 lines', r);
  check(r.aa === true, '?aa=1 turns edge smoothing on', r.aa);
  await page.close();
}

console.log('Display Testing in Options: overrides apply after a reload; Reset goes back to the tier');
{
  const page = await boot({ query: '?quality=medium' });
  const dstate = () => page.evaluate(() => ({
    lines: Math.round(window._game.renderer.getPixelRatio() * innerHeight),
    aa: window._game.renderer.getContext().getContextAttributes().antialias,
    readout: document.getElementById('perf-readout')?.textContent || '',
    tier: window._game._quality,
    url: location.search,
  }));
  const clickReload = async (id) => {
    await page.evaluate(() => window._game._openOptions());
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.evaluate((i) => document.getElementById(i).click(), id)]);
    await page.waitForFunction(() => window._game && window._game.world && window._game.world._treeModelReady, { timeout: 60000 });
  };
  await clickReload('opt-lines-720');
  let d = await dstate();
  check(d.lines === 720 && d.tier === 'medium' && !/lines=/.test(d.url), 'Render lines 720: reloads and renders 720 lines, tier unchanged', d);
  await clickReload('opt-aa-on');
  await clickReload('opt-perfhud-on');
  d = await dstate();
  check(d.aa === true && d.lines === 720, 'Edge smoothing On sticks with the lines override', d);
  check(/FPS/.test(d.readout) && /GPU/.test(d.readout) && /draws/.test(d.readout), 'perf readout shows FPS, GPU and draw calls', d.readout.split(String.fromCharCode(10))[0]);
  const notes = await page.evaluate(() => { window._game._openOptions(); return { q: document.getElementById('opt-quality-note').textContent, d: document.getElementById('opt-dtest-note').textContent, active: ['opt-lines-720', 'opt-aa-on', 'opt-perfhud-on'].every((i) => document.getElementById(i).classList.contains('active')) }; });
  check(/overrides are on/.test(notes.q) && /720 lines/.test(notes.d) && notes.active, 'Options says the overrides are on, under Graphics Quality too', notes);
  await clickReload('opt-dtest-reset');
  d = await dstate();
  check(d.lines === Math.round(0.5 * 720) && d.aa === false && !d.readout, 'Reset to quality defaults: back to Medium as it was', d);
  const stored = await page.evaluate(() => localStorage.getItem('tandemonium_display_test'));
  check(stored === null, 'Reset clears the saved overrides', stored);
  await page.close();
}

await browser.close(); server.close();
console.log(failed ? `\nquality tiers smoke: ${failed} FAILED` : '\nquality tiers smoke: all checks passed');
process.exit(failed ? 1 : 0);
