// Builds what the web game publishes into public/: only tracked pages and game assets.
// It copies files and rewrites addresses; it never runs anything from the tree it reads, so
// the PR preview workflow can use main's copy of this script on a branch's files.
//   node scripts/build-site.mjs --env staging|production [--root <checkout>] [--out <dir>] [--sha <commit>]
// Production reads the public Maps key from TOURIST_MAPS_KEY.
import { execFileSync } from 'node:child_process';
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

// Any site may read these public files, as on GitHub Pages (the website's account page does).
// The Tourist lookup page is embedded by the desktop game (tandemonium://app), so it alone may be framed.
export function headersFile(env) {
  return [
    '/*',
    '  Access-Control-Allow-Origin: *',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: SAMEORIGIN',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    ...(env === 'production' ? ['  Strict-Transport-Security: max-age=31536000'] : ['  X-Robots-Tag: noindex, nofollow']),
    '/tourist-lookup*',
    '  ! X-Frame-Options',
    '',
  ].join('\n');
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
  fs.writeFileSync(path.join(out, '_headers'), headersFile(env));

  const index = path.join(out, 'index.html');
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(new Date()).replace(',', '').replace(/\//g, '-');
  const stamp = `v.${(sha || 'local').slice(0, 7)} | ${env === 'production' ? when : 'staging'}`;
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/id="lobby-version">[^<]*/, `id="lobby-version">${stamp}`));
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
