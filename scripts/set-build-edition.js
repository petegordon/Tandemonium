#!/usr/bin/env node
// Stamp which game a build is into js/edition-build.js: `node scripts/set-build-edition.js demo|full`.
// A build step, run on a checkout that is about to be packaged or published. Never commit the result
// of `demo`: the repo holds 'full' (test/unit/edition.test.mjs checks that).
const fs = require('fs');
const path = require('path');

const edition = process.argv[2];
if (edition !== 'demo' && edition !== 'full') {
  console.error('Usage: node scripts/set-build-edition.js demo|full');
  process.exit(1);
}
const file = path.join(__dirname, '..', 'js', 'edition-build.js');
const src = fs.readFileSync(file, 'utf8');
const line = /export const BUILD_EDITION = '(?:full|demo)';/;
if (!line.test(src)) {
  console.error('js/edition-build.js has no BUILD_EDITION line to rewrite.');
  process.exit(1);
}
fs.writeFileSync(file, src.replace(line, `export const BUILD_EDITION = '${edition}';`));
console.log(`js/edition-build.js: this build is the ${edition === 'demo' ? 'demo' : 'full game'}.`);
