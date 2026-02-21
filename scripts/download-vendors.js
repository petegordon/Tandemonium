#!/usr/bin/env node
/**
 * Download CDN dependencies locally into vendor/ for offline Electron builds.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor');

const DOWNLOADS = [
  {
    url: 'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js',
    dest: 'qrcode-generator.js',
  },
  {
    url: 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
    dest: 'peerjs.min.js',
  },
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  for (const { url, dest } of DOWNLOADS) {
    const outPath = path.join(VENDOR_DIR, dest);
    if (fs.existsSync(outPath)) {
      console.log(`  [skip] ${dest} (already exists)`);
      continue;
    }
    process.stdout.write(`  Downloading ${dest}...`);
    const data = await fetch(url);
    fs.writeFileSync(outPath, data, 'utf-8');
    console.log(` done (${(data.length / 1024).toFixed(1)} KB)`);
  }

  console.log('Vendor downloads complete.');
}

main().catch((err) => {
  console.error('Download failed:', err);
  process.exit(1);
});
