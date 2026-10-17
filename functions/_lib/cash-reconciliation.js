import { ApiError, cleanText, ensureMethod, ensureSameOrigin, jsonResponse, readJson } from './http.js';
import { sha256Hex } from './auth.js';

const MAX_SAFE_IDR = BigInt(Number.MAX_SAFE_INTEGER);
const REQUIRED_TRIGGERS = ['cash_reconciliations_append_only_update', 'cash_reconciliations_append_only_delete', 'cash_reconciliation_creation_audit'];

function parseIdr(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new ApiError(400, 'invalid_physical_cash', 'Kas fisik harus bilangan rupiah bulat yang aman.');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value.trim())) throw new ApiError(400, 'invalid_physical_cash', 'Kas fisik harus bilangan rupiah bulat.');
  return BigInt(value.trim());
}
function currentMonthWib() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}
function validatePeriod(value) {
  const period = typeof value === 'string' ? value.trim() : '';
  if (!/^(?:[1-9]\d{3})-(0[1-9]|1[0-2])$/.test(period)) throw new ApiError(400, 'invalid_period', 'Periode harus berupa YYYY-MM yang valid.');
  if (period >= currentMonthWib()) throw new ApiError(400, 'period_not_closed', 'Pilih bulan yang telah selesai, bukan bulan berjalan atau mendatang.');
  return period;
}
function boundaryFor(period) {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 1, -7)).toISOString();
}
function requireManager(user) {
  if (!user || user.role !== 'manager') throw new ApiError(403, 'manager_only', 'Hanya Manager yang dapat mengelola rekonsiliasi kas.');
}
export async function ensureCashReconciliationsSchema(db) {
  try {
    await db.prepare('SELECT id, period_ym, as_of, ledger_cutoff_id, ledger_balance_idr, account_balance_idr, physical_cash_idr, discrepancy_idr, manager_id, note, created_at, idempotency_key, payload_hash FROM cash_reconciliations LIMIT 0').all();
    const rows = (await db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN ('cash_reconciliations_append_only_update','cash_reconciliations_append_only_delete','cash_reconciliation_creation_audit') LIMIT 3").all()).results || [];
    if (!REQUIRED_TRIGGERS.every(name => rows.some(row => row.name === name)) || !rows.find(row => row.name === 'cash_reconciliation_creation_audit')?.sql?.includes('cash.reconciled')) throw new Error('incomplete_reconciliation_schema');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'migration_required', 'Fitur rekonsiliasi menunggu migrasi 0006_financial_controls.sql.');
  }
}
function mapRow(row) {
  return row ? {
    id: row.id, period: row.period_ym, asOf: row.as_of,
    ledgerCutoffId: Number(row.ledger_cutoff_id), ledgerBalanceIdr: String(row.ledger_balance_idr),
    accountBalanceIdr: String(row.account_balance_idr), physicalCashIdr: String(row.physical_cash_idr),
    discrepancyIdr: String(row.discrepancy_idr), managerId: row.manager_id,
    managerName: row.manager_name || '', note: row.note, createdAt: row.created_at
  } : null;
}
async function readOne(db, id) {
  return mapRow(await db.prepare('SELECT r.*, u.name AS manager_name FROM cash_reconciliations r JOIN users u ON u.id=r.manager_id WHERE r.id=? LIMIT 1').bind(id).first());
}
async function existingRecord(db, managerId, key, hash) {
  const row = await db.prepare('SELECT id, payload_hash FROM cash_reconciliations WHERE manager_id=? AND idempotency_key=? LIMIT 1').bind(managerId, key).first();
  if (row && row.payload_hash !== hash) throw new ApiError(409, 'idempotency_key_reused', 'Kunci rekonsiliasi sudah dipakai untuk isi berbeda.');
  return row;
}
function encodeCursor(row, period) {
  return btoa(JSON.stringify({ createdAt: row.created_at, id: row.id, period })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeCursor(value, period) {
  if (!value) return null;
  try {
    if (value.length > 600 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid');
    const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
    const cursor = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    if (cursor.period !== period || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.createdAt) || !Number.isFinite(Date.parse(cursor.createdAt)) || !/^[0-9a-f-]{36}$/i.test(cursor.id)) throw new Error('invalid');
    return cursor;
  } catch { throw new ApiError(400, 'invalid_cursor', 'Cursor rekonsiliasi tidak valid untuk periode ini.'); }
}
async function monthSnapshot(db, period) {
  const boundary = boundaryFor(period);
  const cutoff = Number((await db.prepare('SELECT COALESCE(MAX(id),0) AS cutoff FROM cash_ledger WHERE created_at < ? LIMIT 1').bind(boundary).first())?.cutoff || 0);
  let incoming = 0n, outgoing = 0n, after = 0;
  while (true) {
    const rows = (await db.prepare('SELECT id, direction, CAST(amount_idr AS TEXT) AS amount_idr FROM cash_ledger WHERE id > ? AND id <= ? AND created_at < ? ORDER BY id ASC LIMIT 500').bind(after, cutoff, boundary).all()).results || [];
    for (const row of rows) {
      const amount = BigInt(row.amount_idr);
      if (row.direction === 'credit') incoming += amount; else outgoing += amount;
    }
    if (rows.length < 500) break;
    after = Number(rows.at(-1).id);
  }
  const ledgerBalance = incoming - outgoing;
  if (ledgerBalance < 0n || ledgerBalance > MAX_SAFE_IDR) throw new ApiError(409, 'ledger_balance_invalid', 'Saldo hitung ledger historis berada di luar batas aman; perlu ditinjau, bukan dikoreksi otomatis.');
  const account = await db.prepare("SELECT CAST(balance_idr AS TEXT) AS balance_idr FROM cash_accounts WHERE id='operational' LIMIT 1").first();
  if (!account) throw new ApiError(503, 'migration_required', 'Akun kas operasional belum tersedia.');
  const accountBalance = BigInt(account.balance_idr);
  if (accountBalance < 0n || accountBalance > MAX_SAFE_IDR) throw new ApiError(409, 'account_balance_invalid', 'Saldo akun berada di luar batas aman.');
  return {
    period, asOf: new Date(Date.parse(boundary) - 1).toISOString(), ledgerCutoffId: cutoff,
    ledgerBalanceIdr: ledgerBalance.toString(), accountBalanceIdr: accountBalance.toString(),
    accountSnapshotAt: new Date().toISOString(), incomingIdr: incoming.toString(), outgoingIdr: outgoing.toString()
  };
}
export async function getCashReconciliations(db, user, searchparams = new URLSearchParams()) {
  requireManager(user); await ensureCashReconciliationsSchema(db);
  const params = searchparams instanceof URLSearchParams ? searchparams : new URLSearchParams(searchparams || '');
  const period = params.get('period') ? validatePeriod(params.get('period')) : '';
  const limit = Number(params.get('limit') || 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'invalid_pagination', 'Ukuran halaman rekonsiliasi harus 1–100.');
  const cursor = decodeCursor(params.get('cursor'), period);
  const where = [], binds = [];
  if (period) { where.push('r.period_ym=?'); binds.push(period); }
  if (cursor) { where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))'); binds.push(cursor.createdAt, cursor.createdAt, cursor.id); }
  const rows = (await db.prepare(`SELECT r.*, u.name AS manager_name FROM cash_reconciliations r JOIN users u ON u.id=r.manager_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).bind(...binds, limit + 1).all()).results || [];
  const hasMore = rows.length > limit, page = rows.slice(0, limit);
  return jsonResponse({ ok: true, reconciliations: page.map(mapRow), hasMore, nextCursor: hasMore ? encodeCursor(page.at(-1), period) : null, period: period || null, preview: period ? await monthSnapshot(db, period) : null });
}
export async function createCashReconciliation(context, db, user) {
  ensureMethod(context.request, 'POST'); ensureSameOrigin(context.request); requireManager(user);
  await ensureCashReconciliationsSchema(db);
  const body = await readJson(context.request);
  const period = validatePeriod(body.period ?? body.periodYm ?? body.period_ym);
  if (body.confirmed !== true) throw new ApiError(400, 'confirmation_required', 'Konfirmasikan hasil hitung fisik; pencatatan ini tidak mengubah saldo.');
  const physical = parseIdr(body.physicalCashIdr ?? body.physical_cash_idr);
  if (physical < 0n || physical > MAX_SAFE_IDR) throw new ApiError(400, 'invalid_physical_cash', 'Kas fisik harus 0 sampai batas integer aman.');
  const note = cleanText(body.note, 1000);
  if (!note || note.length < 3) throw new ApiError(400, 'invalid_note', 'Catatan wajib diisi 3–1000 karakter.');
  const key = (context.request.headers.get('Idempotency-Key') || '').trim();
  if (!key || key.length > 200 || /[\u0000-\u001F\u007F]/.test(key)) throw new ApiError(400, 'idempotency_required', 'Kunci rekonsiliasi tidak valid.');
  const hash = await sha256Hex(JSON.stringify({ period, physicalCashIdr: physical.toString(), note }));
  const existing = await existingRecord(db, user.id, key, hash);
  if (existing) return jsonResponse({ ok: true, reconciliation: await readOne(db, existing.id), alreadyApplied: true });
  const snapshot = await monthSnapshot(db, period);
  const discrepancy = physical - BigInt(snapshot.ledgerBalanceIdr);
  const id = crypto.randomUUID(), createdAt = new Date().toISOString();
  try {
    await db.batch([db.prepare('INSERT INTO cash_reconciliations (id,period_ym,as_of,ledger_cutoff_id,ledger_balance_idr,account_balance_idr,physical_cash_idr,discrepancy_idr,manager_id,note,created_at,idempotency_key,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, period, snapshot.asOf, snapshot.ledgerCutoffId, snapshot.ledgerBalanceIdr, snapshot.accountBalanceIdr, physical.toString(), discrepancy.toString(), user.id, note, createdAt, key, hash)]);
  } catch (error) {
    const duplicate = await existingRecord(db, user.id, key, hash);
    if (duplicate) return jsonResponse({ ok: true, reconciliation: await readOne(db, duplicate.id), alreadyApplied: true });
    throw error;
  }
  return jsonResponse({ ok: true, reconciliation: await readOne(db, id), alreadyApplied: false }, 201);
}
