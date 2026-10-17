import { ApiError, ensureMethod, jsonResponse } from './http.js';

const PAGE_SIZE = 100;

function parseCursor(raw) {
  if (!raw) return null;
  if (!/^\d{1,15}$/.test(raw)) throw new ApiError(400, 'invalid_cursor', 'Penanda halaman tidak valid.');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ApiError(400, 'invalid_cursor', 'Penanda halaman tidak valid.');
  return value;
}

function mapSubmission(row) {
  if (!row) return null;
  return {
    id: row.id, type: row.type, status: row.status, amountIdr: Number(row.amount_idr),
    date: row.date, description: row.description, note: row.note || '',
    decisionReason: row.decision_reason || '', createdAt: row.created_at, updatedAt: row.updated_at,
    createdBy: row.created_by, createdByName: row.created_by_name || '',
    createdByPosition: row.created_by_position || '', resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name || '', sentBy: row.sent_by, sentByName: row.sent_by_name || ''
  };
}

export async function getReportActivity(context, db, user, id) {
  ensureMethod(context.request, 'GET');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError(404, 'submission_not_found', 'Pengajuan tidak ditemukan.');
  }
  const row = await db.prepare(`
    SELECT s.id, s.type, s.status, s.amount_idr, s.date, s.description, s.note,
           s.decision_reason, s.created_at, s.updated_at, s.created_by, s.resolved_by, s.sent_by,
           creator.name AS created_by_name, creator.position AS created_by_position,
           resolver.name AS resolved_by_name, sender.name AS sent_by_name
    FROM submissions s JOIN users creator ON creator.id = s.created_by
    LEFT JOIN users resolver ON resolver.id = s.resolved_by LEFT JOIN users sender ON sender.id = s.sent_by
    WHERE s.id = ? LIMIT 1
  `).bind(id).first();
  if (!row || (user.role !== 'manager' && row.created_by !== user.id)) {
    throw new ApiError(404, 'submission_not_found', 'Pengajuan tidak ditemukan.');
  }
  const cursor = parseCursor(new URL(context.request.url).searchParams.get('cursor'));
  const rows = (await db.prepare(`
    SELECT a.id, a.action, a.entity_type, a.entity_id, a.details_json, a.created_at,
           COALESCE(u.name, 'Sistem') AS actor_name
    FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.entity_type = 'submission' AND a.entity_id = ?
      AND a.action IN ('submission.created', 'submission.status_changed', 'submission.statuschanged')
      ${cursor ? 'AND a.id > ?' : ''}
    ORDER BY a.id ASC LIMIT ${PAGE_SIZE + 1}
  `).bind(...(cursor ? [id, cursor] : [id])).all()).results || [];
  const hasMore = rows.length > PAGE_SIZE;
  const events = rows.slice(0, PAGE_SIZE).map(event => {
    let details = {};
    try { details = JSON.parse(event.details_json || '{}'); } catch { details = {}; }
    return { id: Number(event.id), action: event.action, actorName: event.actor_name, createdAt: event.created_at, details };
  });
  return jsonResponse({
    submission: mapSubmission(row),
    activity: events,
    nextCursor: hasMore && events.length ? String(events.at(-1).id) : null,
    hasMore
  });
}
