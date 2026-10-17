import {
  ApiError,
  cleanText,
  ensureMethod,
  ensureSameOrigin,
  isValidIsoDate,
  jakartaToday,
  jsonResponse,
  normalizedEmail,
  readJson
} from '../_lib/http.js';
import {
  createSession,
  deleteCurrentSession,
  getSessionUser,
  getPasswordParameters,
  hashClientCredential,
  verifyClientCredential,
  readSessionToken,
  safeUser,
  secretMatches,
  sha256Hex
} from '../_lib/auth.js';
import { INITIAL_ROSTER, MANAGER_EMAIL } from '../_lib/roster.js';
import { handlePasskeyApi } from '../_lib/webauthn.js';
import { validProfileImage } from '../_lib/profile-photo.js';
import { ensureUserProfilesSchema } from '../_lib/migration-guard.js';
import { csvLine, csvHeader } from '../_lib/csv-export.js';
import { buildFinancialReport } from '../_lib/pdf-report.js';
import { createCashTopup } from '../_lib/cash-topup.js';
import { getCashReconciliations, createCashReconciliation } from '../_lib/cash-reconciliation.js';
import { listSubmissionReceipts, createSubmissionReceipt, getSubmissionReceipt } from '../_lib/submission-receipts.js';
import { getFinancialSettings, updateFinancialSettings, getFinancialAlerts, findPotentialDuplicates } from '../_lib/financial-alerts.js';
import { getPaginatedReports } from '../_lib/report-pagination.js';
import { getReportActivity } from '../_lib/report-activity.js';
import { getCashInsights } from '../_lib/cash-insights.js';
import {
  parseReportFilters,
  buildSubmissionFilterSql,
  hasSubmissionSpecificFilter,
  reportFilterDescription,
  reportPeriodLabel
} from '../_lib/report-filters.js';

const PASSWORD_PATH = '/account/password';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_IP_FAILURE_LIMIT = 20;
const LOGIN_ATTEMPT_MAX_ROWS = 20000;
const HISTORY_PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nowIso() {
  return new Date().toISOString();
}

function wibBoundary(date, end = false) {
  const value = new Date(`${date}T00:00:00+07:00`);
  if (end) value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

function apiPath(request) {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
  return pathname.startsWith('/api/') ? pathname.slice(4) : '/';
}

function requireDatabase(env) {
  if (!env?.DB) throw new ApiError(503, 'database_unavailable', 'Layanan data belum tersedia.');
  return env.DB;
}

function requirePassword(value, name = 'Password') {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new ApiError(400, 'password_policy', `${name} harus berisi 12–128 karakter.`);
  }
  return value;
}

function resultChanges(result) {
  return Number(result?.meta?.changes || 0);
}

function profileFields(row) {
  return {
    nickname: row.nickname || '',
    dashboardPosition: row.dashboardPosition ?? row.dashboard_position ?? row.position ?? '',
    quote: row.quote || '',
    hasPhoto: Boolean(row.hasPhoto ?? row.has_photo),
    profileVersion: Number(row.profileVersion ?? row.profile_version ?? 0)
  };
}

function mapListedUser(row) {
  const profile = profileFields(row);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    position: row.position,
    role: row.role,
    nickname: profile.nickname,
    dashboardPosition: profile.dashboardPosition,
    quote: profile.quote,
    photoUrl: profile.hasPhoto
      ? `/api/users/${encodeURIComponent(row.id)}/photo?v=${profile.profileVersion}`
      : '',
    profileVersion: profile.profileVersion,
    active: Boolean(row.is_active),
    passwordReady: Boolean(row.password_ready),
    mustChangePassword: Boolean(row.must_change_password),
    passkeyCount: Number(row.passkey_count || 0),
    createdAt: row.created_at
  };
}

async function parseProfileBody(body) {
  const allowed = new Set(['nickname', 'dashboardPosition', 'quote', 'photoDataUrl', 'profileVersion']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new ApiError(400, 'unknown_profile_field', 'Isi profil tidak dikenali.');
  if (!Number.isSafeInteger(body.profileVersion) || body.profileVersion < 0) {
    throw new ApiError(400, 'profile_version_required', 'Muat profil terbaru sebelum menyimpan.');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'nickname') || !Object.prototype.hasOwnProperty.call(body, 'dashboardPosition') || !Object.prototype.hasOwnProperty.call(body, 'quote')) {
    throw new ApiError(400, 'profile_fields_required', 'Nickname, posisi dashboard, dan quote wajib dikirim.');
  }
  const nickname = typeof body.nickname === 'string' && !body.nickname.trim() ? '' : cleanText(body.nickname, 40);
  const quote = typeof body.quote === 'string' && !body.quote.trim() ? '' : cleanText(body.quote, 300);
  const emptyPosition = body.dashboardPosition === null || (typeof body.dashboardPosition === 'string' && !body.dashboardPosition.trim());
  const dashboardPosition = emptyPosition ? null : cleanText(body.dashboardPosition, 80);
  if (nickname === null) throw new ApiError(400, 'invalid_nickname', 'Nickname harus berupa teks maksimal 40 karakter.');
  if (quote === null) throw new ApiError(400, 'invalid_quote', 'Quote harus berupa teks maksimal 300 karakter.');
  if (!emptyPosition && dashboardPosition === null) throw new ApiError(400, 'invalid_dashboard_position', 'Posisi dashboard harus berupa teks maksimal 80 karakter.');
  let photo = undefined, photoMime = undefined;
  if (Object.prototype.hasOwnProperty.call(body, 'photoDataUrl')) {
    if (body.photoDataUrl === null) { photo = null; photoMime = null; }
    else {
      if (typeof body.photoDataUrl !== 'string' || body.photoDataUrl.length > 200000) throw new ApiError(400, 'invalid_photo', 'Foto harus berupa data URL JPEG, PNG, atau WebP maksimal 128 KiB.');
      const match = body.photoDataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) throw new ApiError(400, 'invalid_photo', 'Foto harus berupa data URL JPEG, PNG, atau WebP.');
      let bytes;
      try { bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0)); } catch { throw new ApiError(400, 'invalid_photo', 'Data foto tidak valid.'); }
      let canonical = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) canonical += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      if (btoa(canonical) !== match[2]) throw new ApiError(400, 'invalid_photo', 'Encoding foto tidak valid.');
      if (bytes.length > 131072) throw new ApiError(413, 'photo_too_large', 'Foto maksimal 128 KiB.');
      if (!await validProfileImage(bytes, match[1])) throw new ApiError(400, 'invalid_photo', 'Isi foto tidak valid atau dimensinya melebihi 2048 piksel.');
      photo = bytes; photoMime = match[1];
    }
  }
  return { nickname, dashboardPosition, quote, photo, photoMime };
}

function mapSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    amountIdr: Number(row.amount_idr),
    date: row.date,
    description: row.description,
    note: row.note || '',
    decisionReason: row.decision_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name || '',
    createdByPosition: row.created_by_position || '',
    resolvedByName: row.resolved_by_name || '',
    sentByName: row.sent_by_name || ''
  };
}

async function readSubmission(db, id) {
  const row = await db.prepare(`
    SELECT s.id, s.type, s.status, s.amount_idr, s.date, s.description, s.note,
           s.decision_reason, s.created_at, s.updated_at, s.created_by,
           creator.name AS created_by_name, creator.position AS created_by_position,
           resolver.name AS resolved_by_name, sender.name AS sent_by_name
    FROM submissions s
    JOIN users creator ON creator.id = s.created_by
    LEFT JOIN users resolver ON resolver.id = s.resolved_by
    LEFT JOIN users sender ON sender.id = s.sent_by
    WHERE s.id = ?
    LIMIT 1
  `).bind(id).first();
  return mapSubmission(row);
}

function canonicalSubmissionPayload(payload) {
  return JSON.stringify({
    type: payload.type,
    amountIdr: Number(payload.amountIdr),
    date: payload.date,
    description: payload.description,
    note: payload.note || ''
  });
}

