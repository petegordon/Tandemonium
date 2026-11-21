#!/usr/bin/env node
// ============================================================
// smoke-preview-fallback.mjs — does a slim PR preview still work?
// ============================================================
//
// A pull-request preview publishes only the heavy files the PR changed; a
// service worker fetches the rest from the live game (#760, see
// scripts/stage-preview.mjs and scripts/preview-sw.js). The real thing can
// only be seen on GitHub Pages, so this builds the same shape locally:
//
//   <temp>/site/                      the "live" game (links to this checkout's files)
//   <temp>/site/pr-preview/pr-1/      a preview, staged by stagePreview() itself,
//                                     the function the workflow's script runs
//   <temp>/pr/                        a throwaway git worktree playing the PR: one
//                                     heavy file changed, one added, one renamed
//
// and opens the preview in headless Chrome over http://127.0.0.1 (service
// workers are allowed there). It checks that the page ends up controlled after
// one reload and no more, that a left-out heavy file comes from the live game,
// that a changed one comes from the preview, that Range requests work, that
// nothing outside the preview's heavy folders is touched, that the lobby
// loads, and that a second build of the preview replaces the first one's
// worker.
//
//   node scripts/smoke-preview-fallback.mjs
//
// It needs git and about 400 MB of temp space for the worktree; it removes
// both the worktree and the temp folder when it ends.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { stagePreview, publishableFiles, isHeavy, HEAVY_DIRS, SW_FILE } from './stage-preview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 8967);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PREVIEW = '/pr-preview/pr-1/';
const require = createRequire(import.meta.url);
const THREE = path.resolve(path.dirname(require.resolve('three')), '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// stderr is captured (it comes back in the error if git fails) so line-ending notices stay out of the log.
const git = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();

let failed = 0, total = 0;
const check = (ok, name, detail) => {
  total++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  return !!ok;
};

// ── 1 · A throwaway "pull request" ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandemonium-preview-smoke-'));
const prDir = path.join(tmp, 'pr');
const site = path.join(tmp, 'site');
const previewDir = path.join(site, 'pr-preview', 'pr-1');
let server = null, browser = null;

async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
  try { git(ROOT, ['worktree', 'remove', '--force', prDir]); } catch { /* never added */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}

try {
  const base = git(ROOT, ['rev-parse', 'HEAD']);
  console.log(`→ fake pull request on top of ${base.slice(0, 7)} (worktree in ${tmp})`);
  git(ROOT, ['worktree', 'add', '--quiet', '--detach', prDir, base]);

  const heavy = publishableFiles(ROOT).filter(isHeavy);
  const size = (f) => fs.statSync(path.join(ROOT, f)).size;
  // A path with a space in it, and audio so Range requests can be tried on it.
  const UNCHANGED = heavy.find((f) => /^assets\/.* .*\.mp3$/.test(f));
  const CHANGED = heavy.find((f) => /^assets\/.* .*\.mp3$/.test(f) && f !== UNCHANGED);
  const RENAMED_FROM = heavy.filter((f) => f.startsWith('images/') && f.endsWith('.png')).sort((a, b) => size(a) - size(b))[0];
  const RENAMED_TO = 'images/preview smoke renamed.png';
  const ADDED = 'tandem-3d/preview smoke added.txt';
  if (!UNCHANGED || !CHANGED || !RENAMED_FROM) throw new Error('could not pick test files from the heavy folders');
  const MARK = Buffer.from('\nPR-PREVIEW-SMOKE: this copy belongs to the pull request\n');

  // Changed = the original with a marker appended, so it is still a playable
  // mp3 if the lobby asks for it, and different bytes from the live game's.
  fs.appendFileSync(path.join(prDir, CHANGED), MARK);
  fs.writeFileSync(path.join(prDir, ADDED), MARK);
  git(prDir, ['mv', RENAMED_FROM, RENAMED_TO]);
  git(prDir, ['add', '-A']);
  // commit-tree, not `git commit`: no hooks, no signing, no editor, and the
  // identity comes from here instead of whoever runs the test.
  const who = { GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@localhost', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@localhost' };
  const prHead = git(prDir, ['commit-tree', git(prDir, ['write-tree']), '-p', base, '-m', 'smoke: fake pull request'], who);
  git(prDir, ['reset', '--quiet', '--soft', prHead]);

  // ── 2 · The published tree ──
  // Live game at the root: this checkout's files. Hard links where the temp
  // folder is on the same disk (no copy of 340 MB), plain copies otherwise.
  for (const file of publishableFiles(ROOT)) {
    const to = path.join(site, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.linkSync(path.join(ROOT, file), to); } catch { fs.copyFileSync(path.join(ROOT, file), to); }
  }
  // The preview, by the same function the workflow's script calls.
  const staged = stagePreview({ src: prDir, out: previewDir, pr: 1, sha: prHead, base });
  const mb = (staged.bytes / 1048576).toFixed(1);
  // The workflow's next step writes the Tourist Maps key file into the staged
  // folder (it is gitignored, so staging cannot). Stand in for it, keyless, so
  // the page's request for it is not a 404 the checks below would trip on.
  fs.writeFileSync(path.join(previewDir, 'js', 'tourist-key.local.js'), 'window.__TOURIST_MAPS_KEY__ = "";\n');
  console.log(`→ preview staged: ${mb} MB, ${staged.heavyKept.length} heavy file(s) published, ${staged.heavyLeftOut} left out`);

  console.log('\nStaging');
  check(JSON.stringify([...staged.heavyKept].sort()) === JSON.stringify([CHANGED, RENAMED_TO, ADDED].sort()),
    'the preview publishes exactly the heavy files the PR changed, added or renamed', staged.heavyKept);
  check(!fs.existsSync(path.join(previewDir, UNCHANGED)), 'an unchanged heavy file is left out of the preview', UNCHANGED);
  check(staged.bytes < 30 * 1048576, 'the preview is under 30 MB', `${mb} MB`);
  check(staged.unregistered.length === 0, 'every page of the preview registers the worker', staged.unregistered);
  const sw = fs.readFileSync(path.join(previewDir, SW_FILE), 'utf8');
  check(HEAVY_DIRS.every((d) => sw.includes(JSON.stringify(d))) && !sw.includes('%%HEAVY_DIRS%%'), 'the worker carries the staging\'s list of heavy folders');
  check([CHANGED, RENAMED_TO, ADDED, 'tandem-3d/index.html'].every((x) => sw.includes(JSON.stringify(x))) && !sw.includes(JSON.stringify(UNCHANGED)) && !sw.includes('%%OWN_FILES%%'),
    'the worker carries the list of heavy files this preview published');
  check(!/\bcaches\b/.test(sw.replace(/^\s*\/\/.*$/gm, '')), 'the worker never uses the Cache API');
  check(!fs.readFileSync(path.join(site, 'index.html'), 'utf8').includes(SW_FILE)
    && !fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes(SW_FILE), 'the live page and the repo\'s index.html have no registration script');
  check(fs.existsSync(path.join(previewDir, 'tandem-3d', 'index.html')), 'a page inside a heavy folder is still published (it must register the worker)');

  // deploy.yml carries previews forward into the tree it publishes, except
  // ones staged the old way (a full copy, no worker at the root), and then
  // measures the tree. Run those two scripts on this tree with an old-style
  // preview added beside the new-style one.
  console.log('\nWhat a production deploy carries forward');
  const oldStyle = path.join(site, 'pr-preview', 'pr-2');
  fs.mkdirSync(path.join(oldStyle, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(oldStyle, 'index.html'), '<!doctype html><title>old-style preview</title>');
  fs.writeFileSync(path.join(oldStyle, 'assets', 'big.bin'), Buffer.alloc(3 * 1048576));
  const bash = (script, ...args) => {
    try { return { code: 0, out: execFileSync('bash', [path.join(ROOT, '.github/scripts', script), ...args.map((x) => String(x).replace(/\\/g, '/'))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };
  const dropped = bash('drop-full-previews.sh', path.join(site, 'pr-preview'));
  check(dropped.code === 0 && !fs.existsSync(oldStyle), 'a preview with no worker at its root (staged the old way) is dropped');
  check(/Dropped the preview of PR #2 \(3\.0 MB\).*next push or reopen/.test(dropped.out), '  …with a line in the log naming the PR and its size', dropped.out.trim().split('\n')[0]);
  check(fs.existsSync(path.join(previewDir, SW_FILE)) && fs.existsSync(path.join(previewDir, 'index.html')) && /kept[^\n]*: 1\b/.test(dropped.out), 'a preview staged the new way is kept');
  const measured = bash('check-publish-size.sh', site, 900);
  check(measured.code === 0 && /preview pr-1: /.test(measured.out) && !/pr-2/.test(measured.out), 'the size check then passes and lists only the kept preview', (measured.out.match(/total: [^\n]*/) || [''])[0]);
  check(bash('check-publish-size.sh', site, 100).code === 1, 'the size check fails a tree over its limit');

  // ── 3 · Serve it the way Pages does ──
  // Range support (media seeks with it), a 404 for anything missing, and the
  // ten-minute Cache-Control Pages puts on everything. Every request is logged
  // so the checks can see which path was really asked for.
  //
  // One unkind habit of the real thing is copied too: Pages has been seen
  // answering 503, not 404, for about four in ten requests for a missing file
  // (for some minutes, not always).
  // Here a missing file in the preview's heavy folders always answers 503, so
  // the test fails if the worker ever depends on a 404 to know a file was left
  // out. (One check below turns it back to 404 on purpose.)
  let missingInPreviewHeavy = 503;
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm',
    '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  };
  const log = [];
  server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const entry = { method: req.method, path: urlPath, range: req.headers.range || null, status: 0 };
    log.push(entry);
    const done = (status, headers = {}, body = null) => { entry.status = status; res.writeHead(status, { 'Cache-Control': 'max-age=600', ...headers }); res.end(body); };
    if (urlPath === '/favicon.ico') return done(204);
    let file = path.join(site, urlPath);
    if (!file.startsWith(site)) return done(403);
    if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
    fs.stat(file, (err, st) => {
      if (err || st.isDirectory() || req.method !== 'GET') {
        const heavyHere = HEAVY_DIRS.some((d) => urlPath.startsWith(PREVIEW + d + '/'));
        return done(heavyHere ? missingInPreviewHeavy : 404, { 'Content-Type': 'text/html; charset=utf-8' }, 'not found');
      }
      const type = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (!m) { entry.status = 200; res.writeHead(200, { 'Cache-Control': 'max-age=600', ...type, 'Content-Length': st.size }); return fs.createReadStream(file).pipe(res); }
      const start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
      const end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      if (start > end) return done(416, { 'Content-Range': `bytes */${st.size}` });
      entry.status = 206;
      res.writeHead(206, { 'Cache-Control': 'max-age=600', ...type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    });
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const hits = (p, method = 'GET') => log.filter((e) => e.path === p && e.method === method);

  // ── 4 · Open the preview ──
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });

  /** A page that serves three.js from node_modules and drops other sites, like the other smokes. */
  async function newPage(context) {
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:')) return req.continue();
      let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
      let f = m && path.join(THREE, 'build/three.module.js');
      if (!f) { m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); f = m && path.join(THREE, 'examples/jsm', m[1]); }
      if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
      return req.abort();
    });
    page.pageErrors = [];
    page.on('pageerror', (e) => { page.pageErrors.push(e.message); });
    // The registration script explains itself on the console when it declines to reload.
    page.on('console', (m) => { if (m.text().includes('[preview]')) console.log('       page: ' + m.text()); });
    return page;
  }
  /** Poll the page; the page reloads itself once, which destroys whatever was being evaluated. */
  async function until(page, fn, timeout = 90000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = await page.evaluate(fn); if (v) return v; } catch { /* mid-reload */ }
      await sleep(200);
    }
    return null;
  }
  /** fetch() from inside the page: status, length, sha256 and the tail of the body. */
  const get = (page, url, init = {}) => page.evaluate(async (u, i) => {
    const r = await fetch(u, i);
    const buf = new Uint8Array(await r.arrayBuffer());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (b) => b.toString(16).padStart(2, '0')).join('');
    return { status: r.status, length: buf.length, sha256: hash, contentRange: r.headers.get('content-range'), tail: new TextDecoder().decode(buf.slice(-40)) };
  }, url, init);

  const liveBytes = (f) => fs.readFileSync(path.join(ROOT, f));
  const enc = (f) => f.split('/').map(encodeURIComponent).join('/');

  const page = await newPage(browser.defaultBrowserContext());
  const responses = [];
  page.on('response', (r) => { if (r.url().startsWith(ORIGIN)) responses.push({ url: r.url().slice(ORIGIN.length), status: r.status() }); });
  await page.goto(ORIGIN + PREVIEW, { waitUntil: 'domcontentloaded' });

  console.log('\nTaking control');
  const controller = await until(page, () => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL, 30000);
  check(controller === ORIGIN + PREVIEW + SW_FILE, 'the page ends up controlled by the preview\'s worker', controller);
  const lobby = await until(page, () => !!window._game && !!window._game.lobby && location.pathname);
  check(lobby === PREVIEW, 'the lobby is ready inside the preview path (window._game.lobby)', lobby);
  check(hits(PREVIEW).length === 2, 'the page loaded twice: the first visit, then one reload once the worker was active', hits(PREVIEW).length);
  await sleep(3000);
  check(hits(PREVIEW).length === 2, 'no further reloads (no loop)', hits(PREVIEW).length);

  console.log('\nA controlled load');
  responses.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(page, () => !!window._game && !!window._game.lobby);
  await sleep(4000);   // let the lobby's models, images and music requests finish
  check(hits(PREVIEW).length === 3, 'a manual reload is one load, not two', hits(PREVIEW).length);
  const notFound = responses.filter((r) => r.status === 404);
  check(notFound.length === 0, 'no 404 reaches the page', notFound.slice(0, 5));
  const heavySeen = responses.filter((r) => HEAVY_DIRS.some((d) => r.url.startsWith(PREVIEW + d + '/')));
  check(heavySeen.length > 0 && heavySeen.every((r) => r.status === 200 || r.status === 206), 'the lobby\'s own heavy requests were answered', `${heavySeen.length} requests`);
  check(page.pageErrors.length === 0, 'no uncaught page errors', page.pageErrors.slice(0, 3));

  console.log('\nHeavy files');
  let r = await get(page, enc(UNCHANGED));
  check(r.status === 200 && r.sha256 === sha256(liveBytes(UNCHANGED)), 'a file the preview left out arrives with the live game\'s bytes', UNCHANGED);
  check(hits(PREVIEW + UNCHANGED).length === 0 && hits('/' + UNCHANGED).some((e) => e.status === 200),
    '  …straight from the site root: the preview was never asked for it');
  r = await get(page, enc(CHANGED));
  check(r.status === 200 && r.sha256 === sha256(Buffer.concat([liveBytes(CHANGED), MARK])) && r.tail.includes('belongs to the pull request'),
    'a file the PR changed arrives with the PR\'s bytes', CHANGED);
  check(hits('/' + CHANGED).length === 0, '  …and the live copy was never asked for');
  r = await get(page, enc(ADDED));
  check(r.status === 200 && r.sha256 === sha256(MARK), 'a file the PR added (space in its name) is served by the preview', ADDED);
  r = await get(page, enc(RENAMED_TO));
  check(r.status === 200 && r.sha256 === sha256(liveBytes(RENAMED_FROM)) && hits('/' + RENAMED_TO).length === 0, 'a file the PR renamed is served by the preview under its new name', RENAMED_TO);
  r = await get(page, enc(RENAMED_FROM));
  check(r.status === 200, 'a file the PR removed still answers from the live game (known limit: a preview cannot delete a heavy file)', RENAMED_FROM);
  r = await get(page, 'assets/preview-smoke-nowhere.bin');
  check(r.status === 404, 'a heavy file that is in neither place is a 404');

  // Each with a query string of its own: the file was fetched whole just above,
  // and Chrome would answer a Range request for the same URL out of its HTTP
  // cache without the request ever reaching the worker's fetch or the server.
  console.log('\nRange requests');
  let seen = hits('/' + UNCHANGED).length;
  r = await get(page, enc(UNCHANGED) + '?range=1', { headers: { Range: 'bytes=1000-1999' } });
  check(r.status === 206 && r.length === 1000 && r.sha256 === sha256(liveBytes(UNCHANGED).subarray(1000, 2000)) && /^bytes 1000-1999\//.test(r.contentRange || ''),
    'a Range request for a left-out file gets that slice of the live file (206)', r.contentRange);
  check(hits('/' + UNCHANGED).slice(seen).some((e) => e.range === 'bytes=1000-1999' && e.status === 206), '  …the Range header reached the live path');
  const changedBytes = Buffer.concat([liveBytes(CHANGED), MARK]);
  r = await get(page, enc(CHANGED), { headers: { Range: `bytes=${changedBytes.length - 20}-` } });
  check(r.status === 206 && r.sha256 === sha256(changedBytes.subarray(changedBytes.length - 20)), 'a Range request for a changed file gets the PR\'s slice (206)', r.contentRange);
  seen = hits('/' + UNCHANGED).length;
  const audio = await page.evaluate((u) => new Promise((resolve) => {
    const a = new Audio(u);
    a.addEventListener('loadedmetadata', () => resolve({ ok: true, duration: a.duration }));
    a.addEventListener('error', () => resolve({ ok: false, error: a.error && a.error.message }));
    setTimeout(() => resolve({ ok: false, error: 'timeout' }), 15000);
  }), enc(UNCHANGED) + '?range=2');
  check(audio.ok && audio.duration > 1, 'an <audio> element plays a left-out file through the fallback', audio);
  check(hits('/' + UNCHANGED).slice(seen).some((e) => e.range && e.status === 206), '  …with the element\'s own Range request answered by the live file (206)',
    hits('/' + UNCHANGED).slice(seen).map((e) => e.range));

  // The worker is older than the preview it runs in for a moment after every
  // new build. If a file it believes the preview has is gone, a real 404 falls
  // back to the live game; a server error is passed back, not papered over
  // with the live game's (wrong) copy.
  console.log('\nA file the worker expects in the preview');
  fs.rmSync(path.join(previewDir, CHANGED));
  r = await get(page, enc(CHANGED) + '?gone=1');
  check(r.status === 503, 'a server error for it goes back to the page as it is', r.status);
  missingInPreviewHeavy = 404;
  r = await get(page, enc(CHANGED) + '?gone=2');
  check(r.status === 200 && r.sha256 === sha256(liveBytes(CHANGED)), 'a 404 for it falls back to the live game\'s copy');
  missingInPreviewHeavy = 503;

  console.log('\nEverything else is left alone');
  r = await get(page, 'js/preview-smoke-nowhere.js');
  check(r.status === 404 && hits('/js/preview-smoke-nowhere.js').length === 0, 'a missing file outside the heavy folders stays a 404, with no second request');
  r = await get(page, 'js/game.js');
  check(r.status === 200 && hits('/js/game.js').length === 0, 'the game\'s code comes from the preview only');
  const rootBefore = hits('/' + UNCHANGED).length;
  r = await get(page, '/pr-preview/pr-2/' + enc(UNCHANGED));
  check(r.status === 404 && hits('/' + UNCHANGED).length === rootBefore, 'another preview\'s heavy path is not handled (404, no fallback)');
  r = await get(page, '/' + enc(CHANGED));
  check(r.status === 200 && r.sha256 === sha256(liveBytes(CHANGED)), 'a request for the live game\'s own path is untouched (live bytes, even for a file the PR changed)');
  r = await get(page, '/preview-smoke-nowhere.txt');
  check(r.status === 404, 'a missing file outside the preview stays a 404');
  await page.evaluate((u) => fetch(u, { method: 'POST' }).then((x) => x.status), enc(UNCHANGED));
  check(hits('/' + UNCHANGED, 'POST').length === 0 && hits(PREVIEW + UNCHANGED, 'POST').length === 1, 'a POST to a heavy path is passed through as it is');
  check(await page.evaluate(async () => (await caches.keys()).length) === 0, 'nothing was put in the Cache API');

  console.log('\nOther pages');
  const sub = await newPage(browser.defaultBrowserContext());
  await sub.goto(ORIGIN + PREVIEW + 'tandem-3d/', { waitUntil: 'domcontentloaded' });
  check(await sub.evaluate(() => !!navigator.serviceWorker.controller && location.pathname) === PREVIEW + 'tandem-3d/', 'a page inside a heavy folder opens and is controlled');
  check(await sub.evaluate((n) => document.head.innerHTML.includes(n), SW_FILE) && hits('/tandem-3d/').length === 0, '  …and it is the preview\'s own copy of the page, not the live game\'s');
  await sub.close();
  const live = await newPage(browser.defaultBrowserContext());
  await live.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await sleep(1000);
  check(await live.evaluate(async () => !navigator.serviceWorker.controller && (await navigator.serviceWorker.getRegistrations()).every((x) => !location.pathname.startsWith(new URL(x.scope).pathname))),
    'the live game\'s page is not controlled by any worker');
  await live.close();

  // A second push to the pull request: UNCHANGED is now changed too, so the
  // new build's worker lists it. An open page still has the old worker, which
  // fetches that file from the live game. The page must notice the new worker
  // taking over and reload itself, once.
  //
  // Tried on a plain page of the preview (the test-pages index) with the game
  // tab closed: under software WebGL the game keeps Chrome so busy that its
  // check for a new worker file can take most of a minute, and a page only
  // reloads itself for a takeover in its first 20 seconds.
  console.log('\nA newer build of the preview');
  await page.close();
  const LIGHT = PREVIEW + 'test/';
  const light = await newPage(browser.defaultBrowserContext());
  await light.goto(ORIGIN + LIGHT, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  r = await get(light, '../' + enc(UNCHANGED) + '?build=1');
  check(await light.evaluate(() => !!navigator.serviceWorker.controller) && r.status === 200 && r.sha256 === sha256(liveBytes(UNCHANGED)),
    'first build: a controlled page gets the file from the live game');
  fs.appendFileSync(path.join(prDir, UNCHANGED), MARK);
  git(prDir, ['add', '-A']);
  const prHead2 = git(prDir, ['commit-tree', git(prDir, ['write-tree']), '-p', prHead, '-m', 'smoke: second push'], who);
  git(prDir, ['reset', '--quiet', '--soft', prHead2]);
  fs.rmSync(previewDir, { recursive: true, force: true });
  const staged2 = stagePreview({ src: prDir, out: previewDir, pr: 1, sha: prHead2, base });
  check(staged2.heavyKept.includes(UNCHANGED) && staged2.heavyKept.includes(CHANGED), 'the second build publishes both changed files', staged2.heavyKept);
  const loadsBefore = hits(LIGHT).length;
  await light.reload({ waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 100 && hits(LIGHT).length < loadsBefore + 2; i++) await sleep(200);
  await sleep(3000);
  check(hits(LIGHT).length === loadsBefore + 2, 'the page reloaded itself once when the new build\'s worker took over', hits(LIGHT).length - loadsBefore);
  r = await get(light, '../' + enc(UNCHANGED) + '?build=2');
  check(r.status === 200 && r.sha256 === sha256(Buffer.concat([liveBytes(UNCHANGED), MARK])), 'the file only the second build changed now arrives with the PR\'s bytes');
  await light.close();

  // A browser where the worker never takes control (here: told to bypass it).
  // The page must reload once, find it is still uncontrolled, and stop.
  console.log('\nReload guard');
  const lone = await browser.createBrowserContext();
  const stuck = await newPage(lone);
  await stuck.setBypassServiceWorker(true);
  const loads = hits(PREVIEW).length;
  await stuck.goto(ORIGIN + PREVIEW, { waitUntil: 'domcontentloaded' });
  await sleep(8000);
  check(hits(PREVIEW).length - loads === 2, 'a page the worker never controls reloads once and then stops', hits(PREVIEW).length - loads);
  check(await stuck.evaluate(() => !navigator.serviceWorker.controller && !!document.querySelector('#lobby')), '  …and still shows the page (without the shared files)');
  await lone.close();

  console.log(`\n${total - failed}/${total} checks passed · preview size ${mb} MB`);
} catch (e) {
  failed++;
  console.error('\n✖ ' + (e && e.stack || e));
} finally {
  await cleanup();
}
process.exit(failed ? 1 : 0);
