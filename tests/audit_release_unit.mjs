import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const root = new URL('../', import.meta.url);
test('release shell, icon manifest and update message share canonical version', () => {
  execFileSync(process.execPath, ['scripts/sync-release.mjs', '--check'], { cwd: root });
  const build = JSON.parse(fs.readFileSync(new URL('site/version.json', root))).build;
  const manifest = JSON.parse(fs.readFileSync(new URL('site/manifest.webmanifest', root)));
  for (const icon of manifest.icons) assert.equal(new URL(icon.src, 'https://test').searchParams.get('v'), build);
  const worker = fs.readFileSync(new URL('site/sw.js', root), 'utf8');
  assert.ok(worker.includes(`build: '${build}'`));
  assert.ok(worker.includes(`-${build}'`));
});
test('release synchronizer detects drift without writing, then updates all generated references', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangsuma-release-'));
  try {
    fs.mkdirSync(path.join(temp, 'site')); fs.mkdirSync(path.join(temp, 'scripts'));
    fs.copyFileSync(new URL('scripts/sync-release.mjs', root), path.join(temp, 'scripts/sync-release.mjs'));
    for (const file of ['index.html', 'pdf-browser.html', 'sw.js', 'manifest.webmanifest', 'version.json']) fs.copyFileSync(new URL(`site/${file}`, root), path.join(temp, 'site', file));
    fs.writeFileSync(path.join(temp, 'site/version.json'), JSON.stringify({ build: '2026.10.19.1' }));
    const before = fs.readFileSync(path.join(temp, 'site/manifest.webmanifest'), 'utf8');
    assert.equal(spawnSync(process.execPath, ['scripts/sync-release.mjs', '--check'], { cwd: temp }).status, 1);
    assert.equal(fs.readFileSync(path.join(temp, 'site/manifest.webmanifest'), 'utf8'), before);
    execFileSync(process.execPath, ['scripts/sync-release.mjs'], { cwd: temp });
    assert.equal(spawnSync(process.execPath, ['scripts/sync-release.mjs', '--check'], { cwd: temp }).status, 0);
    assert.ok(fs.readFileSync(path.join(temp, 'site/manifest.webmanifest'), 'utf8').includes('?v=2026.10.19.1'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
