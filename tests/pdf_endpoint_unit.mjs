import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';
import { PDFDocument } from 'pdf-lib';

const manager = {
  id: 'manager-1', name: 'Manager One', email: 'manager@example.test', position: 'Manager',
  role: 'manager', must_change_password: 0, nickname: '', dashboard_position: null,
  quote: '', has_photo: 0, profile_version: 1, expires_at: '2099-01-01T00:00:00.000Z',
  auth_method: 'password'
};

function makeRows(kind, count = 501) {
  return Array.from({ length: count }, (_, index) => {
    const id = count - index;
    const minute = count - index;
    const createdAt = `2025-01-01T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`;
    if (kind === 'submission') return {
      id: `submission-${id}`, type: 'finance_request', status: 'approved', amount_idr: 125000,
      date: '2025-01-01', description: index === 0 ? '=SUM(A1:A2)' : `Submission ${id}`,
      note: '', decision_reason: '', created_at: createdAt, created_by: 'user-1',
      created_by_name: 'Staff One', created_by_position: 'Staff'
    };
    if (kind === 'ledger') return {
      id, event_type: 'finance_request_approved', direction: 'out', amount_idr: 125000,
      balance_after_idr: 875000, submission_id: `submission-${id}`,
      note: index === 0 ? '+cmd' : `Ledger ${id}`, created_at: createdAt, actor_name: 'Manager One'
    };
    return {
      id, action: 'submission_approved', entity_type: 'submission', entity_id: `submission-${id}`,
      details_json: index === 0 ? '@audit-detail' : JSON.stringify({ id }), created_at: createdAt,
      actor_name: 'Manager One'
    };
  });
}

function fakeDb({ user = manager, rows = {} } = {}) {
  const calls = [];
  const data = {
    submission: rows.submission || makeRows('submission'),
    ledger: rows.ledger || makeRows('ledger'),
    audit: rows.audit || makeRows('audit')
  };
  const pageCalls = { submission: 0, ledger: 0, audit: 0 };
  return {
    calls,
    prepare(sql) {
      const bound = [];
      calls.push({ sql, bound });
      const statement = {
        bind(...params) { bound.push(...params); return statement; },
        async all() {
          if (/FROM user_profiles LIMIT 0/.test(sql)) return { results: [] };
          if (/FROM submissions s/.test(sql)) {
            if (++pageCalls.submission > 3) throw new Error('submission pagination loop');
            const start = bound.length === 1 ? 0 : data.submission.findIndex(row => row.created_at < bound[1] || (row.created_at === bound[1] && row.id < bound[3]));
            return { results: data.submission.slice(start < 0 ? data.submission.length : start, start < 0 ? undefined : start + 500) };
          }
          if (/FROM cash_ledger l/.test(sql)) {
            if (++pageCalls.ledger > 3) throw new Error('ledger pagination loop');
            const start = bound.length === 1 ? 0 : data.ledger.findIndex(row => row.id < Number(bound[1]));
            return { results: data.ledger.slice(start < 0 ? data.ledger.length : start, start < 0 ? undefined : start + 500) };
          }
          if (/FROM audit_events a/.test(sql)) {
            if (++pageCalls.audit > 3) throw new Error('audit pagination loop');
            const start = bound.length === 1 ? 0 : data.audit.findIndex(row => row.id < Number(bound[1]));
            return { results: data.audit.slice(start < 0 ? data.audit.length : start, start < 0 ? undefined : start + 500) };
          }
          return { results: [] };
        },
        async first() {
          if (/FROM sessions/.test(sql)) return user;
          return null;
        },
        async run() { return { meta: { changes: 0 } }; }
      };
      return statement;
    }
  };
}

function request(path = '/export.pdf', cookie = '__Host-pangsuma_session=local-test-token', method = 'GET') {
  return new Request(`https://local.test/api${path}`, {
    method,
    headers: cookie ? { Cookie: cookie } : {}
  });
}

async function call(db, cookie) {
  return onRequest({ request: request('/export.pdf', cookie), env: { DB: db } });
}

for (const largeSection of ['submission', 'ledger', 'audit']) {
  test(`manager export paginates every row beyond 500 ${largeSection} records with all financial sections`, async () => {
    const sizes = Object.fromEntries(['submission','ledger','audit'].map(kind => [kind, kind === largeSection ? 501 : 1]));
    const db = fakeDb({ rows: Object.fromEntries(Object.entries(sizes).map(([kind,count]) => [kind, makeRows(kind,count)])) });
    const response = await call(db);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="pangsuma-laporan-keuangan-\d{4}-\d{2}-\d{2}\.pdf"$/);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(Array.from(bytes.slice(0, 5)), Array.from(Buffer.from('%PDF-')));
    const pdf = await PDFDocument.load(bytes); assert.ok(pdf.getPageCount() >= 1);
    const sql = db.calls.map(call => call.sql);
    for (const [kind,pattern] of [['submission', /FROM submissions s/],['ledger', /FROM cash_ledger l/],['audit', /FROM audit_events a/]]) {
      assert.equal(sql.filter(query => pattern.test(query)).length, kind === largeSection ? 2 : 1);
    }
    if (largeSection === 'submission') {
      const cursorCall = db.calls.find(call => /FROM submissions s/.test(call.sql) && call.bound.length === 4);
      assert.deepEqual(cursorCall.bound.slice(1), ['2025-01-01T00:02:00.000Z','2025-01-01T00:02:00.000Z','submission-2']);
    } else {
      const pattern = largeSection === 'ledger' ? /FROM cash_ledger l/ : /FROM audit_events a/;
      const cursorCall = db.calls.find(call => pattern.test(call.sql) && call.bound.length === 2);
      assert.equal(cursorCall.bound[1], 2);
    }
  });
}
test('PDF export rejects unsupported methods', async () => {
  const db = fakeDb();
  const response = await onRequest({ request: request('/export.pdf', '__Host-pangsuma_session=local-test-token', 'POST'), env: { DB: db } });
  assert.equal(response.status, 405);
});

test('manager-only export denies a regular user', async () => {
  const db = fakeDb({ user: { ...manager, role: 'user' } });
  const response = await call(db);
  assert.equal(response.status, 403);
  assert.deepEqual((await response.json()).error.code, 'manager_required');
});

test('export requires authentication when the session is absent', async () => {
  const db = fakeDb();
  const response = await call(db, '');
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'authentication_required');
});