async function findIdempotentSubmission(db, userId, key, payloadHash) {
  const row = await db.prepare(`
    SELECT id, payload_hash, type, amount_idr, date, description, note
    FROM submissions
    WHERE created_by = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(userId, key).first();
  if (!row) return null;
  const storedHash = row.payload_hash || await sha256Hex(canonicalSubmissionPayload({
    type: row.type,
    amountIdr: row.amount_idr,
    date: row.date,
    description: row.description,
    note: row.note
  }));
  if (storedHash !== payloadHash) {
    throw new ApiError(409, 'idempotency_key_reused', 'Kunci pengajuan sudah dipakai untuk isi yang berbeda.');
  }
  return row;
}

async function requireUser(request, db, options = {}) {
  const user = await getSessionUser(request, db);
  if (!user) throw new ApiError(401, 'authentication_required', 'Sesi berakhir. Silakan masuk kembali.');
  if (user.mustChangePassword && !options.allowPasswordChange) {
    throw new ApiError(403, 'password_change_required', 'Buat password baru untuk melanjutkan.');
  }
  return user;
}

function requireManager(user) {
  if (user.role !== 'manager') throw new ApiError(403, 'manager_required', 'Aksi ini hanya tersedia untuk Manager.');
}

async function cashInsights(context, db) {
  ensureMethod(context.request, 'GET');
  const user = await requireUser(context.request, db);
  requireManager(user);
  const url = new URL(context.request.url);
  const today = url.searchParams.get('today') || undefined;
  if (today && !isValidIsoDate(today)) throw new ApiError(400, 'invalid_date', 'Tanggal analisis WIB tidak valid.');
  return jsonResponse(await getCashInsights(db, context.env, { today }));
}

async function rateKey(scope, identifier) {
  return sha256Hex(`${scope}\u0000${identifier}`);
}

function clientAddress(request) {
  // Cloudflare overwrites this header at the edge. Local Wrangler uses a stable fallback.
  const address = (request.headers.get('CF-Connecting-IP') || '').trim();
  return address && address.length <= 80 ? address.toLowerCase() : 'local-client';
}

async function readLoginBlock(db, key, nowMs) {
  const row = await db.prepare(
    'SELECT blocked_until_ms FROM login_attempts WHERE rate_key = ? LIMIT 1'
  ).bind(key).first();
  return Number(row?.blocked_until_ms || 0) > nowMs;
}

function pruneLoginAttempts(db, nowMs) {
  return db.prepare(`
    DELETE FROM login_attempts
    WHERE (blocked_until_ms <= ? AND window_started_ms <= ?)
       OR rate_key IN (
         SELECT rate_key FROM login_attempts
         ORDER BY window_started_ms DESC,
                  CASE WHEN blocked_until_ms > ? THEN 1 ELSE 0 END DESC,
                  rate_key ASC
         LIMIT -1 OFFSET ${LOGIN_ATTEMPT_MAX_ROWS}
       )
  `).bind(nowMs, nowMs - LOGIN_WINDOW_MS, nowMs);
}

function recordLoginFailure(db, key, nowMs, limit) {
  return db.prepare(`
    INSERT INTO login_attempts (rate_key, failure_count, window_started_ms, blocked_until_ms)
    VALUES (?, 1, ?, 0)
    ON CONFLICT(rate_key) DO UPDATE SET
      failure_count = CASE
        WHEN excluded.window_started_ms - login_attempts.window_started_ms >= ${LOGIN_WINDOW_MS} THEN 1
        ELSE login_attempts.failure_count + 1
      END,
      window_started_ms = CASE
        WHEN excluded.window_started_ms - login_attempts.window_started_ms >= ${LOGIN_WINDOW_MS} THEN excluded.window_started_ms
        ELSE login_attempts.window_started_ms
      END,
      blocked_until_ms = CASE
        WHEN (CASE
          WHEN excluded.window_started_ms - login_attempts.window_started_ms >= ${LOGIN_WINDOW_MS} THEN 1
          ELSE login_attempts.failure_count + 1
        END) >= ${limit} THEN excluded.window_started_ms + ${LOGIN_BLOCK_MS}
        ELSE 0
      END
  `).bind(key, nowMs);
}

async function login(context, db) {
  const { request } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const body = await readJson(request);
  const email = normalizedEmail(body.email);
  const emailKey = email || String(body.email || '').trim().toLowerCase().slice(0, 180);
  const credential = body.credential;
  const accountKey = await rateKey('account', emailKey || 'invalid-identifier');
  const ipKey = await rateKey('ip', clientAddress(request));
  const nowMs = Date.now();
  await pruneLoginAttempts(db, nowMs).run();
  const [accountBlocked, ipBlocked] = await Promise.all([
    readLoginBlock(db, accountKey, nowMs),
    readLoginBlock(db, ipKey, nowMs)
  ]);
  if (accountBlocked || ipBlocked) {
    throw new ApiError(429, 'login_rate_limited', 'Terlalu banyak percobaan. Coba lagi beberapa menit.');
  }
  const user = email ? await db.prepare(`
    SELECT u.id, u.name, u.email, u.position, u.role, u.password_hash, u.must_change_password,
           p.nickname, p.dashboard_position AS dashboardPosition, p.quote,
           CASE WHEN p.photo IS NULL THEN 0 ELSE 1 END AS hasPhoto,
           COALESCE(p.version, 0) AS profileVersion
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE u.email = ? COLLATE NOCASE AND u.is_active = 1
    LIMIT 1
  `).bind(email).first() : null;
  const passwordValid = await verifyClientCredential(credential, user?.password_hash || null, user?.email || email, context.env);
  if (!user || !user.password_hash || !passwordValid) {
    await db.batch([
      recordLoginFailure(db, accountKey, nowMs, LOGIN_FAILURE_LIMIT),
      recordLoginFailure(db, ipKey, nowMs, LOGIN_IP_FAILURE_LIMIT),
      pruneLoginAttempts(db, nowMs)
    ]);
    throw new ApiError(401, 'invalid_credentials', 'ID masuk atau password tidak sesuai.');
  }
  await db.prepare('DELETE FROM login_attempts WHERE rate_key = ?').bind(accountKey).run();
  const session = await createSession(db, user.id);
  return jsonResponse({
    ok: true,
    user: safeUser({ ...user, mustChangePassword: Boolean(user.must_change_password) }),
    expiresAt: session.expiresAt
  }, 200, { 'Set-Cookie': session.cookie });
}

async function passwordParameters(context, db) {
  const { request, env } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const body = await readJson(request, 2_000);
  const email = normalizedEmail(body.email);
  if (!email) throw new ApiError(400, 'invalid_login_id', 'ID masuk tidak valid.');
  const row = await db.prepare('SELECT email, password_hash FROM users WHERE email = ? COLLATE NOCASE AND is_active = 1 LIMIT 1').bind(email).first();
  const parameters = await getPasswordParameters(row?.password_hash || null, email, env);
  return jsonResponse(parameters);
}

async function bootstrap(context, db) {
  const { request, env } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const authorization = request.headers.get('Authorization') || '';
  const providedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!secretMatches(providedToken, env.BOOTSTRAP_TOKEN)) {
    throw new ApiError(404, 'not_found', 'Endpoint tidak ditemukan.');
  }
  const body = await readJson(request);
  const managerCredential = body.managerCredential;
  if (!managerCredential || typeof managerCredential !== 'object') throw new ApiError(400, 'invalid_credential', 'Kredensial password tidak valid.');
  const existing = await db.prepare('SELECT COUNT(*) AS count FROM users').first();
  if (Number(existing?.count || 0) > 0) {
    throw new ApiError(409, 'already_initialized', 'Akun awal sudah disiapkan.');
  }

  const managerHash = await hashClientCredential(managerCredential, MANAGER_EMAIL, env);
  const createdAt = nowIso();
  const manager = INITIAL_ROSTER.find(person => person.email === MANAGER_EMAIL);
  const testManagerId = env.WEBAUTHN_PROFILE === 'test' && typeof env.PASSKEY_MANAGER_ID === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.PASSKEY_MANAGER_ID)
    ? env.PASSKEY_MANAGER_ID : '';
  const managerId = testManagerId || crypto.randomUUID();
  const users = INITIAL_ROSTER.map(person => ({
    ...person,
    id: person.email === MANAGER_EMAIL ? managerId : crypto.randomUUID()
  }));
  const statements = users.map(person => db.prepare(`
    INSERT INTO users
      (id, name, email, position, role, password_hash, must_change_password,
       is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    person.id,
    person.name,
    person.email.toLowerCase(),
    person.position,
    person.role,
    person.email === MANAGER_EMAIL ? managerHash : null,
    1,
    createdAt,
    createdAt
  ));
  statements.push(db.prepare(`
    INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
    VALUES (?, 'system.bootstrap_completed', 'system', 'initial-roster', ?, ?)
  `).bind(manager?.email === MANAGER_EMAIL ? managerId : null, JSON.stringify({ userCount: users.length, initialCashBalanceIdr: 0 }), createdAt));
  try {
    await db.batch(statements);
  } catch (error) {
    const countAfter = await db.prepare('SELECT COUNT(*) AS count FROM users').first().catch(() => null);
    if (Number(countAfter?.count || 0) > 0) {
      throw new ApiError(409, 'already_initialized', 'Akun awal sudah disiapkan.');
    }
    throw error;
  }
  return jsonResponse({ ok: true, seededUsers: users.length, usersNeedingPassword: users.length - 1 }, 201);
}

