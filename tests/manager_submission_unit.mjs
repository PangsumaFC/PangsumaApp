import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';

const MANAGER = {
  id: 'manager-1', name: 'Manager', email: 'manager@example.test', position: 'Manager',
  role: 'manager', must_change_password: 0, expires_at: '2099-01-01T00:00:00.000Z', auth_method: 'password'
};
const USER = {
  id: 'user-1', name: 'User', email: 'user@example.test', position: 'Staff',
  role: 'user', must_change_password: 0, expires_at: '2099-01-01T00:00:00.000Z', auth_method: 'password'
};
const OTHER = {
  id: 'user-2', name: 'Other User', email: 'other@example.test', position: 'Staff',
  role: 'user', must_change_password: 0, expires_at: '2099-01-01T00:00:00.000Z', auth_method: 'password'
};

function fakeDb() {
  const submissions = [];
  const auditEvents = [];
  let actor = MANAGER;
  const db = {
    submissions,
    auditEvents,
    as(user) { actor = user; return db; },
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) { statement.args = args; return statement; },
        async all() {
          if (/FROM submissions s/.test(sql)) {
            const rows = sql.includes('s.created_by = ?')
              ? submissions.filter(row => row.created_by === statement.args[0])
              : submissions;
            return { results: rows.map(row => ({
              ...row,
              created_by_name: row.created_by === MANAGER.id ? MANAGER.name : row.created_by === USER.id ? USER.name : OTHER.name,
              created_by_position: 'Staff',
              resolved_by_name: '',
              sent_by_name: ''
            })) };
          }
          return { results: [] };
        },
        async first() {
          if (/FROM sessions/.test(sql)) return actor;
          if (/WHERE s\.id = \?/.test(sql)) {
            const row = submissions.find(item => item.id === statement.args[0]);
            return row ? { ...row, created_by_name: actor.name, created_by_position: actor.position } : null;
          }
          if (/SELECT id, status, created_by FROM submissions/.test(sql)) {
            return submissions.find(item => item.id === statement.args[0]) || null;
          }
          if (/COUNT\(\*\)/.test(sql)) return { count: submissions.length, total_count: submissions.length };
          return null;
        },
        async run() {
          if (/INSERT INTO submissions/.test(sql)) {
            const [id, idempotencyKey, payloadHash, createdBy, type, amountIdr, date, description, note, createdAt, updatedAt] = statement.args;
            submissions.push({ id, idempotency_key: idempotencyKey, payload_hash: payloadHash, created_by: createdBy, type, status: 'pending', amount_idr: amountIdr, date, description, note, created_at: createdAt, updated_at: updatedAt });
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO audit_events/.test(sql)) {
            auditEvents.push(statement.args);
            return { meta: { changes: 1 } };
          }
          if (/UPDATE submissions/.test(sql)) return { meta: { changes: 0 } };
          return { meta: { changes: 0 } };
        }
      };
      return statement;
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
    }
  };
  return db;
}

async function call(db, user, path, method = 'GET', body) {
  db.as(user);
  const request = new Request(`https://local.test/api${path}`, {
    method,
    headers: {
      Cookie: '__Host-pangsuma_session=local-test-token',
      ...(body ? { 'Content-Type': 'application/json', Origin: 'https://local.test', 'Idempotency-Key': crypto.randomUUID() } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return onRequest({ request, env: { DB: db } });
}

const submissionBody = {
  type: 'petty_cash', amountIdr: 125000, date: '2026-10-18', description: 'Manager operational report', note: ''
};

test('Manager dapat membuat submission miliknya sendiri dengan created_by actor', async () => {
  const db = fakeDb();
  const response = await call(db, MANAGER, '/submissions', 'POST', submissionBody);
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.submission.createdBy, MANAGER.id);
  assert.equal(db.submissions[0].created_by, MANAGER.id);
  assert.equal(db.auditEvents.length, 1);
});

test('Submission tetap terisolasi untuk User, sedangkan Manager dapat melihat seluruh submission', async () => {
  const db = fakeDb();
  await call(db, MANAGER, '/submissions', 'POST', submissionBody);
  const otherResponse = await call(db, OTHER, '/submissions', 'POST', { ...submissionBody, description: 'Other user report' });
  assert.equal(otherResponse.status, 201);

  const managerList = await call(db, MANAGER, '/submissions');
  assert.equal((await managerList.json()).submissions.length, 2);
  const userList = await call(db, USER, '/submissions');
  assert.deepEqual((await userList.json()).submissions, []);
  const otherList = await call(db, OTHER, '/submissions');
  assert.equal((await otherList.json()).submissions.length, 1);
});

test('Manager dilarang self-approve submission miliknya', async () => {
  const db = fakeDb();
  const created = await call(db, MANAGER, '/submissions', 'POST', submissionBody);
  const id = (await created.json()).submission.id;
  const response = await call(db, MANAGER, `/submissions/${id}/approve`, 'POST', {});
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'self_decision_not_allowed');
});

test('Cash history tetap Manager-only', async () => {
  const db = fakeDb();
  const managerResponse = await call(db, MANAGER, '/history/cash-ledger');
  assert.equal(managerResponse.status, 200);
  const userResponse = await call(db, USER, '/history/cash-ledger');
  assert.equal(userResponse.status, 403);
  assert.equal((await userResponse.json()).error.code, 'manager_required');
});
