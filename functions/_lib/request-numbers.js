import { ApiError } from './http.js';

const PREFIX = Object.freeze({ petty_cash: 'PC', finance_request: 'RF' });
const TYPE_BY_PREFIX = Object.freeze({ PC: 'petty_cash', RF: 'finance_request' });
const INTEGER_MAX = 999999;

function jakartaParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ApiError(400, 'invalid_created_at', 'Waktu pembuatan permintaan tidak valid.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit'
  }).formatToParts(date);
  const get = name => parts.find(part => part.type === name)?.value || '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  if (!year || month < 1 || month > 12) throw new ApiError(400, 'invalid_created_at', 'Waktu pembuatan permintaan tidak valid.');
  return { year, month };
}

function validateInput({ id, createdBy, type, createdAt, idempotencyKey }) {
  if (typeof id !== 'string' || !id || typeof createdBy !== 'string' || !createdBy || !PREFIX[type]) {
    throw new ApiError(400, 'invalid_request_number_input', 'Data reservasi nomor permintaan tidak valid.');
  }
  if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200) {
    throw new ApiError(400, 'invalid_idempotency_key', 'Kunci idempotensi tidak valid.');
  }
  return jakartaParts(createdAt);
}

function rowResult(result) {
  const row = result?.results?.[0] || result?.[0] || null;
  return row && Object.prototype.hasOwnProperty.call(row, 'submission_id') ? row : null;
}

function schemaMissing(error) {
  return /no such table: request_number_|no such column: request_number/i.test(String(error?.message || error));
}

function reservationRow(row) {
  if (!row) return null;
  return { id: row.submission_id, requestNumber: row.request_number, type: row.type,
    createdBy: row.created_by, createdAt: row.created_at, idempotencyKey: row.idempotency_key };
}

/**
 * Reserve exactly one immutable display number before inserting a submission.
 * The caller MUST await this call as a separately committed operation, then
 * insert the submission in a later db.batch/statement using the returned values.
 * A retry with the same (createdBy,idempotencyKey) returns the original row;
 * a reuse by another actor/type is rejected.
 */
export async function reserveRequestNumber(db, input) {
  const { id, createdBy, type, createdAt, idempotencyKey, payloadHash = null } = input || {};
  const { year, month } = validateInput({ id, createdBy, type, createdAt, idempotencyKey });
  const prefix = PREFIX[type];
  const createdAtText = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);

  let existing;
  try {
    existing = await db.prepare(
      `SELECT submission_id, request_number, type, created_by, created_at, idempotency_key, payload_hash
         FROM request_number_reservations
        WHERE created_by = ?1 AND idempotency_key = ?2`
    ).bind(createdBy, idempotencyKey).first();
  } catch (error) {
    if (schemaMissing(error)) throw new ApiError(503, 'request_number_schema_required', 'Administrator perlu menerapkan migrasi 0010_request_numbers.sql.');
    throw error;
  }
  if (existing) {
    if (existing.type !== type || existing.created_by !== createdBy || existing.payload_hash !== payloadHash) {
      throw new ApiError(409, 'idempotency_key_conflict', 'Kunci idempotensi sudah digunakan oleh permintaan lain.');
    }
    return reservationRow(existing);
  }

  // D1 batch is one SQLite transaction: the counter update and reservation commit together.
  // INSERT OR IGNORE makes the category/month row safe under concurrent reservations.
  let results;
  try {
    results = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO request_number_sequences (type, year, month, next_value)
                VALUES (?1, ?2, ?3, 1)`).bind(type, year, month),
      db.prepare(`UPDATE request_number_sequences SET next_value = next_value + 1
                WHERE type = ?1 AND year = ?2 AND month = ?3 AND next_value <= ?4`).bind(type, year, month, INTEGER_MAX),
      db.prepare(`INSERT INTO request_number_reservations
      (submission_id, request_number, type, created_by, created_at, idempotency_key, payload_hash, year, month, sequence)
      SELECT ?1, ?2 || printf('%02d', ?3) || printf('%04d', ?4) || printf('%06d', next_value - 1),
             ?5, ?6, ?7, ?8, ?9, ?4, ?3, next_value - 1
        FROM request_number_sequences
       WHERE type = ?5 AND year = ?4 AND month = ?3`).bind(id, prefix, month, year, type, createdBy, createdAtText, idempotencyKey, payloadHash)
    ]);
  } catch (error) {
    // A concurrent caller may have won the idempotency unique key. Its committed
    // reservation is authoritative, so return it rather than issuing a new UUID.
    const winner = await db.prepare(`SELECT submission_id, request_number, type, created_by, created_at, idempotency_key, payload_hash
                                       FROM request_number_reservations
                                      WHERE created_by = ?1 AND idempotency_key = ?2`).bind(createdBy, idempotencyKey).first();
    if (winner && winner.type === type && winner.payload_hash === payloadHash) {
      return reservationRow(winner);
    }
    const exhausted = await db.prepare(`SELECT next_value FROM request_number_sequences
                                         WHERE type = ?1 AND year = ?2 AND month = ?3`)
      .bind(type, year, month).first();
    if (exhausted && exhausted.next_value > INTEGER_MAX) {
      throw new ApiError(409, 'request_number_exhausted', 'Urutan nomor permintaan untuk bulan ini sudah penuh.');
    }
    if (schemaMissing(error)) throw new ApiError(503, 'request_number_schema_required', 'Administrator perlu menerapkan migrasi 0010_request_numbers.sql.');
    throw error;
  }
  // Some D1-compatible test doubles return a SELECT row from batch; real D1
  // returns only write metadata, so the committed lookup remains authoritative.
  let row = reservationRow(rowResult(results));
  if (!row) row = reservationRow(await db.prepare(`SELECT submission_id, request_number, type, created_by, created_at, idempotency_key
                                  FROM request_number_reservations WHERE created_by = ?1 AND idempotency_key = ?2`)
    .bind(createdBy, idempotencyKey).first());
  if (!row) throw new ApiError(503, 'request_number_reservation_failed', 'Reservasi nomor permintaan tidak tersimpan.');
  return row;
}

export const REQUEST_NUMBER_PREFIX = PREFIX;
export const REQUEST_NUMBER_TYPE_BY_PREFIX = TYPE_BY_PREFIX;
export const REQUEST_NUMBER_FORMAT = 'PCMMYYYYNNNNNN or RFMMYYYYNNNNNN';