async function session(context, db) {
  ensureMethod(context.request, 'GET');
  const user = await getSessionUser(context.request, db);
  if (!user) throw new ApiError(401, 'authentication_required', 'Belum ada sesi aktif.');
  return jsonResponse({ authenticated: true, user: safeUser(user), expiresAt: user.expiresAt });
}

function parseSubmissionCursor(raw) {
  if (!raw) return null;
  const separator = raw.lastIndexOf('|');
  if (separator < 1) throw new ApiError(400, 'invalid_cursor', 'Penanda halaman tidak valid.');
  const createdAt = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)
      || !Number.isFinite(Date.parse(createdAt)) || !UUID_PATTERN.test(id)) {
    throw new ApiError(400, 'invalid_cursor', 'Penanda halaman tidak valid.');
  }
  return { createdAt, id };
}

function parseIdCursor(raw) {
  if (!raw) return null;
  if (!/^\d{1,15}$/.test(raw)) throw new ApiError(400, 'invalid_cursor', 'Penanda halaman tidak valid.');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, 'invalid_cursor', 'Penanda halaman tidak valid.');
  return id;
}

async function submissionsPage(db, user, cursor = null) {
  const filters = [];
  const params = [];
  if (user.role !== 'manager') {
    filters.push('s.created_by = ?');
    params.push(user.id);
  }
  if (cursor) {
    filters.push('(s.created_at < ? OR (s.created_at = ? AND s.id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await db.prepare(`
    SELECT s.id, s.type, s.status, s.amount_idr, s.date, s.description, s.note,
           s.decision_reason, s.created_at, s.updated_at, s.created_by,
           creator.name AS created_by_name, creator.position AS created_by_position,
           resolver.name AS resolved_by_name, sender.name AS sent_by_name
    FROM submissions s
    JOIN users creator ON creator.id = s.created_by
    LEFT JOIN users resolver ON resolver.id = s.resolved_by
    LEFT JOIN users sender ON sender.id = s.sent_by
    ${where}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ${HISTORY_PAGE_SIZE + 1}
  `).bind(...params).all();
  const rows = result.results || [];
  const hasMore = rows.length > HISTORY_PAGE_SIZE;
  const pageRows = rows.slice(0, HISTORY_PAGE_SIZE);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(mapSubmission),
    hasMore,
    nextCursor: hasMore && last ? `${last.created_at}|${last.id}` : null
  };
}

async function cashLedgerPage(db, cursor = null) {
  const id = parseIdCursor(cursor);
  const result = await db.prepare(`
    SELECT l.id, l.event_type, l.direction, l.amount_idr, l.balance_after_idr,
           l.submission_id, l.note, l.created_at, u.name AS actor_name
    FROM cash_ledger l
    LEFT JOIN users u ON u.id = l.actor_id
    ${id ? 'WHERE l.id < ?' : ''}
    ORDER BY l.id DESC
    LIMIT ${HISTORY_PAGE_SIZE + 1}
  `).bind(...(id ? [id] : [])).all();
  const rows = result.results || [];
  const hasMore = rows.length > HISTORY_PAGE_SIZE;
  const items = rows.slice(0, HISTORY_PAGE_SIZE);
  return { items, hasMore, nextCursor: hasMore && items.length ? String(items.at(-1).id) : null };
}

async function auditEventsPage(db, cursor = null) {
  const id = parseIdCursor(cursor);
  const result = await db.prepare(`
    SELECT a.id, a.action, a.entity_type, a.entity_id, a.details_json, a.created_at,
           COALESCE(u.name, 'Sistem') AS actor_name
    FROM audit_events a
    LEFT JOIN users u ON u.id = a.actor_id
    ${id ? 'WHERE a.id < ?' : ''}
    ORDER BY a.id DESC
    LIMIT ${HISTORY_PAGE_SIZE + 1}
  `).bind(...(id ? [id] : [])).all();
  const rows = result.results || [];
  const hasMore = rows.length > HISTORY_PAGE_SIZE;
  const items = rows.slice(0, HISTORY_PAGE_SIZE);
  return { items, hasMore, nextCursor: hasMore && items.length ? String(items.at(-1).id) : null };
}

function historyMetadata(page, total) {
  return {
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    total: Number(total || 0),
    loaded: page.items.length
  };
}

async function completeCashFlow(db) {
  let incoming = 0n, outgoing = 0n, cursor = null, openingConfigured = false;
  for (;;) {
    const rows = (await db.prepare(`SELECT id,event_type,direction,CAST(amount_idr AS TEXT) AS amount_idr FROM cash_ledger ${cursor === null ? '' : 'WHERE id < ?'} ORDER BY id DESC LIMIT 500`).bind(...(cursor === null ? [] : [cursor])).all()).results || [];
    for (const row of rows) {
      const amount = BigInt(row.amount_idr || 0);
      if (row.direction === 'credit') incoming += amount;
      else if (row.direction === 'debit') outgoing += amount;
      if (row.event_type === 'opening_balance' && amount > 0n) openingConfigured = true;
    }
    if (rows.length < 500) break;
    cursor = rows.at(-1).id;
  }
  return { incomingIdr:incoming.toString(), outgoingIdr:outgoing.toString(), openingConfigured };
}
async function overview(context, db) {
  ensureMethod(context.request, 'GET');
  const user = await requireUser(context.request, db);

  if (user.role !== 'manager') {
    // User hanya boleh melihat pengajuan miliknya sendiri. Jangan query atau
    // kirim saldo, ledger, audit, atau metadata pengelolaan kas di jalur ini.
    const submissionPage = await submissionsPage(db, user);
    const submissions = submissionPage.items;
    const counts = await db.prepare(`
      SELECT COUNT(*) AS total_count,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
             SUM(CASE WHEN type = 'petty_cash' THEN 1 ELSE 0 END) AS petty_cash_count
      FROM submissions WHERE created_by = ?
    `).bind(user.id).first();
    return jsonResponse({
      user: safeUser(user),
      submissions,
      history: { submissions: historyMetadata(submissionPage, counts?.total_count) },
      summary: {
        total: Number(counts?.total_count || 0),
        pending: Number(counts?.pending_count || 0),
        pettyCash: Number(counts?.petty_cash_count || 0)
      }
    });
  }

  const passkeyCountSql = context.env?.PASSKEY_AUTH_ENABLED === 'true'
    ? '(SELECT COUNT(*) FROM passkey_credentials p WHERE p.user_id = users.id)'
    : '0';
  const [cash, submissionPage] = await Promise.all([
    db.prepare("SELECT balance_idr FROM cash_accounts WHERE id = 'operational' LIMIT 1").first(),
    submissionsPage(db, user)
  ]);
  const cashBalanceIdr = Number(cash?.balance_idr || 0);
  const submissions = submissionPage.items;
  const [summaryRow, usersResult, ledgerPage, auditPage, ledgerCount, auditCount, cashFlow] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN type = 'finance_request' AND status = 'approved' THEN 1 ELSE 0 END) AS finance_waiting,
        SUM(CASE WHEN type = 'finance_request' THEN 1 ELSE 0 END) AS finance_total,
        SUM(CASE WHEN type = 'finance_request' AND status = 'sent' THEN 1 ELSE 0 END) AS finance_sent,
        SUM(CASE WHEN type = 'finance_request' AND status = 'rejected' THEN 1 ELSE 0 END) AS finance_rejected,
        SUM(CASE WHEN date = ? THEN 1 ELSE 0 END) AS today_count
      FROM submissions
    `).bind(jakartaToday()).first(),
    db.prepare(`
      SELECT users.id, users.name, users.email, users.position, users.role, users.is_active,
             CASE WHEN users.password_hash IS NULL THEN 0 ELSE 1 END AS password_ready,
             users.must_change_password, users.created_at, ${passkeyCountSql} AS passkey_count,
             p.nickname, p.dashboard_position, p.quote, p.photo_mime, CASE WHEN p.photo IS NULL THEN 0 ELSE 1 END AS has_photo,
             COALESCE(p.version, 0) AS profile_version
      FROM users LEFT JOIN user_profiles p ON p.user_id = users.id
      ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, name COLLATE NOCASE
      LIMIT 100
    `).all(),
    cashLedgerPage(db),
    auditEventsPage(db),
    db.prepare('SELECT COUNT(*) AS count FROM cash_ledger').first(),
    db.prepare('SELECT COUNT(*) AS count FROM audit_events').first(),
    completeCashFlow(db)
  ]);
  return jsonResponse({
    user: safeUser(user),
    cashBalanceIdr,
    cashFlow,
    submissions,
    history: {
      submissions: historyMetadata(submissionPage, summaryRow?.total_count),
      cashLedger: historyMetadata(ledgerPage, ledgerCount?.count),
      auditEvents: historyMetadata(auditPage, auditCount?.count)
    },
    users: (usersResult.results || []).map(mapListedUser),
    cashLedger: ledgerPage.items,
    auditEvents: auditPage.items,
    summary: {
      pending: Number(summaryRow?.pending_count || 0),
      financeWaiting: Number(summaryRow?.finance_waiting || 0),
      financeTotal: Number(summaryRow?.finance_total || 0),
      financeSent: Number(summaryRow?.finance_sent || 0),
      financeRejected: Number(summaryRow?.finance_rejected || 0),
      today: Number(summaryRow?.today_count || 0),
      total: Number(summaryRow?.total_count || 0)
    }
  });
}

