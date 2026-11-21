#!/usr/bin/env node
// ============================================================
// smoke-no-media.mjs — the room camera and microphone are gone
// ============================================================
//
// Tandemonium had a room camera + microphone (WebRTC media). It was switched
// off for every player by #400 D7 (only ?media=1 turned it on) and removed on
// 2026-11-20. This drives the real game in headless Chrome:
//
//   boot → lobby (press ALL) → SOLO → Grandma's ride → SAVE CLIP → back to the
//   lobby → RIDE TOGETHER → START A RIDE (room created) → an older build's
//   camera message and media call arrive
//
// and counts every navigator.mediaDevices.getUserMedia / enumerateDevices call,
// every camera / microphone permission query and every PeerJS peer.call(). All
// of them must be zero, no camera or microphone control may exist in the lobby
// or the room screen, and the media call must be closed unanswered. It runs
// twice, without and with ?media=1: an old link that still says media=1 must
// change nothing.
//
// No network needed: the relay WebSocket and PeerJS are stubbed in the page
// (a fake relay that opens immediately, a fake Peer that counts .call()), so
// "room created" means the lobby shows a code and is waiting for a partner —
// a real two-browser co-op ride is NOT exercised here (that is smoke:online).
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
  const m = window.__media = { gum: 0, enumerate: 0, legacyGum: 0, permissionQueries: 0, peerCalls: 0, relayOpens: 0 };
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
  // "granted", so code that only looks before asking would go on to ask.
  if (navigator.permissions && navigator.permissions.query) {
    const realQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => {
      if (d && (d.name === 'camera' || d.name === 'microphone')) { m.permissionQueries++; return Promise.resolve({ state: 'granted' }); }
      return realQuery(d);
    };
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

// Every camera / microphone control on the page, shown or not: a button-like
// element that says so in its id, title, label or text, any <video> but the
// saved clip's own player, and any <audio> made for a partner's voice. (The rider camera is a 3D camera drawn on
// a canvas, with no control of its own; the Options checkboxes are not buttons.)
function mediaControls() {
  const WORDS = /\b(camera|webcam|mic|microphone|video call|voice chat)\b/i;
  const found = [];
  for (const el of document.querySelectorAll('button, uf-button, uf-pill, [role="button"], .lobby-toggle')) {
    const says = [el.id, el.getAttribute('title'), el.getAttribute('aria-label'), el.getAttribute('label'), (el.textContent || '').trim().slice(0, 60)]
      .filter(Boolean).join(' | ').replace(/-/g, ' ');
    if (WORDS.test(says)) found.push(`${el.tagName.toLowerCase()}#${el.id || '?'} (${says.slice(0, 80)})`);
  }
  for (const v of document.querySelectorAll('video')) if (v.id !== 'clip-preview') found.push(`video#${v.id || '?'}`);
  for (const a of document.querySelectorAll('audio')) if (/partner|voice|remote/i.test(a.id)) found.push(`audio#${a.id}`);
  for (const id of ['toggle-camera', 'toggle-audio', 'partner-audio', 'selfie-pip', 'partner-pip', 'self-pip-wrap', 'partner-pip-wrap']) {
    if (document.getElementById(id)) found.push(`#${id}`);
  }
  return found;
}

const LOCAL = [
  [/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/build\/three\.module\.js/, 'node_modules/three/build/three.module.js'],
  [/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/examples\/jsm\/(.+)$/, 'node_modules/three/examples/jsm/$1']
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runPass(mediaParam) {
  const label = mediaParam ? '?media=1 (an old link)' : 'default';
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
  const noMediaYet = async (where) => {
    const c = await counts();
    check(c.gum === 0 && c.legacyGum === 0 && c.enumerate === 0 && c.permissionQueries === 0 && c.peerCalls === 0,
      `${where}: no camera/mic request of any kind (${JSON.stringify(c)})`);
  };

  await page.goto(`http://127.0.0.1:${PORT}/index.html${mediaParam ? '?media=1' : ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 45000 });
  await page.click('#tap-to-start').catch(() => {});
  await page.waitForFunction(() => {
    const b = document.getElementById('btn-solo'); return b && b.offsetParent !== null;
  }, { timeout: 20000 });
  await sleep(500);

  // ── lobby: no camera / microphone control, ALL is motion + music ──
  const lobbyControls = await page.evaluate(mediaControls);
  check(lobbyControls.length === 0, `lobby: no camera/mic control exists (${JSON.stringify(lobbyControls)})`);
  const allShown = await page.evaluate(() => { const el = document.getElementById('toggle-all'); return !!el && getComputedStyle(el).display !== 'none'; });
  check(allShown, 'ALL toggle still shown (covers motion + music)');

  // Press ALL like a player would. Music starts on, so ALL begins "all on" and flips it off.
  const allState = () => page.evaluate(() => ({
    music: window._game.lobby.musicActive,
    allActive: document.getElementById('toggle-all').classList.contains('active')
  }));
  const before = await allState();
  check(before.allActive === before.music, `ALL active tracks music+motion only (${JSON.stringify(before)})`);
  await page.evaluate(() => document.getElementById('toggle-all').click());
  await sleep(400);
  const once = await allState();
  check(once.music !== before.music && once.allActive === once.music, `ALL flips music (${JSON.stringify(once)})`);
  await page.evaluate(() => document.getElementById('toggle-all').click());
  await sleep(400);
  const twice = await allState();
  check(twice.music === before.music && twice.allActive === twice.music, `ALL again restores it (${JSON.stringify(twice)})`);
  // leave music on (as a player normally would)
  if (!twice.music) { await page.evaluate(() => window._game.lobby._toggleMusic()); }
  await noMediaYet('lobby, ALL pressed twice');

  // ── solo ride + clip ──
  if (WANT_RIDE) {
    await page.evaluate(() => document.getElementById('btn-solo').click());
    await sleep(900);
    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('button, uf-button, .level-card, [class*="level"]'))
        .filter(el => el.offsetParent !== null && /grandma/i.test(el.textContent || ''));
      (cards[0] || document.querySelector('.level-card'))?.click();
    });
    await sleep(500);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, uf-button')).find(x => /start ride/i.test(x.textContent || '') && x.offsetParent !== null);
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
        const there = (id) => !!document.getElementById(id);
        return { self: there('self-pip-wrap'), partner: there('partner-pip-wrap'),
          supported: window._game.recorder.supported, buffering: window._game.recorder.buffering };
      });
      check(!pip.self && !pip.partner, `the room's picture circles are gone (Pete, 2026-11-20) (self=${pip.self} partner=${pip.partner})`);
      const rideControls = await page.evaluate(mediaControls);
      check(rideControls.length === 0, `ride: no camera/mic control exists (${JSON.stringify(rideControls)})`);
      if (!pip.supported || !pip.buffering) {
        // Swiftshader trips the recorder's low-end GPU probe, which disables
        // clips. Force the standard MediaRecorder path exactly as the ride
        // start does, so the SAVE CLIP pipeline still runs headlessly.
        await page.evaluate(async () => {
          const g = window._game, r = g.recorder;
          r.supported = r._checkSupport(); r._gpuProbe = Promise.resolve();
          if (r.supported) await r.startBuffer(g.audioCtx, g.audioEngine);
        });
        await sleep(4000);
        Object.assign(pip, await page.evaluate(() => ({ supported: window._game.recorder.supported, buffering: window._game.recorder.buffering })));
        console.log(`  note recorder forced on (headless low-end probe): supported=${pip.supported} buffering=${pip.buffering}`);
      }
      if (pip.supported && pip.buffering) {
        const clipSources = await page.evaluate(() => {
          const r = window._game.recorder;
          const tracks = r._stream ? r._stream.getTracks().map(t => t.kind).sort() : [];
          return { tracks, hasGameAudio: !!r._audioDestination,
            mediaMembers: ['_micStream', 'partnerStream', 'selfieStream', 'startSelfie', 'setPartnerStream', 'addAudioStreams'].filter(k => k in r) };
        });
        check(clipSources.mediaMembers.length === 0, `the recorder has no camera/mic/partner source (${JSON.stringify(clipSources.mediaMembers)})`);
        check(clipSources.tracks.join(',') === 'audio,video' && clipSources.hasGameAudio,
          `the clip is the game's picture + the game's own sound (${JSON.stringify(clipSources)})`);
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
      await noMediaYet('solo ride + clip');
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
  // #563: on a desktop / TV the room opens when wanted (a phone's Play, or this button).
  await page.waitForFunction(() => document.getElementById('lobby-flow')?.current === 'lobby-host', { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('btn-host-room-code')?.click());
  let roomUp = true;
  // (the relay has us in the room: "Waiting for partner...", then the room-wait line "You're the only one in room …")
  await page.waitForFunction(() => /waiting for partner|the only one in room/i.test(document.getElementById('host-status')?.textContent || ''),
    { timeout: 20000 }).catch(() => { roomUp = false; });
  const room = await page.evaluate(() => ({
    code: document.getElementById('room-code-display')?.textContent,
    status: document.getElementById('host-status')?.textContent,
    link: (document.querySelector('#lobby-host .room-url')?.textContent || '').trim(),
    search: location.search,
  }));
  check(roomUp && /^[A-Z0-9-]{4,}$/.test(room.code || ''), `START A RIDE created a room (code=${room.code}, status="${room.status}")`);
  check(/[?&]room=/.test(room.link) && !/media/i.test(room.link), `the join link carries the room and no media setting ("${room.link}")`);
  const roomControls = await page.evaluate(mediaControls);
  check(roomControls.length === 0, `room screen: no camera/mic control exists (${JSON.stringify(roomControls)})`);

  // ── what an older build (camera still in it) can send ──
  const probe = await page.evaluate(async () => {
    const l = window._game.lobby, net = l.net;
    if (!net) return null;
    const r = { members: ['acquireLocalMedia', 'initiateCall', 'onRemoteStream', 'mediaEnabled', '_localMediaStream', '_mediaCall'].filter(k => k in net) };
    // its "camera on" / "camera off" room messages
    try {
      l._handleRoomMessage({ type: 'cameraToggle', enabled: true });
      l._handleRoomMessage({ type: 'cameraToggle', enabled: false, avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' });
      r.messageError = null;
    } catch (e) { r.messageError = String(e && e.message || e); }
    // its media call, once P2P is up
    const savedPeer = net.peer, savedConn = net.conn;
    net.peer = new window.Peer('probe');
    net.conn = { peer: 'remote-peer', close() {} };
    const incoming = { closed: false, answered: false, on() {}, close() { this.closed = true; }, answer() { this.answered = true; } };
    net._handleIncomingCall(incoming);
    net.peer = savedPeer; net.conn = savedConn;
    await new Promise((res) => setTimeout(res, 2500));   // past the old partner-video retry timers
    r.closed = incoming.closed; r.answered = incoming.answered;
    r.videos = document.querySelectorAll('video:not(#clip-preview)').length;
    return r;
  });
  check(probe && probe.members.length === 0, `the room transport has no media members (${JSON.stringify(probe && probe.members)})`);
  check(probe && probe.messageError === null && probe.videos === 0, `an older build's camera messages are ignored without error (${JSON.stringify(probe)})`);
  check(probe && probe.closed && !probe.answered, `an incoming media call is closed, not answered (${JSON.stringify(probe)})`);
  const afterControls = await page.evaluate(mediaControls);
  check(afterControls.length === 0, `room screen after those: still no camera/mic control (${JSON.stringify(afterControls)})`);

  const c = await counts();
  console.log(`  counts: ${JSON.stringify(c)}`);
  check(c.gum === 0 && c.legacyGum === 0, `getUserMedia never called (${c.gum}/${c.legacyGum})`);
  check(c.enumerate === 0, `enumerateDevices never called (${c.enumerate})`);
  check(c.permissionQueries === 0, `camera/microphone permission never queried (${c.permissionQueries})`);
  check(c.peerCalls === 0, `peer.call never called (${c.peerCalls})`);
  check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' · ')})`);
  await page.close();
  return fails;
}

let fails = [];
try {
  fails = fails.concat((await runPass(false)).map(f => `[default] ${f}`));
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
