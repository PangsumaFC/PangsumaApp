import test from 'node:test';
import assert from 'node:assert/strict';
import { dropboxPath, isCanonicalRequestNumber } from '../functions/_lib/dropbox-receipts.js';

test('request numbers use the exact compact PC and RF format for evidence names', () => {
  assert.equal(isCanonicalRequestNumber('PC112026000001'), true);
  assert.equal(isCanonicalRequestNumber('RF012027000010'), true);
  for (const value of ['PC002026000001','PC132026000001','PC112026000000','XX112026000001','PC/11/2026/000001','PC-11-2026-000001','PC11202600001','../PC112026000001']) assert.equal(isCanonicalRequestNumber(value), false, value);
  assert.equal(dropboxPath('receipt-1', 'image/jpeg', 'PC112026000001', 1, '.jpeg'), '/Pengajuan Pangsuma/PC112026000001/receipt-1/PC112026000001.jpeg');
});

test('additional evidence keeps the validated source extension and ordinal suffix', () => {
  assert.equal(dropboxPath('receipt-2', 'image/jpeg', 'RF022026000002', 2, '.jpg'), '/Pengajuan Pangsuma/RF022026000002/receipt-2/RF022026000002-01.jpg');
  assert.equal(dropboxPath('receipt-3', 'image/png', 'RF022026000002', 3, '.png'), '/Pengajuan Pangsuma/RF022026000002/receipt-3/RF022026000002-02.png');
});

test('legacy callers retain the historical UUID Dropbox path', () => {
  assert.equal(dropboxPath('receipt-legacy', 'image/png'), '/Pengajuan Pangsuma/receipt-legacy.png');
});
