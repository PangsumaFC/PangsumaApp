import assert from 'node:assert/strict';
import test from 'node:test';
import { getSessionUser } from '../functions/_lib/auth.js';
import { ensureUserProfilesSchema } from '../functions/_lib/migration-guard.js';

function fakeD1({ migrated, missingColumn = false, sessionRow = null } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return {
        bind() { return this; },
        async all() {
          if (!migrated) throw new Error('no such table: user_profiles');
          if (missingColumn) throw new Error('no such column: version');
          return { success: true, results: [] };
        },
        async first() { return sessionRow; }
      };
    }
  };
}

test('pre-migration guard returns actionable 503 before any auth join', async () => {
  const db = fakeD1({ migrated: false });
  await assert.rejects(() => ensureUserProfilesSchema(db), error => error.status === 503
    && error.code === 'migration_required' && error.message.includes('0003_user_profiles.sql'));
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0], /LIMIT 0/);
});

test('partial profile schema also fails closed instead of reaching auth SQL', async () => {
  const db = fakeD1({ migrated: true, missingColumn: true });
  await assert.rejects(() => ensureUserProfilesSchema(db), error => error.status === 503 && error.code === 'migration_required');
  assert.equal(db.calls.length, 1);
});

test('getSessionUser fails closed before its user_profiles join when 0003 is absent', async () => {
  const db = fakeD1({ migrated: false });
  const request = new Request('https://local.test/api/session', {
    headers: { Cookie: '__Host-pangsuma_session=local-test-token' }
  });
  await assert.rejects(() => getSessionUser(request, db), error => error.status === 503 && error.code === 'migration_required');
  assert.equal(db.calls.length, 1);
});

test('post-migration guard passes and allows the session query', async () => {
  const db = fakeD1({
    migrated: true,
    sessionRow: {
      id: 'user-1', name: 'Local User', email: 'user@example.test',
      position: 'Staff', role: 'user', must_change_password: 0,
      nickname: '', dashboard_position: null, quote: '', has_photo: 0,
      profile_version: 1, expires_at: '2099-01-01T00:00:00.000Z', auth_method: 'password'
    }
  });
  const request = new Request('https://local.test/api/session', {
    headers: { Cookie: '__Host-pangsuma_session=local-test-token' }
  });
  const user = await getSessionUser(request, db, new Date('2028-01-01T00:00:00.000Z'));
  assert.equal(user.id, 'user-1');
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[1], /LEFT JOIN user_profiles/);
});
