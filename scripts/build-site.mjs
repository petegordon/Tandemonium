// Builds what the web game publishes into public/: only tracked pages and game assets.
// It copies files and rewrites addresses; it never runs anything from the tree it reads, so
// the PR preview workflow can use main's copy of this script on a branch's files.
//   node scripts/build-site.mjs --env staging|production [--root <checkout>] [--out <dir>] [--sha <commit>]
// Production reads the public Maps key from TOURIST_MAPS_KEY.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const ROOT_FILES = new Set(['index.html', 'tourist-lookup.html', 'achievements.json']);
const DIRS = ['assets', 'bike-customizer', 'controller', 'css', 'dashboard', 'goose-stage', 'goose-wardrobe',
  'images', 'js', 'migrate', 'model-viewer', 'remote', 'share', 'shared', 'tandem-3d'];
const NEVER = /(^|\/)(README[^/]*|CHANGELOG[^/]*|[^/]+\.md|[^/]+\.map|\.[^/]+)$/i;
const MAX_FILE = 25 * 1024 * 1024;
const TEXT = /\.(html?|m?js|json|css|svg|txt)$/i;

// Order matters only in that no replacement produces another entry's source text.
export const STAGING_HOSTS = [
  ['tandemonium-api.pete-872.workers.dev', 'api-staging.housetandem.com'],
  ['api.housetandem.com', 'api-staging.housetandem.com'],
  ['tandemonium-relay.pete-872.workers.dev', 'relay-staging.housetandem.com'],
  ['tandemonium-remote.housetandem.com', 'pad-staging.housetandem.com'],
  ['usersfirst-store.pete-872.workers.dev', 'store-staging.invalid'],
  ['tandemonium.housetandem.com', 'tandemonium-staging.housetandem.com'],
];

// ── Content policy ──
// Every page gets a Content-Security-Policy of its own: scripts run only from this site, from
// the three CDNs the import maps name, and from the page's own inline scripts (by their hash);
// the page connects only to our servers and the services the game uses. It is per page because
// the inline scripts differ, and one header line holding every page's hashes would be too long
// for the host. Hosts are written as production names and mapped for staging like the files.

/** Where module scripts and their own imports come from (the import maps; PeerJS on unpkg). */
const SCRIPT_HOSTS = ['https://cdn.jsdelivr.net', 'https://esm.sh', 'https://unpkg.com'];
/** Google's Maps script (Tourist's place search) and what it loads. */
const MAPS_SCRIPT_HOSTS = ['https://maps.googleapis.com', 'https://maps.gstatic.com'];
/** Our own servers: the account and game API, the ride relay, the phone-remote relay. */
const OUR_HOSTS = [
  'https://tandemonium-api.pete-872.workers.dev', 'https://api.housetandem.com',
  'https://tandemonium-relay.pete-872.workers.dev', 'wss://tandemonium-relay.pete-872.workers.dev',
  'https://tandemonium-remote.housetandem.com', 'wss://tandemonium-remote.housetandem.com',
  'https://tandemonium.housetandem.com', 'https://housetandem.com',
];
/**
 * Cloudflare Web Analytics: Cloudflare adds its visit-counting script to the pages it serves on
 * the live domain. Its two hosts, on production only (staging and previews are not counted).
 */
const BEACON_SCRIPT = 'https://static.cloudflareinsights.com';
const BEACON_REPORT = 'https://cloudflareinsights.com';
/** Services the game calls: Google Maps and 3D Tiles (Tourist), weather, the PeerJS broker, Google sign-in (dashboard). */
const SERVICE_HOSTS = [
  'https://*.googleapis.com', 'https://*.gstatic.com', 'https://*.google.com', 'https://api.open-meteo.com',
  'https://0.peerjs.com', 'wss://0.peerjs.com', 'https://accounts.google.com',
];

/** The sha256 source of every inline script on a page (an import map is one too). */
export function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]) || !m[2]) continue;
    // Browsers hash the script after turning CRLF into LF, so a Windows checkout must too.
    hashes.add(`'sha256-${crypto.createHash('sha256').update(m[2].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`);
  }
  return [...hashes].sort();
}

/**
 * One page's policy. `framed`: the page may be shown inside another (the Tourist lookup page,
 * which the desktop game embeds); every other page may only be framed by this site.
 */
