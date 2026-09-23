#!/usr/bin/env node
// ============================================================
// smoke-boot-failure.mjs — #350: the dead end must speak
// ============================================================
//
// Two ways the game can fail to boot, both of which used to leave a silent,
// unresponsive "Tap to Start":
//   1. the browser has no import-map support (the iPhone 8 report)
//   2. the module graph never executes
// Both must end at the friendly failure screen. Run:  node scripts/smoke-boot-failure.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = process.cwd();
const PORT = 8907;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

async function run(name, prep) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', r => r.url().startsWith(`http://127.0.0.1:${PORT}`) ? r.continue() : r.abort());
  if (prep) await prep(page);
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 14000));
  const state = await page.evaluate(() => ({
    failVisible: document.getElementById('boot-fail')?.classList.contains('show') || false,
    title: document.getElementById('boot-fail-title')?.textContent,
    body: document.getElementById('boot-fail-body')?.textContent,
    diag: document.getElementById('boot-fail-diag')?.textContent?.split('\n')[0]
  }));
  console.log(`${name}:`, JSON.stringify(state));
  await page.close();
  return state;
}

// No import-map support (the iPhone 8 case) — must fail preflight immediately.
const a = await run('no importmap', (page) => page.evaluateOnNewDocument(() => {
  HTMLScriptElement.supports = () => false;
}));
// Modules present but the bundle never runs — the watchdog must catch it.
const b = await run('module never runs', (page) => page.setRequestInterception(true).then(() => {
  page.removeAllListeners('request');
  page.on('request', r => {
    if (r.url().endsWith('/js/game.js')) return r.abort();
    return r.url().startsWith(`http://127.0.0.1:${PORT}`) ? r.continue() : r.abort();
  });
}));

await browser.close();
server.close();
const ok = a.failVisible && b.failVisible;
console.log(ok ? '✔ both failure paths show a message' : '✖ a failure path stayed silent');
process.exit(ok ? 0 : 1);
