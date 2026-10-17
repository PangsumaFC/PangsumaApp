import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../site/sw.js', import.meta.url), 'utf8');
const version = JSON.parse(fs.readFileSync(new URL('../site/version.json', import.meta.url), 'utf8'));

test('release exposes matching build metadata and Manager update banner', () => {
  assert.match(version.build, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
  assert.equal(html.match(/name="app-build" content="([^"]+)"/)[1], version.build);
  assert.ok(app.includes('meta[name="app-build"]'));
  for (const asset of ['app.js', 'report-filters.js', 'financial-controls.js', 'report-evidence.js', 'bounded-history.js']) assert.ok(html.includes(`/${asset}?v=${version.build}`));
  assert.match(html, /id="appUpdateBanner"[^>]*hidden/);
  assert.match(html, /id="appUpdateReload"[^>]*>Muat ulang/);
  assert.match(app, /state\.user\?\.role === 'manager'/);
  assert.match(app, /fetch\(`\/version\.json\?check=\$\{Date\.now\(\)\}`/);
  assert.match(app, /cache: 'no-store'/);
});

test('reload is explicit and asks before discarding changed form fields', () => {
  assert.match(app, /hasUnsavedDraft\(\)/);
  assert.match(app, /window\.confirm\('Ada draf yang belum disimpan/);
  assert.match(app, /window\.location\.reload\(\)/);
  assert.doesNotMatch(app, /checkForAppUpdate\(\)[\s\S]{0,300}location\.reload/);
});

test('version endpoint bypasses service worker cache and shell cache is versioned', () => {
  assert.match(worker, /CACHE_NAME = 'pangsuma-app-shell-v[0-9]+-/);
  assert.match(worker, /url\.pathname === '\/version\.json'\) return/);
});