async function listSubmissions(context, db) {
  ensureMethod(context.request, 'GET');
  const user = await requireUser(context.request, db);
  const url = new URL(context.request.url);
  const page = await submissionsPage(db, user, parseSubmissionCursor(url.searchParams.get('cursor')));
  const count = user.role === 'manager'
    ? await db.prepare('SELECT COUNT(*) AS count FROM submissions').first()
    : await db.prepare('SELECT COUNT(*) AS count FROM submissions WHERE created_by = ?').bind(user.id).first();
  return jsonResponse({
    submissions: page.items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    total: Number(count?.count || 0)
  });
}

async function historyPage(context, db, collection) {
  ensureMethod(context.request, 'GET');
  const user = await requireUser(context.request, db);
  const cursor = new URL(context.request.url).searchParams.get('cursor');
  if (collection === 'submissions') {
    const page = await submissionsPage(db, user, parseSubmissionCursor(cursor));
    const count = user.role === 'manager'
      ? await db.prepare('SELECT COUNT(*) AS count FROM submissions').first()
      : await db.prepare('SELECT COUNT(*) AS count FROM submissions WHERE created_by = ?').bind(user.id).first();
    return jsonResponse({ submissions: page.items, ...historyMetadata(page, count?.count) });
  }
  requireManager(user);
  if (collection === 'cash-ledger') {
    const page = await cashLedgerPage(db, cursor);
    const count = await db.prepare('SELECT COUNT(*) AS count FROM cash_ledger').first();
    return jsonResponse({ cashLedger: page.items, ...historyMetadata(page, count?.count) });
  }
  if (collection === 'audit-events') {
    const page = await auditEventsPage(db, cursor);
    const count = await db.prepare('SELECT COUNT(*) AS count FROM audit_events').first();
    return jsonResponse({ auditEvents: page.items, ...historyMetadata(page, count?.count) });
  }
  throw new ApiError(404, 'not_found', 'Riwayat tidak ditemukan.');
}

async function createSubmission(context, db) {
  const { request } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const user = await requireUser(request, db);
  if (!['user', 'manager'].includes(user.role)) throw new ApiError(403, 'submission_role_required', 'Akun ini tidak dapat membuat pengajuan.');
  const body = await readJson(request);
  const type = body.type;
  const amount = body.amountIdr;
  const date = body.date;
  const description = cleanText(body.description, 150);
  const note = body.note === undefined || body.note === null || body.note === '' ? '' : cleanText(body.note, 500);
  const idempotencyKey = request.headers.get('Idempotency-Key') || '';
  if (!['petty_cash', 'finance_request'].includes(type)) {
    throw new ApiError(400, 'invalid_submission_type', 'Pilih Petty cash atau Request Finance.');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ApiError(400, 'invalid_amount', 'Nominal harus berupa bilangan rupiah positif.');
  }
  if (!isValidIsoDate(date)) throw new ApiError(400, 'invalid_date', 'Tanggal laporan tidak valid.');
  if (!description) throw new ApiError(400, 'invalid_description', 'Keperluan wajib diisi (3–150 karakter).');
  if (body.note && !note) throw new ApiError(400, 'invalid_note', 'Catatan maksimal 500 karakter.');
  if (!UUID_PATTERN.test(idempotencyKey)) throw new ApiError(400, 'idempotency_required', 'Kunci pengajuan tidak valid.');

  const payloadHash = await sha256Hex(canonicalSubmissionPayload({
    type, amountIdr: amount, date, description, note: note || ''
  }));
  const existing = await findIdempotentSubmission(db, user.id, idempotencyKey, payloadHash);
  if (existing) return jsonResponse({ submission: await readSubmission(db, existing.id), alreadyCreated: true });

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  try {
    const statements = [
      db.prepare(`
        INSERT INTO submissions
          (id, idempotency_key, payload_hash, created_by, type, status, amount_idr, date,
           description, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
      `).bind(id, idempotencyKey, payloadHash, user.id, type, amount, date, description, note || '', createdAt, createdAt),
      db.prepare(`
        INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
        VALUES (?, 'submission.created', 'submission', ?, ?, ?)
      `).bind(user.id, id, JSON.stringify({ type, amountIdr: amount }), createdAt)
    ];
    if (user.role === 'manager') {
      // Automatic acceptance is not a manual self-decision: resolved_by stays
      // NULL. Reuse status triggers for balance checks, ledger and audit, in the
      // same atomic batch so insufficient cash cannot leave a pending request.
      statements.push(db.prepare(`
        UPDATE submissions
        SET status = 'approved', updated_by = ?, updated_at = ?
        WHERE id = ? AND created_by = ? AND status = 'pending'
      `).bind(user.id, createdAt, id, user.id));
    }
    await db.batch(statements);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (String(error?.message || '').includes('insufficient_petty_cash_balance')) {
      throw new ApiError(409, 'insufficient_petty_cash', 'Saldo petty cash tidak mencukupi. Minta pemilik mengonfirmasi saldo awal yang benar.');
    }
    if (user.role === 'manager' && String(error?.message || '').includes('only_user_accounts_may_submit')) {
      throw new ApiError(503, 'migration_required', 'Pengajuan Manager belum tersedia. Administrator perlu menerapkan migrasi 0004_manager_submissions.sql.');
    }
    let duplicate = null;
    try {
      duplicate = await findIdempotentSubmission(db, user.id, idempotencyKey, payloadHash);
    } catch (lookupError) {
      if (lookupError instanceof ApiError) throw lookupError;
    }
    if (duplicate) return jsonResponse({ submission: await readSubmission(db, duplicate.id), alreadyCreated: true });
    throw error;
  }
  return jsonResponse({ submission: await readSubmission(db, id) }, 201);
}

