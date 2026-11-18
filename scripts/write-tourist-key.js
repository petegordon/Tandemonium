#!/usr/bin/env node
// Write js/tourist-key.local.js from the TOURIST_MAPS_KEY environment variable (the desktop builds in
// CI; scripts/gen-tourist-key.js does the same from .env on a dev machine). The file is gitignored and
// sets window.__TOURIST_MAPS_KEY__, which World Tourist reads (js/tourist-config.js). No key: an empty
// one is written and Tourist stays off, as before.
const fs = require('fs');
const path = require('path');

const key = process.env.TOURIST_MAPS_KEY || '';
const out = path.join(__dirname, '..', 'js', 'tourist-key.local.js');
fs.writeFileSync(out, 'window.__TOURIST_MAPS_KEY__ = ' + JSON.stringify(key) + ';\n');
console.log(key ? 'Wrote js/tourist-key.local.js (key present).' : 'Wrote js/tourist-key.local.js with no key: World Tourist stays off in this build.');
