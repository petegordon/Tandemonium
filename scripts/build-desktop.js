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

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const DEST_DIR = path.join(ROOT, 'desktop');
const DEST = path.join(DEST_DIR, 'index.html');

let html = fs.readFileSync(SRC, 'utf-8');

// 1. Replace CDN script tags with local vendor paths
html = html.replace(
  /<script src="https:\/\/unpkg\.com\/qrcode-generator@1\.4\.4\/qrcode\.js"><\/script>/,
  '<script src="../vendor/qrcode-generator.js"></script>'
);
html = html.replace(
  /<script src="https:\/\/unpkg\.com\/peerjs@1\.5\.4\/dist\/peerjs\.min\.js"><\/script>/,
  '<script src="../vendor/peerjs.min.js"></script>'
);

// 2. Replace importmap CDN URLs with local node_modules paths
html = html.replace(
  '"https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js"',
  '"../node_modules/three/build/three.module.js"'
);
html = html.replace(
  '"https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/"',
  '"../node_modules/three/examples/jsm/"'
);

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