async function decideSubmission(context, db, id, action) {
  const { request } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const actor = await requireUser(request, db);
  requireManager(actor);
  if (!UUID_PATTERN.test(id)) throw new ApiError(404, 'submission_not_found', 'Pengajuan tidak ditemukan.');
  const body = await readJson(request);
  const reason = action === 'reject' ? cleanText(body.reason, 500) : '';
  if (action === 'reject' && !reason) {
    throw new ApiError(400, 'decision_reason_required', 'Alasan penolakan wajib diisi.');
  }
  const updatedAt = nowIso();
  const status = action === 'approve' ? 'approved' : 'rejected';
  try {
    const result = await db.prepare(`
      UPDATE submissions
      SET status = ?, resolved_by = ?, updated_by = ?, decision_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND created_by <> ?
    `).bind(status, actor.id, actor.id, reason || '', updatedAt, id, actor.id).run();
    if (!resultChanges(result)) {
      const current = await db.prepare('SELECT id, status, created_by FROM submissions WHERE id = ? LIMIT 1').bind(id).first();
      if (!current) throw new ApiError(404, 'submission_not_found', 'Pengajuan tidak ditemukan.');
      if (current.created_by === actor.id) throw new ApiError(403, 'self_decision_not_allowed', 'Manager tidak dapat memutuskan pengajuan miliknya sendiri.');
      if ((action === 'approve' && current.status === 'approved') || (action === 'reject' && current.status === 'rejected')) {
        return jsonResponse({ submission: await readSubmission(db, id), alreadyApplied: true });
      }
      throw new ApiError(409, 'submission_already_decided', 'Pengajuan sudah diputuskan atau statusnya tidak dapat diubah.');
    }
  } catch (error) {
    if (String(error?.message || '').includes('insufficient_petty_cash_balance')) {
      throw new ApiError(409, 'insufficient_petty_cash', 'Saldo petty cash tidak mencukupi. Minta pemilik mengonfirmasi saldo awal yang benar.');
    }
    if (String(error?.message || '').includes('self_decision_not_allowed')) {
      throw new ApiError(403, 'self_decision_not_allowed', 'Manager tidak dapat memutuskan pengajuan miliknya sendiri.');
    }
    if (error instanceof ApiError) throw error;
    throw error;
  }
  return jsonResponse({ submission: await readSubmission(db, id) });
}

async function markFinanceSent(context, db, id) {
  const { request } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const actor = await requireUser(request, db);
  requireManager(actor);
  if (!UUID_PATTERN.test(id)) throw new ApiError(404, 'submission_not_found', 'Pengajuan tidak ditemukan.');
  const sentAt = nowIso();
  const result = await db.prepare(`
    UPDATE submissions
    SET status = 'sent', sent_by = ?, updated_by = ?, updated_at = ?
    WHERE id = ? AND type = 'finance_request' AND status = 'approved'
  `).bind(actor.id, actor.id, sentAt, id).run();
  if (!resultChanges(result)) {
    const current = await db.prepare('SELECT id, status, type FROM submissions WHERE id = ? LIMIT 1').bind(id).first();
    if (!current) throw new ApiError(404, 'submission_not_found', 'Pengajuan tidak ditemukan.');
    if (current.type === 'finance_request' && current.status === 'sent') {
      return jsonResponse({ submission: await readSubmission(db, id), alreadyApplied: true });
    }
    throw new ApiError(409, 'finance_request_not_ready', 'Request Finance harus disetujui Manager sebelum ditandai terkirim.');
  }
  return jsonResponse({ submission: await readSubmission(db, id) });
}

async function setOpeningBalance(context, db) {
  const { request } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const actor = await requireUser(request, db);
  requireManager(actor);
  const body = await readJson(request);
  const amount = body.amountIdr;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ApiError(400, 'invalid_opening_balance', 'Saldo awal harus berupa nominal rupiah positif.');
  }
  if (body.ownerConfirmed !== true) {
    throw new ApiError(400, 'owner_confirmation_required', 'Tetapkan saldo hanya setelah pemilik mengonfirmasi angka aktual.');
  }
  const createdAt = nowIso();
  const note = 'Saldo awal aktual setelah konfirmasi pemilik.';
  const result = await db.batch([
    db.prepare(`
      INSERT INTO cash_ledger
        (event_type, direction, amount_idr, balance_after_idr, actor_id, note, created_at)
      SELECT 'opening_balance', 'credit', ?, ?, ?, ?, ?
      WHERE (SELECT balance_idr FROM cash_accounts WHERE id = 'operational') = 0
        AND NOT EXISTS (
          SELECT 1 FROM cash_ledger
          WHERE event_type = 'opening_balance' AND amount_idr > 0
        )
        AND NOT EXISTS (
          SELECT 1 FROM cash_ledger WHERE event_type = 'petty_cash_approval'
        )
    `).bind(amount, amount, actor.id, note, createdAt),
    db.prepare(`
      UPDATE cash_accounts
      SET balance_idr = ?, updated_at = ?
      WHERE id = 'operational' AND balance_idr = 0
        AND EXISTS (
          SELECT 1 FROM cash_ledger
          WHERE event_type = 'opening_balance' AND amount_idr = ?
            AND actor_id = ? AND created_at = ?
        )
    `).bind(amount, createdAt, amount, actor.id, createdAt),
    db.prepare(`
      INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
      SELECT ?, 'cash.opening_balance_set', 'cash_account', 'operational',
             json_object('amount_idr', ?, 'balance_after_idr', ?), ?
      WHERE EXISTS (
        SELECT 1 FROM cash_ledger
        WHERE event_type = 'opening_balance' AND amount_idr = ?
          AND actor_id = ? AND created_at = ?
      )
    `).bind(actor.id, amount, amount, createdAt, amount, actor.id, createdAt)
  ]);
  if (!resultChanges(result[0])) {
    const opening = await db.prepare(`
      SELECT amount_idr FROM cash_ledger
      WHERE event_type = 'opening_balance' AND amount_idr > 0
      ORDER BY id ASC LIMIT 1
    `).first();
    if (opening && Number(opening.amount_idr) === amount) {
      const account = await db.prepare("SELECT balance_idr FROM cash_accounts WHERE id = 'operational' LIMIT 1").first();
      return jsonResponse({ ok: true, alreadyApplied: true, cashBalanceIdr: Number(account?.balance_idr || 0) });
    }
    throw new ApiError(409, 'opening_balance_already_set', 'Saldo awal sudah ditetapkan atau tidak lagi dapat diubah.');
  }
  return jsonResponse({ ok: true, cashBalanceIdr: amount }, 201);
}

