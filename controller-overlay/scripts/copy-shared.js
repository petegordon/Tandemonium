#!/usr/bin/env node
// Copies repo-root shared/ modules into controller-overlay/src/shared/ so
// the Electron Forge packager picks them up. Without this the packaged
// overlay fails at runtime with module-not-found for ../../../shared/*
// (the relative import works in dev where Electron reads arbitrary paths,
// but breaks once the overlay is asar-packaged).
//
// Run as prestart (dev) AND prepackage (build). Mirrors the existing
// copy-three.js pattern.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const srcDir = path.join(repoRoot, 'shared');
const destDir = path.join(__dirname, '..', 'src', 'shared');

if (!fs.existsSync(srcDir)) {
  console.error(`ERROR: Could not find shared/ at ${srcDir}`);
  process.exit(1);
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Wipe destination first so renamed/deleted files don't linger.
if (fs.existsSync(destDir)) {
  fs.rmSync(destDir, { recursive: true, force: true });
}
copyRecursive(srcDir, destDir);
console.log(`Copied shared/ → ${path.relative(repoRoot, destDir)}`);
