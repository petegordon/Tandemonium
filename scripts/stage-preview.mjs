#!/usr/bin/env node
// ============================================================
// stage-preview.mjs — build the folder a pull-request preview publishes
// ============================================================
//
// .github/workflows/pr-preview.yml runs this, and pr-preview-action then
// publishes the result at https://tandemonium.housetandem.com/pr-preview/pr-<N>/.
// scripts/smoke-preview-fallback.mjs runs it too, so the test exercises the
// same staging the workflow does.
//
//   node scripts/stage-preview.mjs --out _site --pr 760 --sha <head commit> --base HEAD^1
//
//   --out   folder to build (created; must not already hold a preview)
//   --pr    pull request number
//   --sha   the pull request's head commit (stamped into the page)
//   --base  what to compare the heavy folders against (default origin/main)
//   --src   the checkout to stage (default: the current directory)
//
// What a preview is (#760). The game is ~340 MB, nearly all of it in the heavy
// folders below, and GitHub Pages allows 1 GB per site. A full copy per
// preview meant the live game plus two open previews broke publishing. So:
//
//   - Everything outside the heavy folders is published as before.
//   - A file in a heavy folder is published only if the pull request added or
//     changed it (git diff against the base). Unchanged ones are left out.
//   - A left-out file is fetched from the live game by a small service worker
//     that only previews have (scripts/preview-sw.js, copied to the preview
//     root here, with the list of heavy files this preview did publish written
//     into it). Every page of the preview gets a short script at the top of
//     <head> that registers the worker and reloads once when it is in charge.
//
// None of this touches the live site (deploy.yml stages that itself), the
// repository's own index.html, or the desktop build.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Folders (relative to the site root) whose unchanged files a preview leaves out. */
export const HEAVY_DIRS = ['tandem-3d', 'assets', 'images', 'goose-stage/reels'];

/** Where the service worker lands in the preview, and the name the pages register. */
export const SW_FILE = 'preview-sw.js';