async function profileUser(db, id) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.position, u.role, u.must_change_password,
           u.is_active, p.nickname, p.dashboard_position AS dashboardPosition,
           p.quote, CASE WHEN p.photo IS NULL THEN 0 ELSE 1 END AS hasPhoto,
           COALESCE(p.version, 0) AS profileVersion
    FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE u.id = ? LIMIT 1
  `).bind(id).first();
}

async function profile(context, db, id) {
  const { request } = context;
  const actor = await requireUser(request, db);
  if (id && !UUID_PATTERN.test(id)) throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan.');
  const targetId = id || actor.id;
  if (actor.role !== 'manager' && targetId !== actor.id) throw new ApiError(403, 'forbidden', 'Profil ini tidak dapat diubah.');
  const target = await profileUser(db, targetId);
  if (!target) throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan.');
  if (request.method === 'GET') return jsonResponse({ user: safeUser({ ...target, mustChangePassword: Boolean(target.must_change_password) }) });
  ensureMethod(request, 'PUT');
  requireManager(actor);
  ensureSameOrigin(request);
  const body = await readJson(request, 200_000);
  const fields = await parseProfileBody(body);
  const timestamp = nowIso();
  const photoChanged = fields.photo !== undefined;
  const values = [fields.nickname, fields.dashboardPosition, fields.quote];
  let profileStatement;
  if (body.profileVersion === 0) {
    profileStatement = db.prepare(`INSERT INTO user_profiles
      (user_id, nickname, dashboard_position, quote, photo, photo_mime, version)
      VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(user_id) DO NOTHING`)
      .bind(targetId, ...values, fields.photo ?? null, fields.photoMime ?? null);
  } else {
    if (photoChanged) values.push(fields.photo, fields.photoMime);
    profileStatement = db.prepare(`UPDATE user_profiles
      SET nickname = ?, dashboard_position = ?, quote = ?,
      ${photoChanged ? 'photo = ?, photo_mime = ?,' : ''} version = version + 1
      WHERE user_id = ? AND version = ?`)
      .bind(...values, targetId, body.profileVersion);
  }
  // D1 batch is transactional. Only a successful compare-and-swap gets an audit event.
  const results = await db.batch([
    profileStatement,
    db.prepare(`INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
      SELECT ?, 'user.profile_updated', 'user', ?, ?, ? WHERE changes() = 1`)
      .bind(actor.id, targetId, JSON.stringify({ nickname: true, dashboardPosition: true, quote: true, photo: photoChanged }), timestamp)
  ]);
  if (!resultChanges(results[0])) {
    throw new ApiError(409, 'profile_conflict', 'Profil telah diubah oleh Manager lain. Salin perubahan Anda bila perlu, lalu tutup dan buka kembali profil untuk memuat data terbaru.');
  }
  const updated = await profileUser(db, targetId);
  return jsonResponse({ user: safeUser({ ...updated, mustChangePassword: Boolean(updated.must_change_password) }) });
}

async function profilePhoto(context, db, id) {
  ensureMethod(context.request, 'GET');
  const actor = await requireUser(context.request, db);
  if (!UUID_PATTERN.test(id)) throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan.');
  if (actor.role !== 'manager' && actor.id !== id) throw new ApiError(403, 'forbidden', 'Foto profil ini tidak dapat diakses.');
  const row = await db.prepare('SELECT photo, photo_mime FROM user_profiles WHERE user_id = ? LIMIT 1').bind(id).first();
  if (!row?.photo || !row.photo_mime) throw new ApiError(404, 'photo_not_found', 'Foto profil belum tersedia.');
  const bytes = Array.isArray(row.photo) ? new Uint8Array(row.photo) : row.photo;
  return new Response(bytes, { status: 200, headers: {
    'Content-Type': row.photo_mime,
    'Cache-Control': 'private, no-store, max-age=0',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  }});
}

async function users(context, db) {
  const { request } = context;
  const actor = await requireUser(request, db);
  requireManager(actor);
  if (request.method === 'GET') {
    const passkeyCountSql = context.env?.PASSKEY_AUTH_ENABLED === 'true'
      ? '(SELECT COUNT(*) FROM passkey_credentials p WHERE p.user_id = users.id)'
      : '0';
    const result = await db.prepare(`
      SELECT users.id, users.name, users.email, users.position, users.role, users.is_active,
             CASE WHEN users.password_hash IS NULL THEN 0 ELSE 1 END AS password_ready,
             users.must_change_password, users.created_at, ${passkeyCountSql} AS passkey_count,
             p.nickname, p.dashboard_position, p.quote, p.photo_mime, CASE WHEN p.photo IS NULL THEN 0 ELSE 1 END AS has_photo,
             COALESCE(p.version, 0) AS profile_version
      FROM users LEFT JOIN user_profiles p ON p.user_id = users.id
      ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, name COLLATE NOCASE
      LIMIT 100
    `).all();
    return jsonResponse({ users: (result.results || []).map(mapListedUser) });
  }
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const body = await readJson(request);
  const name = cleanText(body.name, 80);
  const email = normalizedEmail(body.email);
  const position = body.position === undefined || body.position === '' ? '' : cleanText(body.position, 80);
  if (!name) throw new ApiError(400, 'invalid_name', 'Nama wajib diisi (maksimal 80 karakter).');
  if (!email) throw new ApiError(400, 'invalid_login_id', 'ID masuk harus berupa alamat dengan format yang valid. Email tidak akan dikirim.');
  if (body.position && !position) throw new ApiError(400, 'invalid_position', 'Jabatan maksimal 80 karakter.');
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO users
          (id, name, email, position, role, password_hash, must_change_password,
           is_active, created_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, 'user', NULL, 1, 1, ?, ?, ?)
      `).bind(id, name, email, position || '', createdAt, createdAt, actor.id),
      db.prepare(`
        INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
        VALUES (?, 'user.created', 'user', ?, ?, ?)
      `).bind(actor.id, id, JSON.stringify({ role: 'user' }), createdAt)
    ]);
  } catch (error) {
    if (String(error?.message || '').toLowerCase().includes('unique')) {
      throw new ApiError(409, 'login_id_exists', 'ID masuk tersebut sudah digunakan.');
    }
    throw error;
  }
  return jsonResponse({ user: {
    id,
    name,
    email,
    position: position || '',
    nickname: '',
    dashboardPosition: position || '',
    quote: '',
    photoUrl: '',
    profileVersion: 0,
    role: 'user',
    active: true,
    passwordReady: false,
    mustChangePassword: true,
    createdAt
  } }, 201);
}

async function resetUserPassword(context, db, id) {
  const { request } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const actor = await requireUser(request, db);
  requireManager(actor);
  if (!UUID_PATTERN.test(id)) throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan.');
  const target = await db.prepare("SELECT id, email, role, is_active FROM users WHERE id = ? LIMIT 1").bind(id).first();
  if (!target || target.role !== 'user' || !target.is_active) throw new ApiError(404, 'user_not_found', 'Pengguna aktif tidak ditemukan.');
  const body = await readJson(request);
  const encoded = await hashClientCredential(body.credential, target.email, context.env);
  const updatedAt = nowIso();
  const result = await db.batch([
    db.prepare(`
      UPDATE users
      SET password_hash = ?, must_change_password = 1, updated_at = ?, updated_by = ?
      WHERE id = ? AND role = 'user' AND is_active = 1
    `).bind(encoded, updatedAt, actor.id, id),
    db.prepare(`
      DELETE FROM sessions
      WHERE user_id = (SELECT id FROM users WHERE id = ? AND role = 'user' AND is_active = 1)
    `).bind(id)
  ]);
  if (!resultChanges(result[0])) throw new ApiError(404, 'user_not_found', 'Pengguna aktif tidak ditemukan.');
  return jsonResponse({ ok: true, mustChangePassword: true, message: 'Password disimpan; sampaikan kepada pengguna melalui saluran yang disetujui.' });
}

async function deactivateUser(context, db, id) {
  const { request } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const actor = await requireUser(request, db);
  requireManager(actor);
  if (!UUID_PATTERN.test(id)) throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan.');
  if (id === actor.id) throw new ApiError(403, 'self_deactivation_forbidden', 'Manager tidak dapat menonaktifkan akunnya sendiri.');
  const updatedAt = nowIso();
  const result = await db.batch([
    db.prepare(`
      UPDATE users SET is_active = 0, updated_at = ?, updated_by = ?
      WHERE id = ? AND role = 'user' AND is_active = 1
    `).bind(updatedAt, actor.id, id),
    db.prepare(`
      DELETE FROM sessions
      WHERE user_id = (SELECT id FROM users WHERE id = ? AND role = 'user' AND is_active = 0)
    `).bind(id)
  ]);
  if (!resultChanges(result[0])) throw new ApiError(404, 'user_not_found', 'Pengguna aktif tidak ditemukan.');
  return jsonResponse({ ok: true, message: 'Akses dinonaktifkan. Riwayat laporan tetap tersimpan.' });
}

async function changeOwnPassword(context, db) {
  const { request } = context;
  ensureMethod(request, 'POST');
  ensureSameOrigin(request);
  const actor = await requireUser(request, db, { allowPasswordChange: true });
  const body = await readJson(request);
  const currentCredential = body.currentCredential;
  const newCredential = body.newCredential;
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1 LIMIT 1').bind(actor.id).first();
  if (!row?.password_hash || !await verifyClientCredential(currentCredential, row.password_hash, actor.email, context.env)) {
    throw new ApiError(401, 'current_password_incorrect', 'Password saat ini tidak sesuai.');
  }
  const encoded = await hashClientCredential(newCredential, actor.email, context.env);
  const currentParts = String(row.password_hash).split('$');
  if (currentParts.length !== 4 || newCredential?.salt === currentParts[2]) throw new ApiError(400, 'password_salt_reused', 'Gunakan salt baru untuk password baru.');
  if (typeof body.newCurrentDerived !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(body.newCurrentDerived)) {
    throw new ApiError(400, 'invalid_credential', 'Bukti password baru tidak valid.');
  }
  if (await verifyClientCredential({ ...newCredential, salt: currentParts[2], derived: body.newCurrentDerived }, row.password_hash, actor.email, context.env)) throw new ApiError(400, 'password_unchanged', 'Gunakan password baru yang berbeda.');
  const updatedAt = nowIso();
  const result = await db.prepare(`
    UPDATE users
    SET password_hash = ?, must_change_password = 0, updated_at = ?, updated_by = ?
    WHERE id = ? AND password_hash = ? AND is_active = 1
  `).bind(encoded, updatedAt, actor.id, actor.id, row.password_hash).run();
  if (!resultChanges(result)) throw new ApiError(409, 'password_changed_elsewhere', 'Password berubah di sesi lain. Masuk kembali.');
  const token = readSessionToken(request);
  if (token) {
    const currentSessionHash = await sha256Hex(token);
    await db.prepare('DELETE FROM sessions WHERE user_id = ? AND session_hash <> ?').bind(actor.id, currentSessionHash).run();
  }
  return jsonResponse({ ok: true, user: { ...safeUser(actor), mustChangePassword: false } });
}

