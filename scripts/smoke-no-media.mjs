#!/usr/bin/env node
// ============================================================
// smoke-no-media.mjs — room camera/mic stays off by default (#400 D7)
// ============================================================
//
// Multiplayer stays in the demo; only the room's camera + microphone (WebRTC
// media) goes behind ?media=1. This drives the real game in headless Chrome:
//
//   boot → lobby (press ALL) → SOLO → Grandma's ride → SAVE CLIP → back to the
//   lobby → RIDE TOGETHER → START A RIDE (room created) → transport probes
//
// and counts every navigator.mediaDevices.getUserMedia / enumerateDevices call
// and every PeerJS peer.call(). Without ?media=1 all of them must be zero, the
// camera/audio toggles hidden, and an incoming media call closed unanswered.
// A second pass with ?media=1 checks the feature is still there when asked for.
//
// No network needed: the relay WebSocket and PeerJS are stubbed in the page
// (a fake relay that opens immediately, a fake Peer that counts .call()), so
// "room created" means the lobby reached "Waiting for partner…" with a code —
// a real two-browser co-op ride is NOT exercised here.
//
//   node scripts/smoke-no-media.mjs            # both passes
//   node scripts/smoke-no-media.mjs --no-ride  # skip the solo ride + clip

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 8913);
const WANT_RIDE = !process.argv.includes('--no-ride');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio']
});

// Installed before any page script: counts media calls, fakes the relay and
// PeerJS so a room can be created with no network.
function instrument() {
  const m = window.__media = { gum: 0, enumerate: 0, legacyGum: 0, peerCalls: 0, relayOpens: 0 };
  const md = navigator.mediaDevices;
  if (md) {
    md.getUserMedia = () => { m.gum++; return Promise.reject(new DOMException('blocked by smoke', 'NotAllowedError')); };
    md.enumerateDevices = () => {
      m.enumerate++;
      return Promise.resolve([{ kind: 'videoinput', deviceId: 'cam' }, { kind: 'audioinput', deviceId: 'mic' }]);
    };
  }
  for (const k of ['getUserMedia', 'webkitGetUserMedia']) {
    try { navigator[k] = function () { m.legacyGum++; }; } catch (e) { /* read-only */ }
  }

  // Fake relay: opens straight away, swallows sends.
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (!/tandemonium-relay/.test(String(url))) return new RealWS(url, protocols);
    const ws = { url, readyState: 0, binaryType: 'blob', bufferedAmount: 0,
      send() {}, close() { ws.readyState = 3; ws.onclose && ws.onclose({ code: 1000 }); },
      addEventListener() {}, removeEventListener() {} };
    setTimeout(() => { ws.readyState = 1; m.relayOpens++; ws.onopen && ws.onopen({}); }, 50);
    return ws;
  };
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  // Fake PeerJS (the real CDN script is blocked below).
  window.Peer = class FakePeer {
    constructor(id) { this.id = id || 'fake-peer'; this._h = {}; this.destroyed = false; }
    on(ev, fn) { this._h[ev] = fn; return this; }
    connect(peer) { return { peer, on() {}, send() {}, close() {}, open: false }; }
    call(peer) { m.peerCalls++; return { peer, on() {}, close() {}, answer() {} }; }
    destroy() { this.destroyed = true; }
  };
}

