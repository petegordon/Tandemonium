// smoke:host-room · the online room is merged into the captain's host step (2026-10-23).
// Online (captain + partner over a fake net), local (Player 2 in the stoker seat) at
// 1920x1080 with the desktop-app user agent, and the phone captain layout.
// Screenshots go to the OS temp folder (tandemonium-host-room/).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';
const ROOT = process.cwd();
const require = createRequire(ROOT + '/package.json');
const puppeteer = require('puppeteer');
const OUT = path.join(os.tmpdir(), 'tandemonium-host-room'); fs.mkdirSync(OUT, { recursive: true });
const PORT = 8951;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.json': 'application/json', '.webp': 'image/webp' };
const server = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  fs.stat(f, (e, st) => { if (e || st.isDirectory()) return r.writeHead(404).end(); r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }); });
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tandemonium/1.0 Chrome/130 Electron/33 Safari/537.36';
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const errors = [];
const results = [];
const check = (ok, name, detail) => { results.push(ok); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function open({ phone = false } = {}) {
  const page = await browser.newPage();
  if (phone) { await page.setUserAgent(PHONE_UA); await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); }
  else { await page.setUserAgent(ELECTRON_UA); await page.setViewport({ width: 1920, height: 1080 }); }
  await page.setRequestInterception(true);
  page.on('request', (req) => { const u = req.url(); if (u.startsWith(`http://127.0.0.1:${PORT}`)) return req.continue();
    let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
    if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
    m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]);
    if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
    return req.abort(); });
  page.on('pageerror', e => { errors.push(e.message); console.log('  PAGEERROR:', e.message); });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tandemonium_started', '1'); } catch {} });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('tap-to-start')?.click());
  await sleep(1500);
  return page;
}

/** Wire two pages together with a fake net (as smoke-tourist-coop does). */
async function link(cap, sto) {
  for (const [role, page, other] of [['captain', cap, sto], ['stoker', sto, cap]]) {
    await page.exposeFunction('__relay', (kind, json) => {
      other.evaluate((kind, msg) => { const n = window.__fakeNet; if (kind === 'profile' && n && n.onProfileReceived) n.onProfileReceived(msg); }, kind, JSON.parse(json)).catch(() => {});
    });
    await page.evaluate((role) => {
      const l = window._game.lobby;
      const net = {
        connected: false, roomCode: 'TNDM-TSTX', transport: 'relay', audioEnabled: false, _localMediaStream: null,
        sendProfile: (p) => window.__relay('profile', JSON.stringify(p)), sendEvent() {},
        sendState() {}, sendLean() {}, sendPedal() {}, getQualityStats: () => null,
        destroy() { window.__netDestroyed = (window.__netDestroyed || 0) + 1; this.connected = false; },
        acquireLocalMedia: async () => {}, getRemoteStream: () => null,
      };
      window.__fakeNet = net;
      l.net = net;
      l._roomRole = role;
      l._pendingMode = 'multiplayer';
    }, role);
  }
}

const state = (page) => page.evaluate(() => {
  const l = window._game.lobby;
  const name = (s) => s === l.hostStep ? 'host' : s === l.levelStep ? 'level' : s === l.roleStep ? 'role' : s === l.modeStep ? 'mode' : s === l.joinStep ? 'join' : (s && s.id) || String(s);
  const on = document.getElementById('btn-host-online-next'), loc = document.getElementById('btn-host-local-next');
  const sto = document.getElementById('host-seat-stoker');
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const wait = document.getElementById('level-wait-text');
  return {
    step: name(l._currentStep), mode: l._pendingMode, role: l._roomRole,
    onlineDisabled: on ? on.disabled : null, localDisabled: loc ? loc.disabled : null,
    onlineRect: r(on), localRect: r(loc),
    hostClass: l.hostStep.className, seatWho: sto && sto.who, seatDev: sto && sto.dev, seatState: sto && sto.state,
    status: document.getElementById('host-status')?.textContent,
    waitShown: !!wait && getComputedStyle(wait).display !== 'none', waitText: wait && wait.textContent,
    startShown: getComputedStyle(document.getElementById('btn-start-ride')).display !== 'none',
    focused: document.querySelector('.uf-focus, .focused, [data-focused]')?.id || null,
    roomEl: !!document.getElementById('lobby-room'),
    p2: !!l._localP2InputManager, seated: !!l._localSeatedOnHost,
    netDestroyed: window.__netDestroyed || 0,
  };
});
const shot = (page, n) => page.screenshot({ path: path.join(OUT, n + '.png') });

// ── Online: captain + partner on their own device ──
console.log('ONLINE');
const cap = await open(), sto = await open();
await link(cap, sto);
await cap.evaluate(() => { const l = window._game.lobby; document.getElementById('room-code-display').textContent = 'TNDM-TSTX'; l._showStep(l.hostStep); l._refreshHostNext(); });
await sleep(500);
let c = await state(cap);
check(!c.roomEl, 'the room step is gone from the page');
check(c.step === 'host' && c.onlineDisabled === true && c.localDisabled === true, 'host step before anyone joins: both CHOOSE LEVEL disabled', c);
await shot(cap, '1-host-waiting');

// The partner connects.
for (const p of [cap, sto]) await p.evaluate(() => { window.__fakeNet.connected = true; });
await sto.evaluate(() => { window._game.lobby._showRoomStep('stoker'); });
await cap.evaluate(() => { window._game.lobby._showRoomStep('captain'); });
await sleep(800);
c = await state(cap); let s = await state(sto);
check(c.step === 'host' && c.onlineDisabled === false && c.localDisabled === true && /host-online-on/.test(c.hostClass), 'captain stays on the host step; Online CHOOSE LEVEL enabled, Local dimmed', c);
check(c.seatState === 'joined' && c.seatDev === 'Online', 'the stoker seat shows the online partner', { who: c.seatWho, dev: c.seatDev });
check(s.step === 'level' && s.waitShown && !s.startShown, 'stoker goes straight to level select, waiting for the captain', s);
await shot(cap, '2-host-partner-connected');
await shot(sto, '2-stoker-waiting');