async function logout(context, db) {
  ensureMethod(context.request, 'POST');
  ensureSameOrigin(context.request);
  await deleteCurrentSession(context.request, db);
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': '__Host-pangsuma_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
}

async function* fullExportCsv(db, snapshotAt) {
  yield csvHeader();
  let submissionCursor = null;
  while (true) {
    const filters = ['s.created_at <= ?'];
    const params = [snapshotAt];
    if (submissionCursor) {
      filters.push('(s.created_at < ? OR (s.created_at = ? AND s.id < ?))');
      params.push(submissionCursor.createdAt, submissionCursor.createdAt, submissionCursor.id);
    }
    const result = await db.prepare(`
      SELECT s.id, s.type, s.status, s.amount_idr, s.date, s.description, s.note,
             s.decision_reason, s.created_at, s.created_by,
             creator.name AS created_by_name, creator.position AS created_by_position
      FROM submissions s
      JOIN users creator ON creator.id = s.created_by
      WHERE ${filters.join(' AND ')}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ${EXPORT_PAGE_SIZE}
    `).bind(...params).all();
    const rows = result.results || [];
    for (const row of rows) yield csvLine([
      'Pengajuan', row.id, row.created_at, row.date, row.type, row.status, row.amount_idr,
      row.created_by_name, row.created_by_position, row.description, row.note,
      row.decision_reason, '', '', '', '', '', '', ''
    ]);
    if (rows.length < EXPORT_PAGE_SIZE) break;
    const last = rows[rows.length - 1];
    submissionCursor = { createdAt: last.created_at, id: last.id };
  }

  let ledgerCursor = null;
  while (true) {
    const result = await db.prepare(`
      SELECT l.id, l.event_type, l.direction, l.amount_idr, l.balance_after_idr,
             l.submission_id, l.note, l.created_at, u.name AS actor_name
      FROM cash_ledger l
      LEFT JOIN users u ON u.id = l.actor_id
      WHERE l.created_at <= ? ${ledgerCursor ? 'AND l.id < ?' : ''}
      ORDER BY l.id DESC
      LIMIT ${EXPORT_PAGE_SIZE}
    `).bind(...(ledgerCursor ? [snapshotAt, ledgerCursor] : [snapshotAt])).all();
    const rows = result.results || [];
    for (const row of rows) yield csvLine([
      'Ledger', row.id, row.created_at, '', row.event_type, '', row.amount_idr,
      '', '', '', row.note, '', row.actor_name, row.direction, row.balance_after_idr,
      '', 'submission', row.submission_id || '', ''
    ]);
    if (rows.length < EXPORT_PAGE_SIZE) break;
    ledgerCursor = Number(rows[rows.length - 1].id);
  }

  let auditCursor = null;
  while (true) {
    const result = await db.prepare(`
      SELECT a.id, a.action, a.entity_type, a.entity_id, a.details_json, a.created_at,
             COALESCE(u.name, 'Sistem') AS actor_name
      FROM audit_events a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.created_at <= ? ${auditCursor ? 'AND a.id < ?' : ''}
      ORDER BY a.id DESC
      LIMIT ${EXPORT_PAGE_SIZE}
    `).bind(...(auditCursor ? [snapshotAt, auditCursor] : [snapshotAt])).all();
    const rows = result.results || [];
    for (const row of rows) yield csvLine([
      'Audit', row.id, row.created_at, '', '', '', '', '', '', '', '', '',
      row.actor_name, '', '', row.action, row.entity_type, row.entity_id, row.details_json
    ]);
    if (rows.length < EXPORT_PAGE_SIZE) break;
    auditCursor = Number(rows[rows.length - 1].id);
  }
}

