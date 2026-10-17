import { ApiError, ensureMethod } from './http.js';
import {
  parseReportFilters,
  buildSubmissionFilterSql,
  reportFilterDescription,
  reportPeriodLabel
} from './report-filters.js';

const MAX_LIMIT = 100;
const MAX_PAGE = 10000;
const CURSOR_MAX = 2048;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function stableFilters(filters) {
  return JSON.stringify({
    period: filters?.period || '', startDate: filters?.startDate || '', endDate: filters?.endDate || '',
    q: filters?.q || '', applicant: filters?.applicant || '', type: filters?.type || '', status: filters?.status || ''
  });
}
function filterHash(filters) {
  // Deterministic compact fingerprint; cursor contents remain opaque and the
  // server recomputes this value for every request.
  let h = 2166136261;
  for (const c of stableFilters(filters)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function encodeCursor(value) {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function validTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === new Date(value).toISOString();
}
function decodeCursor(value, filters) {
  if (typeof value !== 'string' || value.length < 20 || value.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError(400, 'invalid_cursor', 'Cursor laporan tidak valid.');
  }
  let cursor;
  try { cursor = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='))); } catch { throw new ApiError(400, 'invalid_cursor', 'Cursor laporan tidak valid.'); }
  if (!cursor || cursor.v !== 1 || !['after', 'before'].includes(cursor.direction) || !validTimestamp(cursor.snapshotAt) || cursor.filterHash !== filterHash(filters) || !Array.isArray(cursor.key) || cursor.key.length !== 3 || typeof cursor.key[0] !== 'string' || typeof cursor.key[1] !== 'string' || !ID_RE.test(cursor.key[2])) {
    throw new ApiError(400, 'invalid_cursor', 'Cursor laporan tidak cocok dengan filter atau sudah rusak.');
  }
  if (Date.parse(cursor.snapshotAt) > Date.now() + 5000) throw new ApiError(400, 'invalid_cursor', 'Snapshot cursor belum valid.');
  return cursor;
}
function cursorFor(direction, snapshotAt, filters, row) {
  return encodeCursor({ v: 1, direction, snapshotAt, filterHash: filterHash(filters), key: [String(row.date || ''), String(row.created_at || ''), String(row.id)] });
}
function boundLimit(params) {
  const raw = params.get('limit');
  if (raw == null || raw === '') return 25;
  if (!/^\d+$/.test(raw)) throw new ApiError(400, 'invalid_limit', 'Limit laporan tidak valid.');
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) throw new ApiError(400, 'invalid_limit', 'Limit laporan harus 1 sampai 100.');
  return limit;
}
function addKeyset(sf, cursor) {
  if (!cursor) return { where: sf.where, params: [...sf.params], reverse: false };
  const [date, created, id] = cursor.key;
  const after = cursor.direction === 'after';
  const op = after ? '<' : '>';
  const keySql = `(s.date ${op} ? OR (s.date = ? AND s.created_at ${op} ?) OR (s.date = ? AND s.created_at = ? AND s.id ${op} ?))`;
  return { where: `(${sf.where}) AND ${keySql}`, params: [...sf.params, date, date, created, date, created, id], reverse: !after };
}

/**
 * Public report-page contract (used by the parent API):
 * { rows, total, limit, hasMore, nextCursor, previousCursor, snapshotAt,
 *   filters, filterDescription, periodLabel, page? }.
 * `rows` are deliberately raw database rows so the API can apply its existing
 * mapSubmission function; this helper never exposes a response by itself.
 */
export async function queryReportPage(db, filters, searchParams = new URLSearchParams()) {
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams);
  const limit = boundLimit(params);
  const cursorValue = params.get('cursor') || '';
  const cursor = cursorValue ? decodeCursor(cursorValue, filters) : null;
  const legacyPage = !cursor && params.get('page') != null ? Number(params.get('page')) : 0;
  if (legacyPage && (!Number.isInteger(legacyPage) || legacyPage < 1 || legacyPage > MAX_PAGE)) throw new ApiError(400, 'invalid_page', 'Halaman laporan tidak valid.');
  const snapshotAt = cursor?.snapshotAt || new Date().toISOString();
  const base = buildSubmissionFilterSql(filters);
  const snapshot = { where: `(${base.where}) AND s.created_at <= ?`, params: [...base.params, snapshotAt] };
  const keyset = addKeyset(snapshot, cursor);
  const order = keyset.reverse ? 's.date ASC, s.created_at ASC, s.id ASC' : 's.date DESC, s.created_at DESC, s.id DESC';
  const legacy = Boolean(legacyPage);
  const pagingSql = legacy ? ' LIMIT ? OFFSET ?' : ' LIMIT ?';
  const select = `SELECT s.*, creator.name AS created_by_name, creator.position AS created_by_position, creator.role AS created_by_role, resolver.name AS resolved_by_name, sender.name AS sent_by_name FROM submissions s JOIN users creator ON creator.id = s.created_by LEFT JOIN users resolver ON resolver.id = s.resolved_by LEFT JOIN users sender ON sender.id = s.sent_by WHERE ${keyset.where} ORDER BY ${order} LIMIT ?`;
  const result = (await db.prepare(select.replace(' LIMIT ?', pagingSql)).bind(...keyset.params, ...(legacy ? [limit, (legacyPage - 1) * limit] : [limit + 1])).all()).results || [];
  const hasExtra = result.length > limit;
  let rows = result.slice(0, limit);
  if (keyset.reverse) rows.reverse();
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM submissions s JOIN users creator ON creator.id = s.created_by WHERE ${snapshot.where}`).bind(...snapshot.params).first();
  const total = Number(count?.total || 0);
  const first = rows[0];
  const last = rows[rows.length - 1];
  let nextCursor = !legacy && rows.length && (cursor?.direction !== 'before' ? hasExtra : true) ? cursorFor('after', snapshotAt, filters, last) : null;
  let previousCursor = !legacy && rows.length && (cursor?.direction !== 'after' ? hasExtra : true) ? cursorFor('before', snapshotAt, filters, first) : null;
  // Probe the opposite edge when a page was reached by the other direction.
  let hasPrevious = legacy ? legacyPage > 1 : Boolean(previousCursor);
  let hasNext = legacy ? (legacyPage * limit < total) : Boolean(nextCursor);
  if (!legacy && rows.length && cursor?.direction === 'after' && !hasPrevious) {
    const probe = await db.prepare(`SELECT s.id FROM submissions s JOIN users creator ON creator.id = s.created_by WHERE ${snapshot.where} AND (s.date > ? OR (s.date = ? AND s.created_at > ?) OR (s.date = ? AND s.created_at = ? AND s.id > ?)) LIMIT 1`).bind(...snapshot.params, rows[0].date, rows[0].date, rows[0].created_at, rows[0].date, rows[0].created_at, rows[0].id).first();
    hasPrevious = Boolean(probe);
    if (hasPrevious && !previousCursor) previousCursor = cursorFor('before', snapshotAt, filters, first);
  }
  if (!legacy && rows.length && cursor?.direction === 'before' && !hasNext) {
    const probe = await db.prepare(`SELECT s.id FROM submissions s JOIN users creator ON creator.id = s.created_by WHERE ${snapshot.where} AND (s.date < ? OR (s.date = ? AND s.created_at < ?) OR (s.date = ? AND s.created_at = ? AND s.id < ?)) LIMIT 1`).bind(...snapshot.params, rows.at(-1).date, rows.at(-1).date, rows.at(-1).created_at, rows.at(-1).date, rows.at(-1).created_at, rows.at(-1).id).first();
    hasNext = Boolean(probe);
    if (hasNext && !nextCursor) nextCursor = cursorFor('after', snapshotAt, filters, rows.at(-1));
  }
  // Legacy page consumers get a compatibility OFFSET page, but new clients use cursors.
  return { rows, total, limit, page: legacy ? legacyPage : undefined, hasMore: hasNext, hasPrevious, nextCursor: hasNext ? nextCursor : null, previousCursor: hasPrevious ? previousCursor : null, snapshotAt, filters, filterDescription: reportFilterDescription(filters), periodLabel: reportPeriodLabel(filters) };
}

/** Parent API adapter. The parent supplies requireUser's result; role validation remains here. */
export async function getPaginatedReports(context, db, user) {
  ensureMethod(context.request, 'GET');
  if (!user || user.role !== 'manager') throw new ApiError(403, 'manager_required', 'Hanya Manager yang dapat melihat laporan.');
  const url = new URL(context.request.url);
  const filters = parseReportFilters(url.searchParams);
  const result = await queryReportPage(db, filters, url.searchParams);
  const legacyPage = url.searchParams.get('page');
  if (legacyPage != null && !url.searchParams.get('cursor')) {
    if (!/^\d+$/.test(legacyPage) || Number(legacyPage) < 1 || Number(legacyPage) > MAX_PAGE) throw new ApiError(400, 'invalid_page', 'Halaman laporan tidak valid.');
    // Deliberately expose page only as compatibility metadata; parent may use this helper for cursor requests.
    result.page = Number(legacyPage);
  }
  return result;
}

export { encodeCursor, decodeCursor, filterHash };
