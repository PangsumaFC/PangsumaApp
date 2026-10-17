import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../functions/_lib/auth.js';

export class LocalD1 {
  constructor(files = ['0001_initial.sql', '0002_passkey_auth.sql', '0003_user_profiles.sql', '0004_manager_submissions.sql', '0005_cash_topups.sql']) {
    this.db = new DatabaseSync(':memory:');
    for (const file of files) this.db.exec(fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const db = this.db; let args = [];
    const statement = {
      bind(...values) { args = values; return statement; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes || 0) } }; }
    };
    return statement;
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { for (const statement of statements) await statement.run(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

export async function seededFinancialDb() {
  const db = new LocalD1();
  const users = [
    ['manager-1', 'Manager Test', 'manager@test.local', 'Manager', 'manager'],
    ['user-a', 'User Alpha', 'alpha@test.local', 'Bendahara', 'user'],
    ['user-b', 'User Beta', 'beta@test.local', 'Anggota', 'user']
  ];
  for (const [id, name, email, position, role] of users) {
    db.db.prepare(`INSERT INTO users (id,name,email,position,role,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, name, email, position, role, 0, '2028-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z');
    db.db.prepare('INSERT INTO user_profiles (user_id) VALUES (?)').run(id);
  }
  const tokens = {};
  for (const [id] of users) {
    tokens[id] = `${id}-session-token`;
    db.db.prepare('INSERT INTO sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run(await sha256Hex(tokens[id]), id, '2028-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  }
  return { db, tokens, managerToken: tokens['manager-1'], userAToken: tokens['user-a'], userBToken: tokens['user-b'] };
}

export function insertSubmission(db, { id, createdBy = 'user-a', type = 'finance_request', status = 'pending', date = '2028-01-15', description = 'Pembelian perlengkapan', note = 'Kebutuhan operasional', amount = 1000, createdAt = `${date}T04:00:00.000Z`, updatedAt = createdAt, updatedBy = null, decisionReason = '', resolvedBy = null, sentBy = null, key = id }) {
  db.db.prepare(`INSERT INTO submissions (id,idempotency_key,created_by,type,status,amount_idr,date,description,note,decision_reason,resolved_by,sent_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, key, createdBy, type, status, amount, date, description, note, decisionReason, resolvedBy, sentBy, updatedBy, createdAt, updatedAt);
  return id;
}

export function insertAudit(db, { action = 'submission.created', entityId, actorId = 'user-a', details = {}, createdAt = '2028-01-15T04:00:00.000Z' }) {
  db.db.prepare(`INSERT INTO audit_events (actor_id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,?,?,?)`)
    .run(actorId, action, 'submission', entityId, JSON.stringify(details), createdAt);
}

export function request(path, token, { method = 'GET', query = '', origin = 'https://local.test' } = {}) {
  return new Request(`https://local.test/api${path}${query}`, { method, headers: { Origin: origin, Cookie: token ? `__Host-pangsuma_session=${token}` : '' } });
}
