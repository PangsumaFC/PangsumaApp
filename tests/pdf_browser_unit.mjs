import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/pdf-browser.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../site/pdf-browser.html', import.meta.url), 'utf8');

test('legacy bookmarks point to Finance without any PDF download action', () => {
  assert.match(html, /Laporan tersedia di Finance/);
  assert.match(html, /href="\/">Buka aplikasi/);
  assert.doesNotMatch(html, /id="downloadPdf"|id="checkSession"|export\.pdf|data-action="download-pdf"|target="_blank"/);
  assert.doesNotMatch(source, /fetch\(|export\.pdf|localStorage|sessionStorage|window\.open|clipboard|location\.search/);
});
for (const apk of [false, true]) test(`legacy page is read-only and keeps the confirmed APK limit: apk=${apk}`, () => {
  const nodes = { browserInstructions:{ hidden:false }, sessionStatus:{ textContent:'Finance' } };
  vm.runInNewContext(source, { window:apk ? { PangsumaFileBridge:{} } : {}, document:{ readyState:'complete', getElementById:id=>nodes[id] } });
  assert.equal(nodes.browserInstructions.hidden, apk);
  assert.equal(nodes.sessionStatus.textContent, apk ? 'Unduh PDF langsung memerlukan APK yang diperbarui.' : 'Finance');
});
test('legacy information page assets use the application release tag', () => {
  const build = JSON.parse(fs.readFileSync(new URL('../site/version.json', import.meta.url), 'utf8')).build;
  const tags = [...html.matchAll(/(?:src|href)="\/pdf-browser\.(?:js|css)\?v=([^"]+)"/g)];
  assert.equal(tags.length, 2);
  for (const [, version] of tags) assert.equal(version, build);
});
