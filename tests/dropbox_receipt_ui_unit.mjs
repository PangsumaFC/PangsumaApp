import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/report-evidence.js', import.meta.url), 'utf8');
const sandbox = { console, URL, crypto: globalThis.crypto, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox);
const evidence = sandbox.ReportEvidence;

const uploadMarkup = source.slice(source.indexOf('const owner = userCanUpload'), source.indexOf('const ctx = {', source.indexOf('const owner = userCanUpload')));
const prepareBlock = source.slice(source.indexOf('const prepare = async'), source.indexOf('if (ctx.input) ctx.input.addEventListener'));
const uploadHandler = source.slice(source.indexOf("if (ctx.file) ctx.file.addEventListener('click'"), source.indexOf('const dialog = container.closest'));

test('disclosure is rendered immediately before the upload action', () => {
  const disclosure = 'Foto disimpan di Dropbox; siapa pun yang memiliki tautannya dapat melihatnya.';
  assert.match(uploadMarkup, new RegExp(disclosure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(uploadMarkup.indexOf('receipt-dropbox-disclosure') < uploadMarkup.indexOf('receipt-upload'));
  assert.match(uploadMarkup, /Setuju &amp; unggah foto/);
});

test('preparing a preview does not call the API or grant consent', () => {
  assert.doesNotMatch(prepareBlock, /apiCall\(/);
  assert.doesNotMatch(prepareBlock, /dropboxPublicConsent/);
  assert.equal((source.match(/dropboxPublicConsent/g) || []).length, 1);
});

test('upload requires a prepared preview and sends consent only from the click handler', () => {
  assert.match(uploadHandler, /if \(!ctx\.prepared \|\| ctx\.uploading \|\| ctx\.processing\)/);
  assert.match(uploadHandler, /dropboxPublicConsent: true/);
  assert.match(uploadHandler, /body: payload/);
});

test('Dropbox links accept only HTTPS per-file share URLs and reject unsafe URLs', () => {
  assert.equal(evidence.validateDropboxUrl('https://www.dropbox.com/scl/fi/abc123/receipt.jpg?rlkey=xyz'), 'https://www.dropbox.com/scl/fi/abc123/receipt.jpg?rlkey=xyz');
  assert.equal(evidence.validateDropboxUrl('https://dropbox.com/s/abc123/receipt.jpg'), 'https://dropbox.com/s/abc123/receipt.jpg');
  for (const value of [
    'http://www.dropbox.com/s/abc123/receipt.jpg',
    'https://evil.example/s/abc123/receipt.jpg',
    'https://www.dropbox.com/home/receipts',
    'https://www.dropbox.com/scl/fi/abc123',
    'https://user:password@www.dropbox.com/s/abc123/receipt.jpg',
    'javascript:alert(1)',
  ]) assert.equal(evidence.validateDropboxUrl(value), '', value);
});

test('ready Dropbox link is safely rendered as a new-tab external link', () => {
  assert.match(source, /dropboxUrl\(item\.dropboxUrl\)/);
  assert.match(source, /href="\$\{esc\(shared\)\}" target="_blank" rel="noopener noreferrer"/);
});
