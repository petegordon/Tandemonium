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
  /<script src="https:\/\/unpkg\.com\/qrcode-generator@1\.4\.4\/qrcode\.js"[^>]*><\/script>/,
  '<script src="vendor/qrcode-generator.js"></script>'
);
html = html.replace(
  /<script src="https:\/\/unpkg\.com\/peerjs@1\.5\.4\/dist\/peerjs\.min\.js"[^>]*><\/script>/,
  '<script src="vendor/peerjs.min.js"></script>'
);

// 2. Replace importmap CDN URLs with local node_modules paths
//    Import maps require URL-like specifiers (starting with ./ or ../)
html = html.replace(
  '"https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js"',
  '"../node_modules/three/build/three.module.js"'
);
html = html.replace(
  '"https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/"',
  '"../node_modules/three/examples/jsm/"'
);

// 3. Add <base href> so all relative paths (JS model loads, image src, etc.)
//    resolve from the project root instead of the desktop/ subdirectory.
//    This avoids needing to rewrite every asset path in JS source files.
html = html.replace('<head>', '<head>\n<base href="../">');

// 4. Inject secret controller combo: hold LT+RT + click L3+R3 for ~0.5s
//    → navigates to controller test page (Electron only)
const comboScript = `
<script>
// Secret combo: hold both triggers (LT+RT) + click both sticks (L3+R3)
// → navigates to controller test page
(function() {
  var TRIGGER_THRESHOLD = 0.8;
  var comboHeld = 0;
  function checkCombo() {
    var gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (var i = 0; i < gamepads.length; i++) {
      var gp = gamepads[i];
      if (!gp) continue;
      var lt = gp.buttons[6] ? gp.buttons[6].value : 0;
      var rt = gp.buttons[7] ? gp.buttons[7].value : 0;
      var l3 = !!(gp.buttons[10] && gp.buttons[10].pressed);
      var r3 = !!(gp.buttons[11] && gp.buttons[11].pressed);
      if (lt >= TRIGGER_THRESHOLD && rt >= TRIGGER_THRESHOLD && l3 && r3) {
        comboHeld++;
        if (comboHeld >= 30) {
          window.location.href = 'controller/index.html';
          return;
        }
      } else {
        comboHeld = 0;
      }
    }
    requestAnimationFrame(checkCombo);
  }
  requestAnimationFrame(checkCombo);
})();
</script>`;
html = html.replace('</body>', comboScript + '\n</body>');

fs.mkdirSync(DEST_DIR, { recursive: true });
fs.writeFileSync(DEST, html, 'utf-8');
console.log(`Generated ${path.relative(ROOT, DEST)}`);
