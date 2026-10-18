import test from 'node:test';
import assert from 'node:assert/strict';
import '../site/bounded-history.js';
test('refresh refetches the current cursor without resetting page or adding a cursor step', async () => {
  const calls = [];
  BoundedHistory.reset();
  BoundedHistory.configure({ getUser: () => ({ id: 'u', role: 'user' }), getEpoch: () => 1,
    api: async path => { calls.push(path); const start = Number(new URL(`https://x${path}`).searchParams.get('cursor') || 0); return { submissions: [{ id: start }], nextCursor: String(start + 100), hasMore: true, total: 205 }; },
  });
  await BoundedHistory.load('submissions', 'first');
  await BoundedHistory.load('submissions', 'next');
  assert.equal(BoundedHistory.controlsMeta('submissions').pageNumber, 2);
  await BoundedHistory.load('submissions', 'refresh');
  assert.equal(calls.at(-1), '/history/submissions?cursor=100');
  assert.equal(BoundedHistory.controlsMeta('submissions').pageNumber, 2);
  await BoundedHistory.load('submissions', 'previous');
  assert.equal(BoundedHistory.controlsMeta('submissions').pageNumber, 1);
});
