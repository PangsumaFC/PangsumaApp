import test from 'node:test';
import assert from 'node:assert/strict';
import '../site/bounded-history.js';

const makePages = (total = 205) => {
  const all = Array.from({ length: total }, (_, i) => ({ id: `r${i + 1}` }));
  const page = cursor => {
    const start = cursor ? Number(cursor) : 0;
    const rows = all.slice(start, start + 100);
    return { submissions: rows, nextCursor: start + rows.length < all.length ? String(start + rows.length) : null, hasMore: start + rows.length < all.length, total: all.length };
  };
  return { all, page };
};

function setup({ role = 'user', api, epoch = () => 1, onError } = {}) {
  let rows = [];
  const changes = [];
  globalThis.BoundedHistory.reset();
  globalThis.BoundedHistory.configure({
    api: api || (async path => ({ submissions: [], nextCursor: null, hasMore: false, total: 0 })),
    getUser: () => ({ id: 'u1', role }), getEpoch: epoch,
    getRows: () => rows, setRows: (_collection, next) => { rows = next; },
    setPage: () => {}, onChange: (c, next) => changes.push([c, next]), onError
  });
  return { getRows: () => rows, changes };
}

test('replaces the current window and traverses all 205 records without duplicates', async () => {
  const { all, page } = makePages();
  const calls = [];
  const ctx = setup({ api: async path => { calls.push(path); return page(new URL(`https://x${path}`, 'https://x').searchParams.get('cursor')); } });
  await globalThis.BoundedHistory.load('submissions', 'first');
  assert.equal(ctx.getRows().length, 100);
  await globalThis.BoundedHistory.load('submissions', 'next');
  assert.equal(ctx.getRows().length, 100);
  await globalThis.BoundedHistory.load('submissions', 'next');
  assert.equal(ctx.getRows().length, 5);
  assert.deepEqual(ctx.getRows().map(x => x.id), all.slice(200).map(x => x.id));
  assert.equal(new Set(ctx.changes.flatMap(([, rows]) => rows.map(x => x.id))).size, 205);
  assert.deepEqual(calls, ['/history/submissions', '/history/submissions?cursor=100', '/history/submissions?cursor=200']);
});

test('previous and next refetch the exact cursor and preserve page ordering', async () => {
  const { page } = makePages();
  const calls = [];
  const ctx = setup({ api: async path => { calls.push(path); return page(new URL(`https://x${path}`, 'https://x').searchParams.get('cursor')); } });
  await globalThis.BoundedHistory.load('submissions', 'first');
  const first = ctx.getRows().map(x => x.id);
  await globalThis.BoundedHistory.load('submissions', 'next');
  await globalThis.BoundedHistory.load('submissions', 'previous');
  assert.deepEqual(ctx.getRows().map(x => x.id), first);
  assert.equal(globalThis.BoundedHistory.controlsMeta('submissions').pageNumber, 1);
  await globalThis.BoundedHistory.load('submissions', 'next');
  assert.equal(calls.at(-1), '/history/submissions?cursor=100');
});

test('failed next keeps the page and retries the same cursor; concurrent click is one fetch', async () => {
  const { page } = makePages(); let calls = 0; let fail = true; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = setup({ api: async path => { calls++; if (path.includes('cursor=100') && fail) { fail = false; throw new Error('temporary'); } if (path.includes('cursor=100')) await gate; return page(new URL(`https://x${path}`, 'https://x').searchParams.get('cursor')); } });
  await globalThis.BoundedHistory.load('submissions', 'first');
  const before = ctx.getRows();
  await globalThis.BoundedHistory.load('submissions', 'next');
  assert.strictEqual(ctx.getRows(), before);
  const first = globalThis.BoundedHistory.load('submissions', 'next');
  const second = globalThis.BoundedHistory.load('submissions', 'next');
  assert.strictEqual(first, second); release(); await first;
  assert.equal(calls, 3);
});

test('stale epoch response is ignored and reset invalidates an old response', async () => {
  let currentEpoch = 1; let release; const gate = new Promise(resolve => { release = resolve; });
  const ctx = setup({ epoch: () => currentEpoch, api: async () => { await gate; return { submissions: [{ id: 'old' }], total: 1, hasMore: false }; } });
  const pending = globalThis.BoundedHistory.load('submissions', 'first'); currentEpoch = 2; release(); await pending;
  assert.deepEqual(ctx.getRows(), []);
  const pending2 = globalThis.BoundedHistory.load('submissions', 'first'); globalThis.BoundedHistory.reset(); release(); await pending2;
  assert.deepEqual(ctx.getRows(), []);
});

test('user cannot request manager-only history and cursor trail is bounded', async () => {
  let calls = 0;
  setup({ api: async () => { calls++; return { cashLedger: [], total: 0 }; } });
  await globalThis.BoundedHistory.load('cashLedger', 'first');
  assert.equal(calls, 0);
  const pages = makePages(21001);
  setup({ role: 'manager', api: async path => pages.page(new URL(`https://x${path}`, 'https://x').searchParams.get('cursor')) });
  await globalThis.BoundedHistory.load('submissions', 'first');
  for (let i = 0; i < 205; i++) await globalThis.BoundedHistory.load('submissions', 'next');
  assert.ok(globalThis.BoundedHistory.__teststateCount() <= 200);
  assert.equal(globalThis.BoundedHistory.controlsMeta('submissions').cursorHistoryTruncated, true);
});