async function exportCsv(context, db) {
  ensureMethod(context.request, 'GET');
  const user = await requireUser(context.request, db);
  requireManager(user);
  const snapshotAt = nowIso();
  const iterator = fullExportCsv(db, snapshotAt);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    }
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="pangsuma-rekap-lengkap-${jakartaToday()}.csv"`,
      'Cache-Control': 'no-store, max-age=0',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

// Read every page rather than exporting only the dashboard's first 100 rows.
async function fullFinancialReportData(db, snapshotAt, filters = parseReportFilters()) {
  const submissions = [], ledger = [], audits = [];
  const submissionFilter = buildSubmissionFilterSql(filters);
  const hasSpecific = hasSubmissionSpecificFilter(filters);
  let cursor = null;
  while (true) {
    const rows = (await db.prepare(`
      SELECT s.*, creator.name AS created_by_name, creator.position AS created_by_position,
             creator.role AS created_by_role, resolver.name AS resolved_by_name
      FROM submissions s
      JOIN users creator ON creator.id = s.created_by
      LEFT JOIN users resolver ON resolver.id = s.resolved_by
      WHERE s.created_at <= ? AND ${submissionFilter.where} ${cursor ? 'AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))' : ''}
      ORDER BY s.created_at DESC, s.id DESC LIMIT ${EXPORT_PAGE_SIZE}
    `).bind(...(cursor ? [snapshotAt, ...submissionFilter.params, cursor.created_at, cursor.created_at, cursor.id] : [snapshotAt, ...submissionFilter.params])).all()).results || [];
    submissions.push(...rows);
    if (rows.length < EXPORT_PAGE_SIZE) break;
    cursor = rows[rows.length - 1];
  }
  cursor = null;
  const ledgerWhere = ['l.created_at <= ?'];
  const ledgerParams = [snapshotAt];
  if (filters.startDate) { ledgerWhere.push('l.created_at >= ?'); ledgerParams.push(wibBoundary(filters.startDate)); }
  if (filters.endDate) { ledgerWhere.push('l.created_at < ?'); ledgerParams.push(wibBoundary(filters.endDate, true)); }
  if (hasSpecific) {
    ledgerWhere.push('l.submission_id IS NOT NULL AND s.id IS NOT NULL', submissionFilter.where);
    ledgerParams.push(...submissionFilter.params);
  }
  while (true) {
    const rows = (await db.prepare(`
      SELECT l.*, u.name AS actor_name, s.description AS description, s.date AS submission_date,
             creator.name AS created_by_name
      FROM cash_ledger l
      LEFT JOIN users u ON u.id = l.actor_id
      LEFT JOIN submissions s ON s.id = l.submission_id
      LEFT JOIN users creator ON creator.id = s.created_by
      WHERE ${ledgerWhere.join(' AND ')} ${cursor ? 'AND l.id < ?' : ''}
      ORDER BY l.id DESC LIMIT ${EXPORT_PAGE_SIZE}
    `).bind(...(cursor ? [...ledgerParams, cursor.id] : ledgerParams)).all()).results || [];
    ledger.push(...rows);
    if (rows.length < EXPORT_PAGE_SIZE) break;
    cursor = rows[rows.length - 1];
  }
  let openingBalanceIdr = null, closingBalanceIdr = null;
  if (filters.startDate) {
    const before = await db.prepare(`SELECT balance_after_idr FROM cash_ledger WHERE created_at < ? AND created_at <= ? ORDER BY id DESC LIMIT 1`).bind(wibBoundary(filters.startDate), snapshotAt).first();
    openingBalanceIdr = before?.balance_after_idr ?? 0;
  } else if (hasSpecific) {
    const initial = await db.prepare(`SELECT balance_after_idr FROM cash_ledger WHERE event_type = 'opening_balance' AND amount_idr > 0 AND created_at <= ? ORDER BY id ASC LIMIT 1`).bind(snapshotAt).first();
    openingBalanceIdr = initial?.balance_after_idr ?? 0;
  }
  if (filters.startDate || hasSpecific) {
    const latest = await db.prepare(`SELECT balance_after_idr FROM cash_ledger WHERE created_at <= ? ${filters.endDate ? 'AND created_at < ?' : ''} ORDER BY id DESC LIMIT 1`).bind(...(filters.endDate ? [snapshotAt, wibBoundary(filters.endDate, true)] : [snapshotAt])).first();
    closingBalanceIdr = latest?.balance_after_idr ?? 0;
  }
  cursor = null;
  const auditWhere = ['a.created_at <= ?'];
  const auditParams = [snapshotAt];
  if (filters.startDate) { auditWhere.push('a.created_at >= ?'); auditParams.push(wibBoundary(filters.startDate)); }
  if (filters.endDate) { auditWhere.push('a.created_at < ?'); auditParams.push(wibBoundary(filters.endDate, true)); }
  if (hasSpecific) {
    auditWhere.push("a.entity_type = 'submission' AND s.id IS NOT NULL", submissionFilter.where);
    auditParams.push(...submissionFilter.params);
  }
  while (true) {
    const rows = (await db.prepare(`
      SELECT a.*, COALESCE(u.name, 'Sistem') AS actor_name
      FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
      LEFT JOIN submissions s ON a.entity_type = 'submission' AND s.id = a.entity_id
      LEFT JOIN users creator ON creator.id = s.created_by
      WHERE ${auditWhere.join(' AND ')} ${cursor ? 'AND a.id < ?' : ''}
      ORDER BY a.id DESC LIMIT ${EXPORT_PAGE_SIZE}
    `).bind(...(cursor ? [...auditParams, cursor.id] : auditParams)).all()).results || [];
    audits.push(...rows);
    if (rows.length < EXPORT_PAGE_SIZE) break;
    cursor = rows[rows.length - 1];
  }
  const orderedLedger = [...ledger].sort((a, b) => Number(a.id) - Number(b.id));
  return { submissions, ledger: orderedLedger, audits, filterDescription: reportFilterDescription(filters), periodLabel: reportPeriodLabel(filters), filtered: Boolean(filters.startDate || filters.type || filters.status || filters.applicant || filters.q), ledgerIsPartial: hasSpecific, openingBalanceIdr, closingBalanceIdr };
}
async function reports(context, db) {
  const user = await requireUser(context.request, db);
  requireManager(user);
  const { rows, ...metadata } = await getPaginatedReports(context, db, user);
  return jsonResponse({ ...metadata, items: rows.map(mapSubmission) });
}

async function exportPdf(context, db) {
  ensureMethod(context.request, 'GET');
  const user = await requireUser(context.request, db);
  requireManager(user);
  const snapshotAt = nowIso();
  const data = await fullFinancialReportData(db, snapshotAt, parseReportFilters(new URL(context.request.url).searchParams));
  const bytes = await buildFinancialReport({ ...data, snapshotAt, managerName: user.name });
  return new Response(bytes, { headers: {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="pangsuma-laporan-keuangan-${jakartaToday()}.pdf"`,
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  } });
}
async function dispatch(context, db, path) {
  const { request } = context;
  // Fail closed before profile-dependent auth/account queries, including login.
  // Logout remains available even when a release is blocked on migration 0003.
  if (path !== '/logout') await ensureUserProfilesSchema(db);
  if (path.startsWith('/passkeys/')) return handlePasskeyApi(context, db, path);
  if (path === '/health') {
    ensureMethod(request, 'GET');
    const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users' LIMIT 1").first();
    if (!row) throw new ApiError(503, 'schema_not_ready', 'Skema data belum diterapkan.');
    return jsonResponse({ ok: true, service: 'pangsuma-api', database: 'ready' });
  }
  if (path === '/bootstrap') return bootstrap(context, db);
  if (path === '/password-parameters' || path === '/auth/password-parameters') return passwordParameters(context, db);
  if (path === '/login' || path === '/auth/login') return login(context, db);
  if (path === '/session') return session(context, db);
  if (path === '/logout') return logout(context, db);
  if (path === '/overview') return overview(context, db);
  if (path === '/cash/insights') return cashInsights(context, db);
  if (path === '/cash/opening-balance') return setOpeningBalance(context, db);
  if (path === '/cash/reconciliations') {
    const actor = await requireUser(request, db); requireManager(actor);
    if (request.method === 'GET') return getCashReconciliations(db, actor, new URL(request.url).searchParams);
    return createCashReconciliation(context, db, actor);
  }
  if (path === '/financial/settings' || path === '/financial/alerts') {
    const actor = await requireUser(request, db); requireManager(actor);
    if (path === '/financial/alerts') {
      ensureMethod(request, 'GET');
      return jsonResponse(await getFinancialAlerts({ request, cursor: new URL(request.url).searchParams.get('cursor') }, db, actor));
    }
    if (request.method === 'GET') return jsonResponse(await getFinancialSettings(context, db, actor));
    ensureMethod(request, 'PUT'); ensureSameOrigin(request);
    return jsonResponse(await updateFinancialSettings({ ...context, body: await readJson(request) }, db, actor));
  }
  if (path === '/submissions/duplicate-check') {
    ensureMethod(request, 'POST'); ensureSameOrigin(request);
    const actor = await requireUser(request, db);
    return jsonResponse(await findPotentialDuplicates({ ...context, body: await readJson(request) }, db, actor));
  }
  const receiptListMatch = path.match(/^\/submissions\/([^/]+)\/receipts$/);
  if (receiptListMatch) {
    const actor = await requireUser(request, db), id = decodeURIComponent(receiptListMatch[1]);
    if (request.method === 'GET') return listSubmissionReceipts(context, db, actor, id);
    ensureSameOrigin(request);
    return createSubmissionReceipt(context, db, actor, id);
  }
  const receiptMatch = path.match(/^\/receipts\/([^/]+)$/);
  if (receiptMatch) return getSubmissionReceipt(context, db, await requireUser(request, db), decodeURIComponent(receiptMatch[1]));
  if (path === '/cash/topups') {
    const actor = await requireUser(request, db);
    requireManager(actor);
    return createCashTopup(context, db, actor);
  }
  if (path === '/export.csv') return exportCsv(context, db);
  if (path === '/export.pdf') return exportPdf(context, db);
  if (path === '/reports') return reports(context, db);
  const historyMatch = path.match(/^\/history\/(submissions|cash-ledger|audit-events)$/);
  if (historyMatch) return historyPage(context, db, historyMatch[1]);
  if (path === '/submissions') {
    if (request.method === 'GET') return listSubmissions(context, db);
    if (request.method === 'POST') return createSubmission(context, db);
    throw new ApiError(405, 'method_not_allowed', 'Metode request tidak didukung.');
  }
  if (path === '/profile') return profile(context, db, null);
  if (path === '/users') return users(context, db);
  const profilePhotoMatch = path.match(/^\/users\/([^/]+)\/photo$/);
  if (profilePhotoMatch) return profilePhoto(context, db, decodeURIComponent(profilePhotoMatch[1]));
  const profileMatch = path.match(/^\/users\/([^/]+)\/profile$/);
  if (profileMatch) return profile(context, db, decodeURIComponent(profileMatch[1]));
  if (path === PASSWORD_PATH) return changeOwnPassword(context, db);
  const submissionMatch = path.match(/^\/submissions\/([^/]+)\/(approve|reject|send)$/);
  if (submissionMatch) {
    const id = decodeURIComponent(submissionMatch[1]);
    const action = submissionMatch[2];
    if (action === 'send') return markFinanceSent(context, db, id);
    return decideSubmission(context, db, id, action);
  }
  const activityMatch = path.match(/^\/submissions\/([^/]+)\/activity$/);
  if (activityMatch) {
    const actor = await requireUser(request, db);
    return getReportActivity(context, db, actor, decodeURIComponent(activityMatch[1]));
  }
  const userMatch = path.match(/^\/users\/([^/]+)\/(password|deactivate)$/);
  if (userMatch) {
    const id = decodeURIComponent(userMatch[1]);
    return userMatch[2] === 'password'
      ? resetUserPassword(context, db, id)
      : deactivateUser(context, db, id);
  }
  throw new ApiError(404, 'not_found', 'Endpoint tidak ditemukan.');
}

export async function onRequest(context) {
  const requestId = crypto.randomUUID();
  try {
    const db = requireDatabase(context.env);
    return await dispatch(context, db, apiPath(context.request));
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error('Pangsuma API failure', requestId, error?.name || 'Error');
    return jsonResponse({ error: { code: 'internal_error', message: 'Layanan mengalami kendala. Coba lagi.' }, requestId }, 500);
  }
}
