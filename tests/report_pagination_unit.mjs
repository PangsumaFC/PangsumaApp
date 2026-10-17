import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor, filterHash } from '../functions/_lib/report-pagination.js';

const filters = { period: '', startDate: '', endDate: '', q: 'alpha', applicant: '', type: '', status: '' };
test('report cursor is opaque, filter-bound, and validates its snapshot/key', () => {
  const token = encodeCursor({ v: 1, direction: 'after', snapshotAt: '2025-05-20T12:00:00.000Z', filterHash: filterHash(filters), key: ['2025-05-20', '2025-05-20T11:00:00.000Z', 'sub-001'] });
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(token, filters).key, ['2025-05-20', '2025-05-20T11:00:00.000Z', 'sub-001']);
  assert.throws(() => decodeCursor(token, { ...filters, q: 'different' }), /Cursor laporan/);
  assert.throws(() => decodeCursor(`${token.slice(0, -1)}!`, filters), /Cursor laporan/);
});
