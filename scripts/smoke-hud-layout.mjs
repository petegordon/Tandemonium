#!/usr/bin/env node
// smoke-hud-layout.mjs — force every in-ride overlay visible at once (the worst
// case a stoker on Grandma/Adventurous can hit on a first ride) and fail on any
// overlap, at desktop and phone sizes. Everything added in phases A-E was
// independently placed "top-centre" and ended up in a heap; this is what stops
// that happening again.
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8945;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});

async function check(label, viewport) {
  const page=await browser.newPage(); await page.setViewport(viewport);
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
   let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
   if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
   m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
   if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
   return req.abort();});
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window._game,{timeout:30000});

  const boxes = await page.evaluate(async () => {
    const g = window._game;
    // Force every in-ride overlay visible at once — the worst case a stoker on
    // Grandma's/Adventurous can actually hit on their first ride.
    document.getElementById('tap-to-start')?.remove();
    document.getElementById('hud-top').style.display = '';
    document.getElementById('bottom-hud').style.display = '';
    g.hud.setSeat('stoker', true);
    g.hud.updateLookahead([{kind:'obstacle',lane:0,distance:5,urgency:1},{kind:'goose',lane:2,distance:30,urgency:0.3}]);
    g._coachEl = document.getElementById('coach-card');
    g._coachEl.classList.add('show');
    document.getElementById('disruption-banner').textContent = '💨 GUST AHEAD';
    document.getElementById('disruption-banner').classList.add('show');
    document.getElementById('ping-call').textContent = '3';
    document.getElementById('ping-call').classList.add('show');
    document.getElementById('ping-bubbles').innerHTML = '<div class="ping-bubble">C👍</div>';
    document.getElementById('ranked-badge').classList.add('show');
    document.getElementById('split-delta').textContent = '+1.3';
    document.getElementById('split-delta').className = 'show behind';
    document.getElementById('ping-row').classList.add('visible');
    // The gradient chip is part of the worst case: every stat visible at once.
    document.getElementById('grade-row').classList.add('visible','up');
    document.getElementById('grade-value').textContent = '12%';

    const ids = ['hud-top','coach-card','lookahead','disruption-banner','ping-call','ping-bubbles',
                 'ranked-badge','split-delta','pedal-bar','sync-row','ping-row','coop-coach'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out[id] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return out;
  });
  await page.close();

  const overlaps = [];
  const keys = Object.keys(boxes);
  const hit = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const [A, B] = [keys[i], keys[j]];
    // sync-row and ping-row live inside hud-top by design.
    if (['sync-row','ping-row'].includes(A) && B === 'hud-top') continue;
    if (['sync-row','ping-row'].includes(B) && A === 'hud-top') continue;
    if (hit(boxes[A], boxes[B])) overlaps.push(`${A} × ${B}`);
  }
  console.log(`\n${label}`);
  for (const k of keys) console.log('  ', k.padEnd(20), JSON.stringify(boxes[k]));
  console.log('  OVERLAPS:', overlaps.length ? overlaps.join(', ') : 'none ✔');
  return overlaps;
}

