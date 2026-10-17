import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';

const manager = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Manager',
  email: 'manager@example.test',
  position: 'Manager',
  role: 'manager',
  must_change_password: 0,
  is_active: 1,
  nickname: '',
  dashboard_position: null,
  quote: '',
  has_photo: 0,
  profile_version: 1,
  expires_at: '2099-01-01T00:00:00.000Z',
  auth_method: 'password'
};

function fakeDb(actor = manager) {
  const calls = [];
  const submissions = new Map();
  const audits = [];
  const db = {
    calls,
    submissions,
    audits,
    prepare(sql) {
      calls.push(sql);
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async all() {
          if (/FROM user_profiles/.test(sql)) return { results: [] };
          return { results: [] };
        },
        async first() {
          if (/FROM sessions/.test(sql)) return actor;
          if (/FROM user_profiles/.test(sql)) return {
            nickname: '', dashboard_position: null, quote: '', has_photo: 0, profile_version: 1
          };
          if (/SELECT id, payload_hash, type, amount_idr, date, description, note\s+FROM submissions/.test(sql)) {
            const row = [...submissions.values()].find(item => item.created_by === args[0] && item.idempotency_key === args[1]);
            return row ? { id: row.id, payload_hash: row.payload_hash, type: row.type, amount_idr: row.amount_idr, date: row.date, description: row.description, note: row.note } : null;
          }
          if (/SELECT id, status, created_by FROM submissions/.test(sql)) {
            const row = submissions.get(args[0]);
            return row ? { id: row.id, status: row.status, created_by: row.created_by } : null;
          }
          if (/SELECT s\.id, s\.type, s\.status/.test(sql)) {
            const row = submissions.get(args[0]);
            return row ? { ...row, created_by_name: manager.name, created_by_position: manager.position, resolved_by_name: '', sent_by_name: '' } : null;
          }
          return null;
        },
        async run() {
          if (/UPDATE submissions/.test(sql)) {
            const row = submissions.get(args[5]);
            // The production WHERE clause includes created_by <> actor.id.
            if (row && row.status === 'pending' && row.created_by !== args[6]) {
              row.status = args[0];
              row.resolved_by = args[1];
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        }
      };
      return statement;
    },
    async batch(statements) {
      const insert = statements[0];
      const values = insert.__args;
      if (!values) throw new Error('test fake missing bound INSERT arguments');
      submissions.set(values[0], {
        id: values[0], idempotency_key: values[1], payload_hash: values[2],
        created_by: values[3], type: values[4], status: 'pending',
        amount_idr: values[5], date: values[6], description: values[7], note: values[8],
        created_at: values[9], updated_at: values[10]
      });
      audits.push(statements[1]);
      if (statements[2]) {
        assert.match(calls.find(sql => /SET status = 'approved', updated_by/.test(sql)), /WHERE id = \? AND created_by = \? AND status = 'pending'/);
        const [actorId, updatedAt, submissionId, ownerId] = statements[2].__args;
        assert.equal(actorId, actor.id);
        assert.equal(ownerId, actor.id);
        const row = submissions.get(submissionId);
        row.status = 'approved';
        row.updated_by = actorId;
        row.updated_at = updatedAt;
        row.resolved_by = null;
      }
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    }
  };
  // Preserve bound arguments for the batch fake while keeping the D1-like API.
  const originalPrepare = db.prepare;
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    const originalBind = statement.bind;
    statement.bind = (...values) => { statement.__args = values; originalBind(...values); return statement; };
    return statement;
  };
  return db;
}