const LOCAL = [
  [/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/build\/three\.module\.js/, 'node_modules/three/build/three.module.js'],
  [/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/examples\/jsm\/(.+)$/, 'node_modules/three/examples/jsm/$1']
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runPass(media) {
  const label = media ? '?media=1' : 'default (media off)';
  console.log(`\n=== pass: ${label} ===`);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(instrument);
  // SOLO must open the level list, not the first-run tutorial auto-start.
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tandemonium_tutorial_done', 'smoke'); } catch {} });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(`http://127.0.0.1:${PORT}`)) return req.continue();
    for (const [re, target] of LOCAL) {
      const mm = u.match(re);
      if (mm) {
        const file = path.join(ROOT, target.includes('$1') ? target.replace('$1', mm[1]) : target);
        if (fs.existsSync(file)) {
          return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(file) });
        }
      }
    }
    return req.abort();
  });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));

  const fails = [];
  const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };
  const counts = () => page.evaluate(() => ({ ...window.__media }));

  await page.goto(`http://127.0.0.1:${PORT}/index.html${media ? '?media=1' : ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 45000 });
  await page.click('#tap-to-start').catch(() => {});
  await page.waitForFunction(() => {
    const b = document.getElementById('btn-solo'); return b && b.offsetParent !== null;
  }, { timeout: 20000 });
  await sleep(500);

  // ── lobby toggles ──
  const vis = await page.evaluate(() => {
    const shown = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
    return { camera: shown('toggle-camera'), audio: shown('toggle-audio'), all: shown('toggle-all') };
  });
  check(vis.camera === media, `camera toggle ${media ? 'visible' : 'hidden'} (${vis.camera})`);
  check(vis.audio === media, `audio toggle ${media ? 'visible' : 'hidden'} (${vis.audio})`);
  check(vis.all, 'ALL toggle still shown (covers motion + music)');

  // Press ALL like a player would — with media on this is what prompts.
  // Music starts on, so with media off ALL begins "all on" and flips it off.
  const allState = () => page.evaluate(() => ({
    music: window._game.lobby.musicActive,
    allActive: document.getElementById('toggle-all').classList.contains('active')
  }));
  const before = await allState();
  if (!media) check(before.allActive === before.music, `ALL active tracks music+motion only (${JSON.stringify(before)})`);
  await page.evaluate(() => document.getElementById('toggle-all').click());
  await sleep(400);
  const once = await allState();
  if (!media) check(once.music !== before.music && once.allActive === once.music, `ALL flips music (${JSON.stringify(once)})`);
  await page.evaluate(() => document.getElementById('toggle-all').click());
  await sleep(400);
  const twice = await allState();
  if (!media) check(twice.music === before.music && twice.allActive === twice.music, `ALL again restores it (${JSON.stringify(twice)})`);
  // leave music on (as a player normally would)
  if (!twice.music) { await page.evaluate(() => window._game.lobby._toggleMusic()); }

  // ── solo ride + clip ──
  if (WANT_RIDE) {
    await page.evaluate(() => document.getElementById('btn-solo').click());
    await sleep(900);
    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('button, .level-card, [class*="level"]'))
        .filter(el => el.offsetParent !== null && /grandma/i.test(el.textContent || ''));
      (cards[0] || document.querySelector('.level-card'))?.click();
    });
    await sleep(500);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /start ride/i.test(x.textContent || '') && x.offsetParent !== null);
      b && b.click();
    });
    await sleep(800);
    await page.evaluate(() => { document.body.click(); document.getElementById('instructions')?.click(); });
    let riding = true;
    await page.waitForFunction(() => window._game?.state === 'playing', { timeout: 120000 }).catch(() => { riding = false; });
    check(riding, 'solo ride reached playing');
    if (riding) {
      await page.keyboard.press('ArrowLeft'); await sleep(150); await page.keyboard.press('ArrowRight');
      await sleep(3000);
      const pip = await page.evaluate(() => {
        const shown = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
        return { selfie: shown('selfie-pip-wrap'), partner: shown('partner-pip-wrap'),
          selfieActive: window._game.recorder.selfieActive, supported: window._game.recorder.supported,
          buffering: window._game.recorder.buffering };
      });
      if (!media) {
        check(!pip.selfie && !pip.partner, `selfie/partner PiP frames hidden in ride (selfie=${pip.selfie} partner=${pip.partner})`);
        check(!pip.selfieActive, 'no selfie camera in the ride');
      }
      if (!pip.supported || !pip.buffering) {
        // Swiftshader trips the recorder's low-end GPU probe, which disables
        // clips. Force the standard MediaRecorder path exactly as the ride
        // start does, so the SAVE CLIP pipeline still runs headlessly.
        await page.evaluate(async () => {
          const g = window._game, r = g.recorder;
          r.supported = r._checkSupport(); r._gpuProbe = Promise.resolve();
          if (r.supported) await r.startBuffer(g.audioCtx, g.lobby.audioActive, g.audioEngine);
        });
        await sleep(4000);
        Object.assign(pip, await page.evaluate(() => ({ supported: window._game.recorder.supported, buffering: window._game.recorder.buffering })));
        console.log(`  note recorder forced on (headless low-end probe): supported=${pip.supported} buffering=${pip.buffering}`);
      }
      if (pip.supported && pip.buffering) {
        const tracks = await page.evaluate(() => {
          const r = window._game.recorder;
          return { mic: !!r._micStream, partner: !!r.partnerStream, selfie: !!r.selfieStream };
        });
        if (!media) check(!tracks.mic && !tracks.partner && !tracks.selfie, `clip sources are game only (${JSON.stringify(tracks)})`);
        await page.evaluate(() => window._game.recorder.saveClip());
        let clip = true;
        await page.waitForFunction(() => !!window._game.recorder._clipBlob ||
          document.getElementById('clip-preview-modal')?.classList.contains('visible'), { timeout: 30000 }).catch(() => { clip = false; });
        const size = await page.evaluate(() => window._game.recorder._clipBlob?.size || 0);
        check(clip && size > 0, `SAVE CLIP produced a clip (${size} bytes)`);
        await page.evaluate(() => window._game.recorder._discardClip?.());
      } else {
        console.log(`  skip SAVE CLIP — recorder not buffering headlessly (supported=${pip.supported}, buffering=${pip.buffering})`);
      }
    }
    await page.evaluate(() => window._game._returnToLobby());
    await page.waitForFunction(() => {
      const b = document.getElementById('btn-together'); return b && b.offsetParent !== null;
    }, { timeout: 20000 }).catch(() => {});
  }

  // ── RIDE TOGETHER → START A RIDE ──
  await page.evaluate(() => document.getElementById('btn-together').click());
  await page.waitForFunction(() => {
    const b = document.getElementById('btn-captain'); return b && b.offsetParent !== null;
  }, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('btn-captain').click());
  let roomUp = true;
  await page.waitForFunction(() => /waiting for partner/i.test(document.getElementById('host-status')?.textContent || ''),
    { timeout: 20000 }).catch(() => { roomUp = false; });
  const room = await page.evaluate(() => ({
    code: document.getElementById('room-code-display')?.textContent,
    status: document.getElementById('host-status')?.textContent,
    mediaEnabled: window._game.lobby.net?.mediaEnabled
  }));
  check(roomUp && /^[A-Z0-9-]{4,}$/.test(room.code || ''), `START A RIDE created a room (code=${room.code}, status="${room.status}")`);
  check(room.mediaEnabled === media, `room transport mediaEnabled=${room.mediaEnabled}`);

  // ── transport probes: what happens once P2P is up ──
  const probe = await page.evaluate(async () => {
    const net = window._game.lobby.net;
    if (!net) return null;
    const savedPeer = net.peer, savedConn = net.conn;
    net.peer = new window.Peer('probe');
    net.conn = { peer: 'remote-peer', close() {} };
    net.initiateCall();
    const incoming = { closed: false, answered: false, on() {}, close() { this.closed = true; }, answer() { this.answered = true; } };
    net._handleIncomingCall(incoming);
    await net.acquireLocalMedia(true, true);
    const r = { closed: incoming.closed, answered: incoming.answered, hasLocalStream: !!net._localMediaStream };
    if (net._mediaCall) { try { net._mediaCall.close(); } catch (e) {} net._mediaCall = null; }
    net.peer = savedPeer; net.conn = savedConn;
    return r;
  });
  const c = await counts();
  console.log(`  counts: ${JSON.stringify(c)}`);
  if (!media) {
    check(probe && probe.closed && !probe.answered, `incoming media call closed, not answered (${JSON.stringify(probe)})`);
    check(c.peerCalls === 0, `peer.call never called (${c.peerCalls})`);
    check(c.gum === 0 && c.legacyGum === 0, `getUserMedia never called (${c.gum}/${c.legacyGum})`);
    check(c.enumerate === 0, `enumerateDevices never called (${c.enumerate})`);
  } else {
    check(probe && probe.answered && !probe.closed, `incoming media call answered (${JSON.stringify(probe)})`);
    check(c.peerCalls >= 1, `peer.call placed (${c.peerCalls})`);
    check(c.enumerate >= 1, `enumerateDevices used for the camera check (${c.enumerate})`);
    check(c.gum >= 1, `getUserMedia requested when ALL pressed (${c.gum})`);
  }
  if (pageErrors.length) console.log('  page errors (not failing):\n    ' + pageErrors.slice(0, 5).join('\n    '));
  await page.close();
  return fails;
}

let fails = [];
try {
  fails = fails.concat((await runPass(false)).map(f => `[media off] ${f}`));
  fails = fails.concat((await runPass(true)).map(f => `[?media=1] ${f}`));
} finally {
  await browser.close();
  server.close();
}
if (fails.length) {
  console.log(`\nFAILED (${fails.length}):\n  ` + fails.join('\n  '));
  process.exit(1);
}
console.log('\nsmoke-no-media: all checks passed');