export function pagePolicy(html, env, { framed = false } = {}) {
  const map = (list) => (env === 'staging' ? [...new Set(list.map(toStaging))] : list);
  const beacon = env === 'production';
  const scripts = ["'self'", ...inlineScriptHashes(html), ...SCRIPT_HOSTS, ...MAPS_SCRIPT_HOSTS, 'https://accounts.google.com',
    ...(beacon ? [BEACON_SCRIPT] : []), "'wasm-unsafe-eval'", 'blob:'];
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "worker-src 'self' blob:",
    `connect-src 'self' data: blob: ${[...map(OUR_HOSTS), ...SCRIPT_HOSTS, ...SERVICE_HOSTS, ...(beacon ? [BEACON_REPORT] : [])].join(' ')}`,
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    // (the Steam wishlist widget is a frame from the store)
    "frame-src 'self' https://accounts.google.com https://store.steampowered.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(framed ? [] : ["frame-ancestors 'self'"]),
  ].join('; ');
}

/** The addresses a published HTML file is served at (the host serves x.html as /x, and a folder's index as the folder). */
export function pagePaths(file) {
  if (file === 'index.html') return ['/', '/index.html'];
  if (file.endsWith('/index.html')) { const dir = '/' + file.slice(0, -'index.html'.length); return [dir, dir.slice(0, -1), dir + 'index.html']; }
  return ['/' + file.replace(/\.html$/, ''), '/' + file];
}

// Any site may read these public files, as on GitHub Pages (the website's account page does).
// The Tourist lookup page is embedded by the desktop game (tandemonium://app), so it alone may be framed.
// `pages`: [{ file, html }] for every published HTML file; each gets its own policy.
export function headersFile(env, pages = []) {
  const lines = [
    '/*',
    '  Access-Control-Allow-Origin: *',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: SAMEORIGIN',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    ...(env === 'production' ? ['  Strict-Transport-Security: max-age=31536000'] : ['  X-Robots-Tag: noindex, nofollow']),
    '/tourist-lookup*',
    '  ! X-Frame-Options',
  ];
  for (const { file, html } of pages) {
    const policy = pagePolicy(html, env, { framed: file === 'tourist-lookup.html' });
    for (const p of pagePaths(file)) lines.push(p, `  Content-Security-Policy: ${policy}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function isPublished(file) {
  if (NEVER.test(file)) return false;
  if (ROOT_FILES.has(file)) return true;
  if (/^test\/[^/]+\.html$/.test(file)) return true; // the in-game Dev Tools pages
  return DIRS.some((d) => file.startsWith(d + '/'));
}

export function toStaging(text) {
  let out = text;
  for (const [from, to] of STAGING_HOSTS) out = out.split(from).join(to);
  return out;
}

export function buildSite({ root = REPO, out = path.join(REPO, 'public'), env = 'staging', sha = '' } = {}) {
  if (env !== 'staging' && env !== 'production') throw new Error(`Unknown environment: ${env}`);
  if (sha && !/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error('bad --sha');
  const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0').filter(Boolean).filter(isPublished);

  fs.rmSync(out, { recursive: true, force: true });
  let bytes = 0;
  for (const file of tracked) {
    const from = path.join(root, file);
    const stat = fs.lstatSync(from, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) continue; // a branch cannot publish a link to somewhere else
    if (stat.size > MAX_FILE) throw new Error(`${file} is over Cloudflare's 25 MiB file limit`);
    const to = path.join(out, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (env === 'staging' && TEXT.test(file)) fs.writeFileSync(to, toStaging(fs.readFileSync(from, 'utf8')));
    else fs.copyFileSync(from, to);
    bytes += stat.size;
  }

  // No production Maps key on staging: Tourist Mode says it is unavailable.
  const mapsKey = env === 'production' ? (process.env.TOURIST_MAPS_KEY || '') : '';
  fs.writeFileSync(path.join(out, 'js', 'tourist-key.local.js'), `window.__TOURIST_MAPS_KEY__ = ${JSON.stringify(mapsKey)};\n`);

  const index = path.join(out, 'index.html');
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(new Date()).replace(',', '').replace(/\//g, '-');
  const stamp = `v.${(sha || 'local').slice(0, 7)} | ${env === 'production' ? when : 'staging'}`;
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/id="lobby-version">[^<]*/, `id="lobby-version">${stamp}`));

  // Headers last: each page's policy is made from the page as it is published.
  const pages = tracked.filter((f) => /\.html?$/i.test(f)).sort()
    .map((file) => ({ file, html: fs.readFileSync(path.join(out, file), 'utf8') }));
  fs.writeFileSync(path.join(out, '_headers'), headersFile(env, pages));
  return { out, files: tracked.length, mb: bytes / 1048576 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const r = buildSite({
    root: arg('--root') ? path.resolve(arg('--root')) : undefined,
    out: arg('--out') ? path.resolve(arg('--out')) : undefined,
    env: arg('--env') || 'staging',
    sha: arg('--sha') || '',
  });
  console.log(`Built ${r.files} files, ${r.mb.toFixed(1)} MB`);
}
