#!/usr/bin/env node
// smoke-sync-ping.mjs — E-3: a sprint counts down on the HUD, doubles the sync
// gain for its window, expires; emotes arrive from the other seat and fade.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8929;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const page=await browser.newPage(); await page.setViewport({width:1280,height:800});
await page.setRequestInterception(true);
page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
 let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
 if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
 m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
 if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
 return req.abort();});
page.on('pageerror', e => console.log('  PAGEERROR:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>!!window._game,{timeout:30000});

const out = await page.evaluate(async () => {
  const g = window._game;
  const { SharedPedalController } = await import('./js/shared-pedal-controller.js');
  g.state = 'playing';
  g.mode = 'captain';
  g.sharedPedal = new SharedPedalController();
  const sent = [];
  g.net = { sendProfile: (p) => sent.push(p) };

  // 1. Call a sprint the way a keyboard player does.
  g._pingState = null;
  g._updatePing(0.016);
  g._callSprint();
  const called = { phase: g._pingState.phase, label: document.getElementById('ping-call').textContent };

  // 2. Run the countdown out and check the HUD and the multiplier.
  for (let t = 0; t < 3.2; t += 1/60) g._updatePing(1/60);
  const sprinting = {
    phase: g._pingState.phase,
    label: document.getElementById('ping-call').textContent,
    multiplier: g.sharedPedal.syncMultiplier
  };

  // 3. Let it end; the multiplier must come back down.
  for (let t = 0; t < 5.2; t += 1/60) g._updatePing(1/60);
  const after = { phase: g._pingState.phase, multiplier: g.sharedPedal.syncMultiplier };

  // 4. An emote from the OTHER seat arrives over the wire and is drawn.
  g._receivePing({ type: 'ping', kind: 'emote', emote: '🐢', seat: 'stoker' });
  g._updatePing(0.016);
  const bubble = document.getElementById('ping-bubbles').textContent;
  for (let t = 0; t < 2.2; t += 1/60) g._updatePing(1/60);
  const bubbleGone = document.getElementById('ping-bubbles').textContent;

  // 5. Solo says nothing to nobody.
  g.mode = 'solo';
  g._updatePing(0.016);
  const solo = { label: document.getElementById('ping-call').textContent };

  return { called, sprinting, after, sent, bubble, bubbleGone, solo };
});
console.log(JSON.stringify(out, null, 1));

const ok = out.called.phase === 'counting' && out.called.label === '3'
  && out.sprinting.phase === 'sprinting' && out.sprinting.label === 'SPRINT!' && out.sprinting.multiplier === 2
  && out.after.phase === 'idle' && out.after.multiplier === 1
  && out.sent.length === 1 && out.sent[0].kind === 'sprint'
  && out.bubble.includes('🐢') && out.bubbleGone === ''
  && out.solo.label === '';
console.log(ok ? '✔ the sprint call counts down on the HUD, doubles the sync gain, and expires; emotes arrive and fade'
               : '✖ ping behaviour wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
