import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../functions/_lib/auth.js';

export class LocalD1 {
  constructor(files = ['0001_initial.sql', '0002_passkey_auth.sql', '0003_user_profiles.sql', '0004_manager_submissions.sql', '0005_cash_topups.sql', '0010_request_numbers.sql']) {
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
    const results = [];
    this.db.exec('BEGIN');
    try { for (const statement of statements) results.push(await statement.run()); this.db.exec('COMMIT'); return results; }
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
  const hasNumbers = db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_number_reservations'").get();
  let requestNumber = null;
  if (hasNumbers) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).formatToParts(new Date(createdAt));
    const year = Number(parts.find(p => p.type === 'year').value), month = Number(parts.find(p => p.type === 'month').value);
    const prefix = type === 'petty_cash' ? 'PC' : 'RF';
    db.db.exec('BEGIN');
    try {
      db.db.prepare('INSERT OR IGNORE INTO request_number_sequences(type,year,month,next_value) VALUES (?,?,?,1)').run(type, year, month);
      const seq = db.db.prepare('SELECT next_value FROM request_number_sequences WHERE type=? AND year=? AND month=?').get(type, year, month).next_value;
      if (seq > 999999) throw new Error('request_number_exhausted');
      db.db.prepare('UPDATE request_number_sequences SET next_value=next_value+1 WHERE type=? AND year=? AND month=?').run(type, year, month);
      requestNumber = `${prefix}${String(month).padStart(2, '0')}${year}${String(seq).padStart(6, '0')}`;
      db.db.prepare(`INSERT INTO request_number_reservations (submission_id,request_number,type,created_by,created_at,idempotency_key,payload_hash,year,month,sequence) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, requestNumber, type, createdBy, createdAt, key, null, year, month, seq);
      db.db.exec('COMMIT');
    } catch (error) { db.db.exec('ROLLBACK'); throw error; }
  }
  const columns = requestNumber ? 'id,idempotency_key,created_by,type,status,amount_idr,date,description,note,decision_reason,resolved_by,sent_by,updated_by,created_at,updated_at,request_number' : 'id,idempotency_key,created_by,type,status,amount_idr,date,description,note,decision_reason,resolved_by,sent_by,updated_by,created_at,updated_at';
  const values = requestNumber ? [id,key,createdBy,type,status,amount,date,description,note,decisionReason,resolvedBy,sentBy,updatedBy,createdAt,updatedAt,requestNumber] : [id,key,createdBy,type,status,amount,date,description,note,decisionReason,resolvedBy,sentBy,updatedBy,createdAt,updatedAt];
  db.db.prepare(`INSERT INTO submissions (${columns}) VALUES (${values.map(() => '?').join(',')})`).run(...values);
  return id;
}

export function insertAudit(db, { action = 'submission.created', entityId, actorId = 'user-a', details = {}, createdAt = '2028-01-15T04:00:00.000Z' }) {
  db.db.prepare(`INSERT INTO audit_events (actor_id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,?,?,?)`)
    .run(actorId, action, 'submission', entityId, JSON.stringify(details), createdAt);
}

export function request(path, token, { method = 'GET', query = '', origin = 'https://local.test' } = {}) {
  return new Request(`https://local.test/api${path}${query}`, { method, headers: { Origin: origin, Cookie: token ? `__Host-pangsuma_session=${token}` : '' } });
}