function request(path, method, body, idempotencyKey) {
  return new Request(`https://local.test/api${path}`, {
    method,
    headers: {
      Cookie: '__Host-pangsuma_session=local-test-token',
      Origin: 'https://local.test',
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    body: JSON.stringify(body || {})
  });
}

async function call(db, path, method, body, key) {
  return onRequest({ request: request(path, method, body, key), env: { DB: db } });
}

test('Manager dapat membuat pengajuan dan replay idempotency tidak menggandakan row', async () => {
  const db = fakeDb();
  const key = '11111111-1111-4111-8111-111111111111';
  const body = { type: 'finance_request', amountIdr: 125000, date: '2026-10-17', description: 'Tugas operasional Manager', note: 'Input Manager otomatis disetujui' };
  const first = await call(db, '/submissions', 'POST', body, key);
  assert.equal(first.status, 201);
  const firstPayload = await first.json();
  assert.equal(firstPayload.submission.createdBy, manager.id);
  assert.equal(firstPayload.submission.status, 'approved');
  assert.equal(db.submissions.get(firstPayload.submission.id).resolved_by, null);
  assert.equal(db.submissions.size, 1);

  const replay = await call(db, '/submissions', 'POST', body, key);
  assert.equal(replay.status, 200);
  const replayPayload = await replay.json();
  assert.equal(replayPayload.alreadyCreated, true);
  assert.equal(replayPayload.submission.status, 'approved');
  assert.equal(db.audits.length, 1);
  assert.equal(replayPayload.submission.id, firstPayload.submission.id);
  assert.equal(db.submissions.size, 1);
});

test('Manager tetap tidak dapat menyetujui pengajuan miliknya sendiri', async () => {
  const db = fakeDb();
  const key = '22222222-2222-4222-8222-222222222222';
  const created = await call(db, '/submissions', 'POST', {
    type: 'petty_cash', amountIdr: 50000, date: '2026-10-17', description: 'Tugas Manager sendiri'
  }, key);
  assert.equal(created.status, 201);
  const { submission } = await created.json();

  const decision = await call(db, `/submissions/${submission.id}/approve`, 'POST', {});
  assert.equal(decision.status, 403);
  const payload = await decision.json();
  assert.equal(payload.error.code, 'self_decision_not_allowed');
  assert.equal(db.submissions.get(submission.id).status, 'approved');
});

test('Manager mendapat pesan migrasi yang jelas bila trigger database lama masih aktif', async () => {
  const db = fakeDb();
  db.batch = async () => { throw new Error('D1_ERROR: only_user_accounts_may_submit: SQLITE_CONSTRAINT'); };
  const response = await call(db, '/submissions', 'POST', {
    type: 'finance_request', amountIdr: 125000, date: '2026-10-17', description: 'Pengajuan Manager sebelum migrasi'
  }, '33333333-3333-4333-8333-333333333333');
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.code, 'migration_required');
  assert.match(payload.error.message, /0004_manager_submissions\.sql/);
  assert.equal(db.submissions.size, 0);
  assert.equal(db.audits.length, 0);
});

test('Pengajuan User tetap pending walaupun payload mencoba memaksakan approved', async () => {
  const db = fakeDb({ ...manager, id: '00000000-0000-4000-8000-000000000003', role: 'user' });
  for (const type of ['petty_cash', 'finance_request']) {
    const response = await call(db, '/submissions', 'POST', {
      type, amountIdr: 50000, date: '2026-10-17', description: 'Pengajuan User biasa', status: 'approved', role: 'manager'
    }, crypto.randomUUID());
    assert.equal(response.status, 201);
    assert.equal((await response.json()).submission.status, 'pending');
  }
  assert.equal(db.calls.some(sql => /SET status = 'approved', updated_by/.test(sql)), false);
});

test('Saldo Manager tidak cukup menghasilkan 409 tanpa fallback pending', async () => {
  const db = fakeDb();
  db.batch = async statements => {
    assert.equal(statements.length, 3);
    throw new Error('D1_ERROR: insufficient_petty_cash_balance: SQLITE_CONSTRAINT');
  };
  const response = await call(db, '/submissions', 'POST', {
    type: 'petty_cash', amountIdr: 50000, date: '2026-10-17', description: 'Saldo tidak cukup'
  }, crypto.randomUUID());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'insufficient_petty_cash');
  assert.equal(db.submissions.size, 0);
  assert.equal(db.audits.length, 0);
});
