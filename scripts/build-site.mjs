// Builds what the web game publishes into public/: only tracked pages and game assets.
// It copies files and rewrites addresses; it never runs anything from the tree it reads, so
// the PR preview workflow can use main's copy of this script on a branch's files.
//   node scripts/build-site.mjs --env staging [--root <checkout>] [--out <dir>] [--sha <commit>]
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

const STAGING_HEADERS = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
  X-Robots-Tag: noindex, nofollow
`;

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
  if (env !== 'staging') throw new Error('Only the staging build exists until the game moves to Cloudflare.');
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
    if (TEXT.test(file)) fs.writeFileSync(to, toStaging(fs.readFileSync(from, 'utf8')));
    else fs.copyFileSync(from, to);
    bytes += stat.size;
  }

  // No production Maps key on staging: Tourist Mode says it is unavailable.
  fs.writeFileSync(path.join(out, 'js', 'tourist-key.local.js'), 'window.__TOURIST_MAPS_KEY__ = "";\n');
  fs.writeFileSync(path.join(out, '_headers'), STAGING_HEADERS);

  const index = path.join(out, 'index.html');
  const stamp = `v.${(sha || 'local').slice(0, 7)} | staging`;
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
