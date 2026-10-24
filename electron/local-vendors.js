// ============================================================
// LOCAL VENDORS — serve three.js (and the Draco decoder) offline (#353)
// ============================================================
// The root index.html importmap pulls three from jsdelivr, pinned to an exact
// version ("three@0.161.0"). The desktop app ships three in node_modules (it is
// a runtime dependency, so Forge packages it), so electron/main.js rewrites the
// importmap on the fly when it serves index.html, and scripts/build-desktop.js
// does the same for desktop/index.html. js/draco-path.js resolves the Draco
// decoder relative to three/addons/, so once three is local the decoder
// (node_modules/three/examples/jsm/libs/draco/) is local too.
//
// The rewrite only happens when the installed three is the exact version the
// importmap pins. On a mismatch (or no three installed) the CDN URLs are left
// alone, so the game never mixes two three versions.

const fs = require('fs');
const path = require('path');

const THREE_CDN = /https:\/\/cdn\.jsdelivr\.net\/npm\/three@(\d+\.\d+\.\d+)\//g;

/**
 * Rewrite every pinned-version three CDN URL in `html` to `${prefix}node_modules/three/`.
 * @param {string} html
 * @param {{ prefix?: string, installedVersion?: string | null }} [opts]
 *   prefix: path from the page to the app root ('/' for tandemonium://app/, '../' for desktop/).
 *   installedVersion: version of node_modules/three; null/undefined leaves the CDN URLs alone.
 * @returns {{ html: string, count: number }}
 */
function localizeThree(html, { prefix = '/', installedVersion = null } = {}) {
  let count = 0;
  if (!installedVersion) return { html, count };
  const out = html.replace(THREE_CDN, (match, version) => {
    if (version !== installedVersion) return match;
    count++;
    return `${prefix}node_modules/three/`;
  });
  return { html: out, count };
}

/** Version of the three package under `rootDir`/node_modules (asar paths work), or null. */
function installedThreeVersion(rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'node_modules', 'three', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

module.exports = { localizeThree, installedThreeVersion };
