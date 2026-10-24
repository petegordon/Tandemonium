#!/usr/bin/env node
/**
 * Generate desktop/index.html from root index.html.
 *
 * Rewrites:
 *  - CDN <script> tags → local vendor/ paths
 *  - importmap CDN URLs → local node_modules/three/ paths
 *
 * The web version (root index.html) is left untouched.
 */
const fs = require('fs');
const path = require('path');
const { localizeThree, installedThreeVersion } = require('../electron/local-vendors');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const DEST_DIR = path.join(ROOT, 'desktop');
const DEST = path.join(DEST_DIR, 'index.html');

let html = fs.readFileSync(SRC, 'utf-8');

// 1. Replace CDN script tags with local vendor paths
// (The QR generator is an ES import of shared/ui/third_party now, #424.)
// The tag carries integrity/crossorigin attributes, so match any attributes.
const peerTag = /<script src="https:\/\/unpkg\.com\/peerjs@1\.5\.4\/dist\/peerjs\.min\.js"[^>]*><\/script>/;
if (!peerTag.test(html)) throw new Error('build-desktop: PeerJS <script> tag not found in index.html');
html = html.replace(peerTag, '<script src="../vendor/peerjs.min.js"></script>');

// 2. Replace importmap CDN URLs with local node_modules paths — every three
//    entry (three, three/addons/, three/examples/jsm/), so the Draco decoder
//    under three/addons/libs/draco/ is local too (#353). Same rewrite
//    electron/main.js applies when it serves the root index.html.
const threeVersion = installedThreeVersion(ROOT);
const local = localizeThree(html, { prefix: '../', installedVersion: threeVersion });
if (local.count === 0) {
  throw new Error(`build-desktop: no three@${threeVersion || '?'} CDN URLs to localize in index.html ` +
    '(is node_modules/three installed at the version the importmap pins?)');
}
html = local.html;

// 3. Fix relative paths — desktop/index.html is one level deeper than root
//    js/game.js → ../js/game.js
html = html.replace(
  'src="js/game.js"',
  'src="../js/game.js"'
);
//    images/*.png → ../images/*.png
html = html.replace(/src="images\//g, 'src="../images/');

fs.mkdirSync(DEST_DIR, { recursive: true });
fs.writeFileSync(DEST, html, 'utf-8');
console.log(`Generated ${path.relative(ROOT, DEST)}`);
