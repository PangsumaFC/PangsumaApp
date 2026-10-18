import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';
import { insertAudit, insertSubmission, request, seededFinancialDb } from './local_financial_db.mjs';

async function call(db, path, token, options = {}) { const response = await onRequest({ request: request(path, token, options), env: { DB: db } }); return { response, body: await response.json().catch(() => null) }; }

test('activity endpoint enforces owner/manager visibility and returns actual actor/details', async () => {
  const { db, managerToken, userAToken, userBToken } = await seededFinancialDb();
  const id = '11111111-1111-4111-8111-111111111111';
  insertSubmission(db, { id, description: 'Dana kegiatan alpha', amount: 2500 });
  insertAudit(db, { entityId: id, actorId: 'user-a', details: { amount_idr: 2500 }, createdAt: '2028-01-15T04:00:00.000Z' });
  db.db.prepare("UPDATE submissions SET status='approved', resolved_by='manager-1', updated_by='manager-1', decision_reason='Disetujui untuk kegiatan', updated_at='2028-01-16T04:00:00.000Z' WHERE id=?").run(id);
  const own = await call(db, `/submissions/${id}/activity`, userAToken);
  assert.equal(own.response.status, 200); assert.equal(own.body.submission.createdByName, 'User Alpha');
  assert.equal(own.body.activity.length, 2);
  assert.equal(own.body.activity[0].actorName, 'User Alpha');
  assert.equal(own.body.activity[1].actorName, 'Manager Test');
  assert.equal(own.body.activity[1].details.reason, 'Disetujui untuk kegiatan');
  assert.equal(own.body.submission.decisionReason, 'Disetujui untuk kegiatan');
  assert.equal((await call(db, `/submissions/${id}/activity`, userBToken)).response.status, 404);
  assert.equal((await call(db, `/submissions/${id}/activity`, managerToken)).response.status, 200);
  assert.equal((await call(db, `/submissions/${id}/activity`, null)).response.status, 401);
  assert.equal((await call(db, `/submissions/${id}/activity`, managerToken, { method: 'POST' })).response.status, 405);
  assert.equal((await call(db, '/submissions/not-a-uuid/activity', managerToken)).response.status, 404);
});

test('activity cursor paginates without duplicate event IDs', async () => {
  const { db, managerToken } = await seededFinancialDb();
  const id = '22222222-2222-4222-8222-222222222222';
  insertSubmission(db, { id, createdAt: '2028-01-01T01:00:00.000Z', updatedAt: '2028-01-01T01:00:00.000Z' });
  for (let i = 0; i < 101; i++) insertAudit(db, { entityId: id, actorId: i % 2 ? 'manager-1' : 'user-a', action: 'submission.status_changed', details: { from: 'pending', to: 'approved', reason: `reason-${i}` }, createdAt: `2028-01-01T01:${String(i % 60).padStart(2, '0')}:00.000Z` });
  const first = await call(db, `/submissions/${id}/activity?limit=5`, managerToken);
  assert.equal(first.body.activity.length, 5); assert.equal(first.body.hasMore, true); assert.ok(first.body.nextCursor);
  const all = [...first.body.activity]; let cursor = first.body.nextCursor;
  while (cursor) {
    const page = await call(db, `/submissions/${id}/activity?limit=5&cursor=${cursor}`, managerToken);
    all.push(...page.body.activity); cursor = page.body.nextCursor || '';
    if (!page.body.hasMore) break;
  }
  const ids = all.map(e => e.id);
  assert.equal(all.length, 101); assert.equal(new Set(ids).size, 101); assert.equal(ids.at(-1), Math.max(...ids));
  assert.equal(ids[0], Math.min(...ids));
  assert.equal((await call(db, `/submissions/${id}/activity?cursor=0`, managerToken)).response.status, 400);
  assert.equal((await call(db, `/submissions/${id}/activity?cursor=abc`, managerToken)).response.status, 400);
});