// Local presses are ignored while the online partner holds the seat.
await cap.evaluate(() => window._game.lobby._onLocalJoinClick('keyboard', null));
c = await state(cap);
check(!c.p2 && c.step === 'host', 'a local join is ignored while the online partner is seated', c);

// CHOOSE LEVEL.
await cap.evaluate(() => document.getElementById('btn-host-online-next').click());
await sleep(600);
c = await state(cap); s = await state(sto);
check(c.step === 'level' && c.startShown && s.step === 'level' && s.waitShown, 'Online CHOOSE LEVEL: captain picks, stoker waits', { cap: c.step, sto: s.step, stoWait: s.waitShown });
await shot(cap, '3-captain-levels');

// Captain backs out of level select: back to the host step, partner still shown; stoker stays waiting.
await cap.evaluate(() => document.getElementById('btn-back-level').click());
await sleep(600);
c = await state(cap); s = await state(sto);
check(c.step === 'host' && c.onlineDisabled === false && c.seatState === 'joined', 'captain Back from levels: host step, partner still connected', c);
check(s.step === 'level' && s.waitShown, 'stoker stays on level select (waiting) when the captain goes back', s);

// After a ride together: both land on level select.
await cap.evaluate(() => { const l = window._game.lobby; l._hideLobby && l._hideLobby(); l.showRoom(window.__fakeNet, 'captain'); });
await sto.evaluate(() => { const l = window._game.lobby; l._hideLobby && l._hideLobby(); l.showRoom(window.__fakeNet, 'stoker'); });
await sleep(800);
c = await state(cap); s = await state(sto);
check(c.step === 'level' && c.startShown && s.step === 'level' && s.waitShown, 'after a ride: captain on level select, stoker waiting', { cap: c.step, sto: s.step });

// Stoker backs out: leaves the ride.
await sto.evaluate(() => document.getElementById('btn-back-level').click());
await sleep(500);
s = await state(sto);
check(s.step === 'role' && s.netDestroyed >= 1, 'stoker Back from level select leaves the room', s);
await cap.close(); await sto.close();

// ── Local: a second controller on this screen ──
console.log('LOCAL');
const loc = await open();
await loc.evaluate(() => { const l = window._game.lobby; document.getElementById('room-code-display').textContent = 'TNDM-LOCL'; l._pendingMode = 'multiplayer'; l._roomRole = 'captain'; l._showStep(l.hostStep); l._refreshHostNext(); });
await sleep(400);
await loc.evaluate(() => window._game.lobby._onLocalJoinClick('keyboard', null));
await sleep(500);
let L = await state(loc);
check(L.step === 'host' && L.p2 && L.seated && L.localDisabled === false && L.onlineDisabled === true && /host-local-on/.test(L.hostClass), 'local Player 2 sits in the stoker seat; Local CHOOSE LEVEL enabled, Online dimmed', L);
check(L.seatState === 'joined' && L.seatWho === 'Keyboard', 'the stoker seat shows Player 2', { who: L.seatWho });
await shot(loc, '4-host-local-seated');
await loc.evaluate(() => window._game.lobby._onLocalJoinClick('keyboard', null));   // a second press: still one Player 2
await loc.evaluate(() => document.getElementById('btn-host-local-next').click());
await sleep(600);
L = await state(loc);
check(L.step === 'level' && L.mode === 'local' && L.p2, 'Local CHOOSE LEVEL: level select in local co-op', L);
await loc.evaluate(() => document.getElementById('btn-back-level').click());
await sleep(500);
L = await state(loc);
check(L.step === 'host' && L.p2 && L.localDisabled === false, 'Back from levels: host step with Player 2 still seated', L);
await loc.evaluate(() => document.getElementById('btn-back-role-host').click());
await sleep(500);
L = await state(loc);
check(L.step === 'role' && !L.p2 && !L.seated, 'Back from the host step releases Player 2', L);
await loc.close();

// ── Phone: captain layout (no local column) ──
console.log('PHONE');
const ph = await open({ phone: true });
const ph2 = await open({ phone: true });
await link(ph, ph2);
await ph.evaluate(() => { const l = window._game.lobby; document.getElementById('room-code-display').textContent = 'TNDM-PHNE'; l._showStep(l.hostStep); l._refreshHostNext(); });
await sleep(400);
for (const p of [ph, ph2]) await p.evaluate(() => { window.__fakeNet.connected = true; });
await ph.evaluate(() => window._game.lobby._showRoomStep('captain'));
await sleep(600);
const P = await state(ph);
const vis = (r) => !!r && r.w > 0 && r.h > 0 && r.y + r.h <= 844 && r.x >= 0 && r.x + r.w <= 390;
check(P.step === 'host' && P.onlineDisabled === false && vis(P.onlineRect), 'phone captain: CHOOSE LEVEL enabled and on screen', P.onlineRect);
check(!P.localRect || P.localRect.w === 0, 'phone: no Local button', P.localRect);
await shot(ph, '5-phone-host-connected');
await ph.close(); await ph2.close();

console.log(errors.length ? `page errors: ${errors.length}` : 'no page errors');
const pass = results.every(Boolean) && !errors.length;
console.log(pass ? 'room merge flow: all checks passed' : 'room merge flow: FAILED');
await browser.close(); server.close();
process.exit(pass ? 0 : 1);