// Never published. The same names pr-preview.yml's rsync used to exclude; like
// rsync's --exclude=NAME, a name matches at any depth (assets/ has .gitignore
// files of its own).
const NEVER = new Set(['.git', '.github', '.gitignore', 'node_modules', 'out', 'desktop', 'electron', 'scripts', '.env']);

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Run git in `cwd` and return its NUL-separated output as a list (paths with spaces survive). */
function gitList(cwd, args) {
  const out = execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

const inHeavyDir = (file) => HEAVY_DIRS.some((dir) => file.startsWith(dir + '/'));

/**
 * A heavy file is one the preview may leave out. Pages are not: an .html file
 * inside a heavy folder (tandem-3d/index.html) is small, and it has to carry
 * the registration script, or opening it directly would load a page whose
 * assets all 404.
 */
export const isHeavy = (file) => inHeavyDir(file) && !/\.html?$/i.test(file);

/** Every tracked file the site publishes (heavy ones included), as repo-relative paths with '/'. */
export function publishableFiles(src) {
  return gitList(src, ['ls-files', '-z'])
    .filter((file) => !file.split('/').some((part) => NEVER.has(part)))
    // Tracked but deleted in the working copy (only ever true locally).
    .filter((file) => fs.existsSync(path.join(src, file)));
}

/**
 * Heavy files the pull request added or changed, compared with `base`.
 * `base...HEAD` is "what HEAD changed since it left base", so files that only
 * the base branch touched are not counted. --no-renames reports a renamed file
 * as an added one under its new name, which is what we want to publish, and
 * needs no file contents to work out.
 */
export function changedHeavyFiles(src, base) {
  if (!base || base.startsWith('-')) throw new Error(`bad --base: ${JSON.stringify(base)}`);
  let files;
  try {
    files = gitList(src, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=AMR', `${base}...HEAD`, '--', ...HEAVY_DIRS]);
  } catch (e) {
    // Do not guess. Publishing nothing heavy would hide the PR's own art, and
    // publishing everything heavy is the 340 MB preview this script removes.
    throw new Error(`could not compare with ${base} (is the checkout deep enough to contain it?)\n${e.stderr || e.message}`);
  }
  return new Set(files);
}

/**
 * The script each preview page runs first. It has to come before anything that
 * loads a heavy file, because only a page the worker controls gets the
 * fallback, and a first visit is not controlled yet.
 *
 *   not controlled at the start → wait for an active worker, then reload once;
 *                                 the reloaded page is controlled from its
 *                                 first request. This also covers a forced
 *                                 reload (Shift+Reload), which skips the worker.
 *   controlled, and a newer worker takes over (a new build of the preview was
 *   published)                  → reload once, so nothing on the page was
 *                                 fetched by the old build's worker. The page
 *                                 asks for that check itself (update()): left
 *                                 to the browser it can come much later, and
 *                                 register() alone does not look for a new file.
 *                                 Only in the page's first 20 seconds: on a
 *                                 slow device the check can take longer, and
 *                                 reloading a ride in progress is worse than
 *                                 one session with an old worker.
 *   no service workers at all   → the page loads as it is; files the preview
 *                                 left out will be missing. (Pages is https, so
 *                                 this is only very old or locked-down browsers.)
 *
 * The guard against a reload loop: the time of the last reload is kept in
 * sessionStorage, and there is no second one within ten seconds. So a browser
 * where the worker never takes control reloads once and then stays put.
 */
export function registrationScript(scope) {
  // sessionStorage can throw (blocked storage). Then never reload: that is
  // safe, and reloading forever is not.
  const js = `(function(){
var S=${JSON.stringify(scope)},K='preview-sw-reloaded:'+S,sw=navigator.serviceWorker;
if(!sw){console.warn('[preview] no service worker support: files this preview shares with the live game will be missing');return;}
function reloadOnce(why){
try{if(Date.now()-Number(sessionStorage.getItem(K)||0)<10000){console.warn('[preview] not reloading again ('+why+')');return;}sessionStorage.setItem(K,String(Date.now()));}catch(e){return;}
location.reload();}
var controlled=!!sw.controller;
sw.register(S+${JSON.stringify(SW_FILE)},{scope:S,updateViaCache:'none'}).then(function(r){if(controlled)return r.update();}).catch(function(e){console.warn('[preview] service worker failed to register or update',e);});
if(controlled)sw.addEventListener('controllerchange',function(){if(performance.now()<20000)reloadOnce('a newer build took over');else console.warn('[preview] a newer build took over; reload to be sure every file is from it');});
else sw.ready.then(function(){reloadOnce('the service worker is still not in control');});
})();`;
  // <meta charset> leads: a browser only looks for it in the first 1024 bytes,
  // and this script would otherwise push the page's own one past that.
  return `<meta charset="UTF-8"><script>/* PR preview only (scripts/stage-preview.mjs): unchanged heavy files come from the live game through ${SW_FILE} */${js}</script>`;
}

/** Put `html` straight after the first <head> tag. Returns null if the page has none. */
function afterHead(page, html) {
  const m = /<head(\s[^>]*)?>/i.exec(page);
  if (!m) return null;
  const at = m.index + m[0].length;
  return page.slice(0, at) + html + page.slice(at);
}

/** "11-17-2026 14:05" in Eastern time: the format the lobby footer has always shown. */
function stampTime(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day}-${p.year} ${p.hour}:${p.minute}`;
}

function dirSize(dir) {
  let bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    bytes += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return bytes;
}

/**
 * Stage one preview. Returns what it did, for the log and for the smoke test.
 */
export function stagePreview({ src = process.cwd(), out, pr, sha, base = 'origin/main', now = new Date() }) {
  if (!/^[1-9]\d*$/.test(String(pr))) throw new Error(`bad --pr: ${JSON.stringify(pr)}`);
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new Error(`bad --sha: ${JSON.stringify(sha)}`);
  if (!out) throw new Error('missing --out');
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`--out is not empty: ${out}`);

  const scope = `/pr-preview/pr-${pr}/`;
  const changed = changedHeavyFiles(src, base);
  const all = publishableFiles(src);

  // 1 · Copy: everything light, and the heavy files this pull request changed.
  const heavyKept = [];
  let heavyLeftOut = 0;
  const pages = [];
  // Everything published under a heavy folder (changed files, and pages): the
  // worker serves these from the preview and everything else there from live.
  const own = [];
  for (const file of all) {
    if (isHeavy(file)) {
      if (!changed.has(file)) { heavyLeftOut++; continue; }
      heavyKept.push(file);
    }
    if (inHeavyDir(file)) own.push(file);
    const to = path.join(out, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, file), to);
    if (/\.html?$/i.test(file)) pages.push(file);
  }

  // 2 · The service worker, at the preview root so its scope is the whole
  // preview. Taken from beside this script (scripts/ itself is not published),
  // with two lines filled in: the heavy folders (one list, not two) and the
  // files this preview published in them.
  const fill = (text, marker, value) => {
    const line = new RegExp(`^(const \\w+ = ).*%%${marker}%%.*$`, 'm');
    if (!line.test(text)) throw new Error(`scripts/preview-sw.js has no %%${marker}%% line to fill in`);
    return text.replace(line, (_, start) => `${start}${value};`);
  };
  let worker = fs.readFileSync(path.join(HERE, 'preview-sw.js'), 'utf8');
  worker = fill(worker, 'HEAVY_DIRS', JSON.stringify(HEAVY_DIRS));
  worker = fill(worker, 'OWN_FILES', `new Set(${JSON.stringify(own)})`);
  fs.writeFileSync(path.join(out, SW_FILE), worker);

  // 3 · Every page registers the worker before anything else in <head>.
  // (index.html is the game, but remote/, goose-stage/ and the rest are opened
  // directly too, a phone scanning the remote's QR code for one.)
  const register = registrationScript(scope);
  const unregistered = [];
  for (const file of pages) {
    const f = path.join(out, file);
    const page = afterHead(fs.readFileSync(f, 'utf8'), register);
    if (page === null) { unregistered.push(file); continue; }
    fs.writeFileSync(f, page);
  }

  // 4 · The game page's own stamps, as pr-preview.yml always made them.
  const hash = String(sha).slice(0, 7);
  const time = stampTime(now);
  const indexFile = path.join(out, 'index.html');
  let index = fs.readFileSync(indexFile, 'utf8');
  // After the registration script: <base> so relative asset paths resolve from
  // the preview folder (custom domain, so there is no /repo-name/ prefix), and
  // the build identity js/build-badge.js reads.
  const reg = index.indexOf(register) + register.length;
  index = index.slice(0, reg)
    + `<base href="${scope}"><script>window.__BUILD={sha:'${hash}',pr:${pr},time:'${time}'}</script>`
    + index.slice(reg);
  // The lobby footer shows which build this is. The PR's head commit, not
  // HEAD: on pull_request that is a merge commit matching nothing in `git log`.
  index = index.replace(/id="lobby-version">[^<]*/, `id="lobby-version">v.${hash} | ${time} (PR #${pr})`);
  fs.writeFileSync(indexFile, index);
  // version.json lets an open page spot a newer deploy; the sha stamped into
  // the module lets it spot stale cached game files.
  fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ sha: hash, pr: Number(pr), time }));
  const badge = path.join(out, 'js', 'build-badge.js');
  fs.writeFileSync(badge, fs.readFileSync(badge, 'utf8').replace('%%MODULE_SHA%%', hash));

  return { scope, heavyKept, heavyLeftOut, pages, unregistered, bytes: dirSize(out) };
}

// ── Command line ──
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  try {
    const r = stagePreview({ src: args.src ? path.resolve(args.src) : process.cwd(), out: args.out && path.resolve(args.out), pr: args.pr, sha: args.sha, base: args.base });
    console.log(`Preview staged for ${r.scope}`);
    console.log(`  heavy files left out (served from the live game): ${r.heavyLeftOut}`);
    console.log(`  heavy files published (added or changed by this pull request): ${r.heavyKept.length}`);
    for (const f of r.heavyKept) console.log(`    ${f}`);
    if (r.unregistered.length) console.log(`  pages with no <head> (no service worker registration): ${r.unregistered.join(', ')}`);
    console.log(`  size: ${(r.bytes / 1048576).toFixed(1)} MB`);
  } catch (e) {
    console.error(`stage-preview: ${e.message}`);
    process.exit(1);
  }
}
