import { ApiError, cleanText, ensureMethod, ensureSameOrigin, jsonResponse, readJson } from './http.js';
import { sha256Hex } from './auth.js';

const MAX_SAFE_IDR = Number.MAX_SAFE_INTEGER;
const MAX_KEY_LENGTH = 200;

function nowIso() {
  return new Date().toISOString();
}

export async function ensureCashTopupsSchema(db) {
  try {
    await db.prepare(`
      SELECT t.id, t.manager_id, t.idempotency_key, t.payload_hash, t.amount_idr, t.note, t.created_at,
             l.topup_id
      FROM cash_topups t
      LEFT JOIN cash_ledger l ON l.topup_id = t.id
      LIMIT 0
    `).all();
    const triggers = (await db.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
      AND name IN ('cash_topup_balance_guard', 'cash_topup_ledger_and_account',
        'cash_topups_append_only_update', 'cash_topups_append_only_delete',
        'cash_ledger_append_only_update', 'cash_ledger_append_only_delete', 'petty_cash_approval_ledger')
      LIMIT 8
    `).all()).results || [];
    const posting = triggers.find(row => row.name === 'cash_topup_ledger_and_account');
    if (triggers.length !== 7 || !posting?.sql?.includes('cash.topup_created')
        || !posting.sql.includes('UPDATE cash_accounts') || !posting.sql.includes('INSERT INTO cash_ledger')) {
      throw new Error('incomplete_cash_topup_migration');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'migration_required', 'Database belum siap: migrasi 0005_cash_topups.sql harus diterapkan sebelum menambah saldo petty cash.');
  }
}

function canonicalPayload(amountIdr, note) {
  return JSON.stringify({ amountIdr, note });
}

function mapTopup(row) {
  if (!row) return null;
  return {
    id: row.id,
    amountIdr: Number(row.amount_idr),
    note: row.note,
    createdAt: row.created_at,
    actorName: row.actor_name || '',
    balanceAfterIdr: Number(row.balance_after_idr)
  };
}

async function readTopup(db, id) {
  const row = await db.prepare(`
    SELECT t.id, t.amount_idr, t.note, t.created_at,
           u.name AS actor_name, l.balance_after_idr
    FROM cash_topups t
    JOIN users u ON u.id = t.manager_id
    JOIN cash_ledger l ON l.event_type = 'cash_topup' AND l.topup_id = t.id
    WHERE t.id = ? LIMIT 1
  `).bind(id).first();
  return mapTopup(row);
}

async function findExisting(db, managerId, key, fingerprint) {
  const row = await db.prepare(`
    SELECT id, payload_hash
    FROM cash_topups
    WHERE manager_id = ? AND idempotency_key = ? LIMIT 1
  `).bind(managerId, key).first();
  if (!row) return null;
  if (row.payload_hash !== fingerprint) {
    throw new ApiError(409, 'idempotency_key_reused', 'Kunci top up sudah dipakai untuk isi yang berbeda.');
  }
  return row;
}

export async function createCashTopup(context, db, actor) {
  const { request } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  await ensureCashTopupsSchema(db);
  const body = await readJson(request);
  const amount = body.amountIdr;
  const note = cleanText(body.note, 500);
  const key = (request.headers.get('Idempotency-Key') || '').trim();
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_SAFE_IDR) {
    throw new ApiError(400, 'invalid_amount', 'Nominal harus berupa bilangan rupiah positif dan aman.');
  }
  if (!note || note.length < 3) throw new ApiError(400, 'invalid_note', 'Keterangan top up wajib diisi 3–500 karakter.');
  if (!key || key.length > MAX_KEY_LENGTH || /[\u0000-\u001F\u007F]/.test(key)) {
    throw new ApiError(400, 'idempotency_required', 'Kunci top up tidak valid.');
  }
  const fingerprint = await sha256Hex(canonicalPayload(amount, note));
  const existing = await findExisting(db, actor.id, key, fingerprint);
  if (existing) {
    return jsonResponse({ ok: true, topup: await readTopup(db, existing.id), alreadyApplied: true });
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO cash_topups (id, manager_id, idempotency_key, payload_hash, amount_idr, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(id, actor.id, key, fingerprint, amount, note, createdAt)
    ]);
  } catch (error) {
    if (String(error?.message || '').includes('cash_topup_balance_overflow')) {
      throw new ApiError(409, 'balance_overflow', 'Saldo petty cash melebihi batas aman.');
    }
    const duplicate = await findExisting(db, actor.id, key, fingerprint).catch(error2 => {
      if (error2 instanceof ApiError) throw error2;
      return null;
    });
    if (duplicate) return jsonResponse({ ok: true, topup: await readTopup(db, duplicate.id), alreadyApplied: true });
    throw error;
  }
  return jsonResponse({ ok: true, topup: await readTopup(db, id), alreadyApplied: false }, 201);
}