// M6 · the end screens on phones, in their tallest state (a 5th-failure game
// over: help line, coins, RESTART, Royal Shortcut, END RIDE, GARAGE, SHARE,
// WISHLIST, invite). Each must start at the top edge or below (nothing centred
// off-screen) and scroll so its last button can be reached.
async function endScreens(label, viewport) {
  const page=await browser.newPage(); await page.setViewport(viewport);
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
   let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
   if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
   m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
   if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
   return req.abort();});
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window._game,{timeout:30000});

  // One screen at a time: show it, measure it, shoot it (#459: the screenshots
  // in $TMP/tandemonium-layout are the PR's record of each screen), hide it.
  await page.evaluate(async () => {
    const g = window._game;
    document.getElementById('tap-to-start')?.remove();
    const { scoreRide } = await import('./js/economy.js');
    const ui = await import('./js/slingshot-ui.js');
    const show = (...ids) => ids.forEach(id => { const e = document.getElementById(id); if (e) e.style.display = ''; });
    const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    // The edges of everything visible in the overlay. A thing inside a
    // scrolling box (the overlay itself, or the kit sheet's body since #428) is
    // reachable by scrolling, so it counts at that box's edges; the box itself
    // still has to be on screen.
    const scroller = (e, root) => {
      for (let a = e.parentElement; a; a = a.parentElement) {
        const oy = getComputedStyle(a).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight + 1) return a;
        if (a === root) break;
      }
      return null;
    };
    const measure = (root) => {
      const parts = Array.from(root.querySelectorAll('*')).filter(e => visible(e) && !e.closest('svg'));
      const vh = window.innerHeight, vw = window.innerWidth;
      const box = (e) => { const s = scroller(e, root); return (s || e).getBoundingClientRect(); };
      const rects = parts.map(box);
      const top = Math.min(...rects.map(r => r.top));
      const buttons = parts.filter(e => e.tagName === 'BUTTON' || e.tagName === 'UF-BUTTON');
      const lastBtn = buttons[buttons.length - 1];
      const bottom = Math.max(...rects.map(r => r.bottom));
      const right = Math.max(...rects.map(r => r.right));
      const left = Math.min(...rects.map(r => r.left));
      const lb = lastBtn ? box(lastBtn) : null;
      const out = { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right),
                    buttons: buttons.length, lastBtn: lastBtn ? lastBtn.textContent.trim().slice(0, 24) : null,
                    lastBtnTop: lb ? Math.round(lb.top) : null, lastBtnBottom: lb ? Math.round(lb.bottom) : null,
                    scrolls: parts.some(e => !!scroller(e, root)) };
      out.fits = top >= -1 && bottom <= vh + 1 && left >= -1 && right <= vw + 1 &&
                 !!lb && lb.top >= -1 && lb.bottom <= vh + 1;
      root.scrollTop = 0;
      return out;
    };
    const $ = (id) => document.getElementById(id);
    window.__measure = measure;
    window.__screens = {
      // Game over, 5th failure (the Royal House steps in), solo, on a demo build.
      gameover: {
        root: () => $('gameover-overlay'),
        show() {
          const help = $('gameover-help');
          help.textContent = '🎩 Sir Winston steps in — no gusts, 1.5× the time, safety on. The Royal Shortcut is open.';
          help.style.display = '';
          const goCoins = $('gameover-coins');
          g._renderRideCoins(goCoins, scoreRide({ distance: 212, pickups: 3 }), { coins: 12345 });
          goCoins.style.display = '';
          show('btn-gameover-clip', 'btn-restart', 'btn-skip-checkpoint', 'btn-gameover-lobby', 'btn-gameover-garage',
               'btn-daily-share-gameover', 'btn-wishlist-gameover', 'btn-invite-gameover');
          $('gameover-overlay').style.display = 'flex';
        },
        hide() { $('gameover-overlay').style.display = 'none'; },
      },
      // Victory: a full stats block, a medal + new-best payout, every button.
      victory: {
        root: () => $('victory-overlay'),
        show() {
          $('victory-destination').textContent = "📍 Grandma's House";
          $('victory-stats').innerHTML =
            '<div class="victory-stats-grid">' +
            ['Time', '1:02.4', 'Best', '1:05.0', 'Presents', '7 / 8', 'Crashes', '1', 'Top speed', '31 km/h', 'Sync', '82%']
              .map(t => `<div class="vs-cell">${t}</div>`).join('') + '</div>' +
            '<div class="victory-stat">🥇 GOLD · NEW BEST</div><div class="victory-stat">2.0 km of real streets</div>';
          const vCoins = $('victory-coins');
          g._renderRideCoins(vCoins, scoreRide({ distance: 250, pickups: 7, finished: true, medal: 'gold', newBest: true }), { coins: 12345 });
          vCoins.style.display = '';
          show('btn-play-again', 'btn-next-level', 'btn-victory-lobby', 'btn-victory-garage',
               'btn-daily-share-victory', 'btn-wishlist-victory', 'btn-invite-victory');
          $('victory-overlay').classList.add('visible');
        },
        hide() { $('victory-overlay').classList.remove('visible'); },
      },
      // The demo's end.
      demoEnd: { root: () => $('demo-end-overlay'), show() { $('demo-end-overlay').style.display = 'flex'; }, hide() { $('demo-end-overlay').style.display = 'none'; } },
      // Slingshot garage (every upgrade) and a results card with every row.
      slingGarage: { root: () => $('sling-garage'), show() { g._openSlingGarage(0, { standalone: true }); }, hide() { ui.hideGarage(); g._clearOverlayButtons(); g.state = 'lobby'; } },
      slingResults: {
        root: () => $('sling-results'),
        show() {
          ui.renderResults({
            cause: 'goal', daily: false, stageCleared: true, canWishlist: true,
            score: { distance: 1050, isRecord: true, distPay: 210, coinPay: 60, recordPay: 40, stagePay: 300,
                     potPay: 200, airPay: 30, multiplier: 1.5, total: 1260 },
            run: { coins: 12, bigAirs: 3, topSpeed: 21 },
            save: { stage: 4 }, wallet: { coins: 12345 },
            lock: { kind: 'demo', label: "That's the demo's last stage!" },
          }, { onAgain() {}, onGarage() {}, onLobby() {}, onWishlist() {}, onGoRide() {} });
        },
        hide() { ui.hideResults(); },
      },
      // #459 item 15: tutorial complete (solo: NEXT + LOBBY, the Steam widget), partner left, the stoker's CTA.
      tutorialComplete: {
        root: () => $('tutorial-complete'),
        show() {
          $('tutorial-complete-stats').innerHTML = 'Attempts: 2 — Practice makes perfect!<br>Presents collected: 7/7<br><span class="calibrated">Steering calibrated to your style!</span>';
          $('steam-cta').style.display = '';
          $('btn-tutorial-next').style.display = '';
          $('btn-tutorial-continue').textContent = 'LOBBY';
          $('tutorial-complete').classList.add('visible');
        },
        hide() { $('tutorial-complete').classList.remove('visible'); $('steam-cta').style.display = 'none'; $('btn-tutorial-next').style.display = 'none'; },
      },
      partnerLeft: {
        root: () => $('disconnect-overlay'),
        show() { g.mode = 'local'; g._startDropPause('p1'); g._drop.takeoverReady = true; g._renderDropOverlay(); },
        hide() { g._endDropPause(); g.mode = 'solo'; },
      },
      stokerCta: { root: () => $('stoker-cta-overlay'), show() { $('stoker-cta-overlay').style.display = 'flex'; }, hide() { $('stoker-cta-overlay').style.display = 'none'; } },
      // #459 items 12, 6, 11/18: the pause menu, the tutorial intro, Help (modals on the sheet shell).
      pause: {
        root: () => $('pause-sheet'),
        show() { g.state = 'playing'; g._openPause(); },
        hide() { g._closePause(); g.state = 'lobby'; },
      },
      tutorialIntro: {
        root: () => $('tutorial-intro'),
        show() { g._showTutorialIntro(); },
        hide() { if (g._intro) g._intro.close(); },
      },
      help: { root: () => $('help-modal'), show() { g.lobby._openHelp(); }, hide() { g.lobby._closeHelp(); } },
    };
  });
  const res = {};
  for (const name of await page.evaluate(() => Object.keys(window.__screens))) {
    await page.evaluate((n) => window.__screens[n].show(), name);
    await page.waitForFunction((n) => window.__screens[n].root().getBoundingClientRect().width > 0, { timeout: 5000 }, name).catch(() => {});
    res[name] = await page.evaluate((n) => window.__measure(window.__screens[n].root()), name);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `${label.replace(/\W+/g, '-')}-${name}.png`) });
    await page.evaluate((n) => window.__screens[n].hide(), name);
  }
  await page.close();
  console.log(`\nend screens ${label}`);
  const bad = [];
  for (const [k, v] of Object.entries(res)) {
    console.log('  ', k.padEnd(16), (v.fits ? '✔ ' : '✖ ') + JSON.stringify(v));
    if (!v.fits) bad.push(`${label} ${k}`);
  }
  return bad;
}
const shotDir = path.join(os.tmpdir(), 'tandemonium-layout');
fs.mkdirSync(shotDir, { recursive: true });

const desktop = await check('desktop 1280x800', { width: 1280, height: 800 });
const phone = await check('phone 390x844', { width: 390, height: 844, isMobile: true, hasTouch: true });
const endLandscape = await endScreens('landscape phone 844x390', { width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true });
const endPortrait = await endScreens('phone 390x664', { width: 390, height: 664, isMobile: true, hasTouch: true });
// #459: the same screens on a desktop and a TV (the kit's text ramp), for the record.
const endDesktop = await endScreens('desktop 1280x800', { width: 1280, height: 800 });
const endTv = await endScreens('tv 1920x1080', { width: 1920, height: 1080 });
await browser.close(); server.close();
const endBad = [...endLandscape, ...endPortrait, ...endDesktop, ...endTv];
console.log(`\nscreenshots: ${shotDir}`);
if (endBad.length) console.log('\nEND SCREENS THAT DO NOT FIT:', endBad.join(', '));
process.exit(desktop.length + phone.length + endBad.length === 0 ? 0 : 1);
