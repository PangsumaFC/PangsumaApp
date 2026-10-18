#!/usr/bin/env node
// version.json is the canonical release identifier. Run before committing a release.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = JSON.parse(fs.readFileSync(path.join(root, 'site/version.json'), 'utf8')).build;
if (!/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(build)) throw new Error('Invalid release identifier');
const check = process.argv.includes('--check');
let stale = false;
for (const name of ['index.html', 'pdf-browser.html', 'sw.js', 'manifest.webmanifest']) {
  const file = path.join(root, 'site', name);
  const source = fs.readFileSync(file, 'utf8');
  let updated = source.replace(/\?v=\d{4}\.\d{2}\.\d{2}\.\d+/g, `?v=${build}`);
  if (name === 'index.html') updated = updated.replace(/(name="app-build" content=")[^"]+/, `$1${build}`).replace(/Versi \d{4}\.\d{2}\.\d{2}\.\d+/g, `Versi ${build}`);
  if (name === 'sw.js') updated = updated.replace(/const CACHE_NAME = '[^']+';/, `const CACHE_NAME = 'pangsuma-app-shell-v27-${build}';`).replace(/(type: 'APP_UPDATE_AVAILABLE', build: ')[^']+/, `$1${build}`);
  if (updated !== source) {
    stale = true;
    if (!check) fs.writeFileSync(file, updated);
    else console.error(`Release identifier out of sync: ${name}`);
  }
}
if (check && stale) process.exitCode = 1;
else console.log(`Release ${build}: ${check ? 'consistent' : 'synchronized'}`);
