import { ApiError, ensureMethod, jsonResponse, readJson } from './http.js';
import { createSession, getSessionUser, safeUser, sha256Hex, secretMatches } from './auth.js';
import { MANAGER_EMAIL } from './roster.js';

const UTF8 = new TextEncoder();
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MANAGER_RECOVERY_TTL_MS = 15 * 60 * 1000;
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_WINDOW_MS = 60 * 1000;
const REQUEST_LIMIT = 30;
const REQUEST_BLOCK_MS = 5 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_IP_FAILURE_LIMIT = 20;
const LOGIN_ATTEMPT_MAX_ROWS = 20_000;
const MAX_CREDENTIALS = 50;
const PRODUCTION_ORIGIN = 'https://app.pangsumafc.com';
const PRODUCTION_RP_ID = 'app.pangsumafc.com';
const TEST_RP_ID = 'localhost';

class InvalidWebAuthn extends Error {}
const invalid = () => { throw new InvalidWebAuthn('invalid passkey data'); };

function failure(status = 401) {
  return new ApiError(status, 'passkey_verification_failed', 'Passkey tidak dapat diverifikasi. Silakan coba lagi.');
}

function configuration(env) {
  if (env.WEBAUTHN_PROFILE === 'test') {
    const origin = typeof env.WEBAUTHN_ORIGIN === 'string' ? env.WEBAUTHN_ORIGIN : '';
    let parsedOrigin;
    try { parsedOrigin = new URL(origin); } catch { parsedOrigin = null; }
    if (!parsedOrigin || parsedOrigin.protocol !== 'http:' || parsedOrigin.hostname !== 'localhost'
        || parsedOrigin.origin !== origin || parsedOrigin.port === '0' || env.WEBAUTHN_RP_ID !== TEST_RP_ID) {
      throw new ApiError(503, 'passkey_configuration_invalid', 'Konfigurasi passkey uji tidak valid.');
    }
    return { origin, rpId: TEST_RP_ID };
  }
  const origin = env.WEBAUTHN_ORIGIN || PRODUCTION_ORIGIN;
  const rpId = env.WEBAUTHN_RP_ID || PRODUCTION_RP_ID;
  if (origin !== PRODUCTION_ORIGIN || rpId !== PRODUCTION_RP_ID) {
    throw new ApiError(503, 'passkey_configuration_invalid', 'Konfigurasi passkey produksi tidak valid.');
  }
  return { origin: PRODUCTION_ORIGIN, rpId: PRODUCTION_RP_ID };
}

function requireEnabled(env) {
  if (env.PASSKEY_AUTH_ENABLED !== 'true') {
    throw new ApiError(404, 'not_found', 'Endpoint tidak ditemukan.');
  }
  return configuration(env);
}

function assertTrustedPost(request, env) {
  ensureMethod(request, 'POST');
  const { origin } = configuration(env);
  let requestOrigin = '';
  try { requestOrigin = new URL(request.url).origin; } catch { throw new ApiError(400, 'invalid_request', 'Pengajuan tidak valid.'); }
  if (request.headers.get('Origin') !== origin || requestOrigin !== origin) {
    throw new ApiError(403, 'origin_not_allowed', 'Asal permintaan tidak diizinkan.');
  }
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new ApiError(403, 'origin_not_allowed', 'Asal permintaan tidak diizinkan.');
  }
}

function base64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function unbase64url(value, maxBytes = 16_384) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes * 4 / 3) + 4
      || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) invalid();
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  let decoded;
  try { decoded = Uint8Array.from(atob(padded), character => character.charCodeAt(0)); } catch { invalid(); }
  if (decoded.length > maxBytes || base64url(decoded) !== value) invalid();
  return decoded;
}

function bytesToHex(bytes) {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/i.test(value)) invalid();
  return Uint8Array.from(value.match(/.{2}/g), byte => Number.parseInt(byte, 16));
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function concatBytes(left, right) {
  const result = new Uint8Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

function readCbor(bytes, start = 0, depth = 0) {
  if (!(bytes instanceof Uint8Array) || depth > 10 || start >= bytes.length) invalid();
  let offset = start;
  const initial = bytes[offset++];
  const major = initial >> 5;
  const additional = initial & 31;

  const readLength = () => {
    if (additional < 24) return additional;
    const count = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (!count || offset + count > bytes.length) invalid();
    let value = 0n;
    for (let index = 0; index < count; index += 1) value = (value << 8n) | BigInt(bytes[offset++]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return Number(value);
  };

  if (major === 0) return { value: readLength(), next: offset };
  if (major === 1) return { value: -1 - readLength(), next: offset };
  if (major === 2 || major === 3) {
    const length = readLength();
    if (length > 16_384 || offset + length > bytes.length) invalid();
    const data = bytes.subarray(offset, offset + length);
    let value = data;
    if (major === 3) {
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { invalid(); }
    }
    return { value, next: offset + length };
  }
  if (major === 4) {
    const length = readLength();
    if (length > 64) invalid();
    const value = [];
    for (let index = 0; index < length; index += 1) {
      const item = readCbor(bytes, offset, depth + 1);
      value.push(item.value);
      offset = item.next;
    }
    return { value, next: offset };
  }
  if (major === 5) {
    const length = readLength();
    if (length > 64) invalid();
    const value = new Map();
    for (let index = 0; index < length; index += 1) {
      const key = readCbor(bytes, offset, depth + 1);
      offset = key.next;
      if (value.has(key.value)) invalid();
      const item = readCbor(bytes, offset, depth + 1);
      offset = item.next;
      value.set(key.value, item.value);
    }
    return { value, next: offset };
  }
  if (major === 7 && additional === 20) return { value: false, next: offset };
  if (major === 7 && additional === 21) return { value: true, next: offset };
  if (major === 7 && additional === 22) return { value: null, next: offset };
  invalid();
}

export function parseAuthenticatorData(bytes, mode) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 37) invalid();
  const flags = bytes[32];
  const userPresence = (flags & 0x01) !== 0;
  const userVerification = (flags & 0x04) !== 0;
  const backupEligible = (flags & 0x08) !== 0;
  const backupState = (flags & 0x10) !== 0;
  const attestedCredentialData = (flags & 0x40) !== 0;
  const extensionsIncluded = (flags & 0x80) !== 0;
  const signCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(33, false);
  if ((flags & 0x22) !== 0 || !userPresence || !userVerification || (backupState && !backupEligible) || extensionsIncluded) invalid();
  if (mode === 'registration' ? !attestedCredentialData : attestedCredentialData) invalid();
  return {
    rpIdHash: bytes.subarray(0, 32),
    userPresence,
    userVerification,
    backupEligible,
    backupState,
    signCount
  };
}

export function isCounterAnomaly(previousCount, nextCount) {
  return (previousCount > 0 || nextCount > 0) && nextCount <= previousCount;
}

function parseClientData(raw, expectedChallenge, expectedType, config) {
  if (!(raw instanceof Uint8Array) || raw.length > 8_192) invalid();
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { invalid(); }
  if (!data || data.type !== expectedType || data.challenge !== expectedChallenge || data.origin !== config.origin) invalid();
  if (data.crossOrigin === true || Object.hasOwn(data, 'topOrigin')) invalid();
  return data;
}

async function validateRpIdHash(authData, config) {
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', UTF8.encode(config.rpId)));
  if (!constantTimeEqual(authData.rpIdHash, expected)) invalid();
}

function extractP256PublicKey(authDataBytes) {
  if (authDataBytes.length < 55) invalid();
  const view = new DataView(authDataBytes.buffer, authDataBytes.byteOffset, authDataBytes.byteLength);
  const credentialIdLength = view.getUint16(53, false);
  const credentialIdStart = 55;
  const coseStart = credentialIdStart + credentialIdLength;
  if (credentialIdLength < 1 || credentialIdLength > 1_023 || coseStart >= authDataBytes.length) invalid();
  const credentialId = authDataBytes.subarray(credentialIdStart, coseStart);
  const decoded = readCbor(authDataBytes, coseStart);
  if (decoded.next !== authDataBytes.length || !(decoded.value instanceof Map)) invalid();
  const cose = decoded.value;
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1
      || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) invalid();
  return {
    credentialId,
    jwk: { kty: 'EC', crv: 'P-256', x: base64url(x), y: base64url(y), ext: true, key_ops: ['verify'] }
  };
}

function derEcdsaToP1363(signature) {
  if (!(signature instanceof Uint8Array) || signature.length < 8 || signature.length > 80 || signature[0] !== 0x30) invalid();
  let offset = 1;
  const readLength = () => {
    if (offset >= signature.length) invalid();
    const first = signature[offset++];
    if (first < 0x80) return first;
    const count = first & 0x7f;
    if (count < 1 || count > 2 || offset + count > signature.length || signature[offset] === 0) invalid();
    let length = 0;
    for (let index = 0; index < count; index += 1) length = (length << 8) | signature[offset++];
    if (length < 0x80) invalid();
    return length;
  };
  if (readLength() !== signature.length - offset) invalid();
  const readInteger = () => {
    if (signature[offset++] !== 0x02) invalid();
    const length = readLength();
    if (length < 1 || length > 33 || offset + length > signature.length) invalid();
    let value = signature.subarray(offset, offset + length);
    offset += length;
    if ((value[0] & 0x80) !== 0) invalid();
    if (value.length > 1 && value[0] === 0) {
      if ((value[1] & 0x80) === 0) invalid();
      value = value.subarray(1);
    }
    if (value.length > 32 || value.every(byte => byte === 0)) invalid();
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const r = readInteger();
  const s = readInteger();
  if (offset !== signature.length) invalid();
  const result = new Uint8Array(64);
  result.set(r, 0);
  result.set(s, 32);
  return result;
}

function getClientAddress(request) {
  const address = (request.headers.get('CF-Connecting-IP') || '').trim().toLowerCase();
  return address && address.length <= 80 ? address : 'local-client';
}

async function rateKey(scope, identifier) {
  return sha256Hex(`${scope}\u0000${identifier}`);
}

async function touchRequestLimit(db, request, nowMs = Date.now()) {
  const key = await rateKey('passkey-request-ip', getClientAddress(request));
  const result = await db.prepare(`
    INSERT INTO passkey_request_limits (rate_key, request_count, window_started_ms, blocked_until_ms)
    VALUES (?, 1, ?, 0)
    ON CONFLICT(rate_key) DO UPDATE SET
      request_count = CASE
        WHEN excluded.window_started_ms - passkey_request_limits.window_started_ms >= ${REQUEST_WINDOW_MS} THEN 1
        WHEN passkey_request_limits.blocked_until_ms > excluded.window_started_ms THEN passkey_request_limits.request_count
        ELSE passkey_request_limits.request_count + 1
      END,
      window_started_ms = CASE
        WHEN excluded.window_started_ms - passkey_request_limits.window_started_ms >= ${REQUEST_WINDOW_MS} THEN excluded.window_started_ms
        ELSE passkey_request_limits.window_started_ms
      END,
      blocked_until_ms = CASE
        WHEN passkey_request_limits.blocked_until_ms > excluded.window_started_ms THEN passkey_request_limits.blocked_until_ms
        WHEN excluded.window_started_ms - passkey_request_limits.window_started_ms >= ${REQUEST_WINDOW_MS} THEN 0
        WHEN passkey_request_limits.request_count + 1 > ${REQUEST_LIMIT} THEN excluded.window_started_ms + ${REQUEST_BLOCK_MS}
        ELSE 0
      END
    RETURNING blocked_until_ms
  `).bind(key, nowMs).first();
  await db.prepare(`
    DELETE FROM passkey_request_limits
    WHERE window_started_ms < ?
       OR rate_key IN (
         SELECT rate_key FROM passkey_request_limits
         ORDER BY window_started_ms DESC, rate_key ASC
         LIMIT -1 OFFSET ${LOGIN_ATTEMPT_MAX_ROWS}
       )
  `).bind(nowMs - 24 * 60 * 60 * 1000).run();
  if (Number(result?.blocked_until_ms || 0) > nowMs) {
    throw new ApiError(429, 'passkey_rate_limited', 'Terlalu banyak percobaan. Coba lagi beberapa menit.');
  }
}

async function isFailureBlocked(db, key, nowMs) {
  const row = await db.prepare('SELECT blocked_until_ms FROM login_attempts WHERE rate_key = ? LIMIT 1').bind(key).first();
  return Number(row?.blocked_until_ms || 0) > nowMs;
}

function recordFailure(db, key, nowMs, limit) {
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
        WHEN login_attempts.blocked_until_ms > excluded.window_started_ms THEN login_attempts.blocked_until_ms
        WHEN (CASE
          WHEN excluded.window_started_ms - login_attempts.window_started_ms >= ${LOGIN_WINDOW_MS} THEN 1
          ELSE login_attempts.failure_count + 1
        END) >= ${limit} THEN excluded.window_started_ms + ${LOGIN_BLOCK_MS}
        ELSE 0
      END
  `).bind(key, nowMs);
}

async function recordPasskeyFailure(db, ipKey, credentialKey = '', accountKey = '') {
  const nowMs = Date.now();
  const statements = [recordFailure(db, ipKey, nowMs, LOGIN_IP_FAILURE_LIMIT)];
  if (credentialKey) statements.push(recordFailure(db, credentialKey, nowMs, LOGIN_FAILURE_LIMIT));
  if (accountKey) statements.push(recordFailure(db, accountKey, nowMs, LOGIN_FAILURE_LIMIT));
  statements.push(db.prepare(`
    DELETE FROM login_attempts
    WHERE (blocked_until_ms <= ? AND window_started_ms <= ?)
       OR rate_key IN (
         SELECT rate_key FROM login_attempts
         ORDER BY window_started_ms DESC,
                  CASE WHEN blocked_until_ms > ? THEN 1 ELSE 0 END DESC,
                  rate_key ASC
         LIMIT -1 OFFSET ${LOGIN_ATTEMPT_MAX_ROWS}
       )
  `).bind(nowMs, nowMs - LOGIN_WINDOW_MS, nowMs));
  await db.batch(statements);
}

function resultChanges(result) {
  return Number(result?.meta?.changes || 0);
}

async function audit(db, actorId, action, entityType, entityId, details = {}) {
  await db.prepare(`
    INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(actorId || null, action, entityType, entityId, JSON.stringify(details), new Date().toISOString()).run();
}

async function createChallenge(db, purpose, userId = null, contextId = null, nowMs = Date.now()) {
  const challengeId = base64url(randomBytes(18));
  const challenge = base64url(randomBytes(32));
  await db.prepare(`
    DELETE FROM passkey_challenges
    WHERE expires_at_ms <= ? OR consumed_at_ms <= ?
  `).bind(nowMs, nowMs - 24 * 60 * 60 * 1000).run();
  await db.prepare(`
    INSERT INTO passkey_challenges
      (challenge_id, challenge, purpose, user_id, context_id, created_at_ms, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(challengeId, challenge, purpose, userId, contextId, nowMs, nowMs + CHALLENGE_TTL_MS).run();
  return { challengeId, challenge };
}

async function consumeChallenge(db, challengeId, purpose, userId = null, nowMs = Date.now()) {
  if (typeof challengeId !== 'string' || challengeId.length > 64) invalid();
  const row = await db.prepare(`
    UPDATE passkey_challenges
    SET consumed_at_ms = ?
    WHERE challenge_id = ?
      AND purpose = ?
      AND user_id IS ?
      AND expires_at_ms > ?
      AND consumed_at_ms IS NULL
    RETURNING challenge, context_id
  `).bind(nowMs, challengeId, purpose, userId, nowMs).first();
  if (!row) invalid();
  return row;
}

async function ensureUserHandle(db, user) {
  let handle = user.webauthn_user_handle;
  if (!/^[a-f0-9]{32}$/i.test(String(handle || ''))) {
    handle = bytesToHex(randomBytes(16));
    await db.prepare('UPDATE users SET webauthn_user_handle = ? WHERE id = ? AND webauthn_user_handle IS NULL')
      .bind(handle, user.id).run();
    const refreshed = await db.prepare('SELECT webauthn_user_handle FROM users WHERE id = ? LIMIT 1').bind(user.id).first();
    handle = refreshed?.webauthn_user_handle || handle;
  }
  return { encoded: base64url(hexToBytes(handle)), bytes: hexToBytes(handle) };
}

async function excludedCredentials(db, userId) {
  const result = await db.prepare(`
    SELECT credential_id FROM passkey_credentials WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_CREDENTIALS}
  `).bind(userId).all();
  return (result.results || []).map(row => ({ type: 'public-key', id: row.credential_id, transports: ['internal', 'hybrid', 'usb', 'nfc', 'ble'] }));
}

async function registrationOptions(db, user, config, context) {
  const handle = await ensureUserHandle(db, user);
  const challenge = await createChallenge(db, context.purpose, user.id, context.contextId || null);
  return {
    challengeId: challenge.challengeId,
    publicKey: {
      challenge: challenge.challenge,
      rp: { id: config.rpId, name: 'Pangsuma App' },
      user: { id: handle.encoded, name: user.email, displayName: user.name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60_000,
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: await excludedCredentials(db, user.id)
    }
  };
}

async function parseRegistration(credential, challenge, config) {
  if (!credential || credential.type !== 'public-key' || typeof credential.id !== 'string') invalid();
  const rawId = unbase64url(credential.rawId, 1_024);
  if (rawId.length < 1 || credential.id !== credential.rawId || credential.id !== base64url(rawId)) invalid();
  const response = credential.response;
  if (!response || typeof response.clientDataJSON !== 'string' || typeof response.attestationObject !== 'string') invalid();
  const clientData = unbase64url(response.clientDataJSON, 8_192);
  parseClientData(clientData, challenge.challenge, 'webauthn.create', config);
  const attestationBytes = unbase64url(response.attestationObject, 12_288);
  const decoded = readCbor(attestationBytes);
  if (decoded.next !== attestationBytes.length || !(decoded.value instanceof Map) || decoded.value.size !== 3) invalid();
  const attestation = decoded.value;
  if (attestation.get('fmt') !== 'none' || !(attestation.get('attStmt') instanceof Map) || attestation.get('attStmt').size !== 0) invalid();
  const authDataBytes = attestation.get('authData');
  if (!(authDataBytes instanceof Uint8Array)) invalid();
  const authData = parseAuthenticatorData(authDataBytes, 'registration');
  await validateRpIdHash(authData, config);
  const publicKey = extractP256PublicKey(authDataBytes);
  if (!constantTimeEqual(rawId, publicKey.credentialId)) invalid();
  try {
    await crypto.subtle.importKey('jwk', publicKey.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch { invalid(); }
  return {
    credentialId: base64url(rawId),
    publicKeyJwk: JSON.stringify(publicKey.jwk),
    signCount: authData.signCount,
    backupEligible: authData.backupEligible ? 1 : 0,
    backupState: authData.backupState ? 1 : 0
  };
}

async function verifyAssertion(credential, challenge, config, db, options = {}) {
  if (!credential || credential.type !== 'public-key' || typeof credential.id !== 'string') invalid();
  const rawId = unbase64url(credential.rawId, 1_024);
  const credentialId = base64url(rawId);
  if (credential.id !== credential.rawId || credential.id !== credentialId) invalid();
  const row = await db.prepare(`
    SELECT c.credential_id, c.user_id, c.public_key_jwk, c.sign_count,
           c.backup_eligible, c.backup_state,
           u.id, u.name, u.email, u.position, u.role, u.must_change_password,
           u.webauthn_user_handle
    FROM passkey_credentials c
    JOIN users u ON u.id = c.user_id
    WHERE c.credential_id = ? AND u.is_active = 1
    LIMIT 1
  `).bind(credentialId).first();
  if (!row) invalid();
  if (options.userId && row.user_id !== options.userId) invalid();
  const response = credential.response;
  if (!response || typeof response.clientDataJSON !== 'string'
      || typeof response.authenticatorData !== 'string'
      || typeof response.signature !== 'string'
      || typeof response.userHandle !== 'string') invalid();
  const clientData = unbase64url(response.clientDataJSON, 8_192);
  parseClientData(clientData, challenge.challenge, 'webauthn.get', config);
  const authDataBytes = unbase64url(response.authenticatorData, 8_192);
  const authData = parseAuthenticatorData(authDataBytes, 'authentication');
  await validateRpIdHash(authData, config);
  const providedHandle = unbase64url(response.userHandle, 64);
  if (!constantTimeEqual(providedHandle, hexToBytes(row.webauthn_user_handle))) invalid();
  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey('jwk', JSON.parse(row.public_key_jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch { invalid(); }
  const signature = derEcdsaToP1363(unbase64url(response.signature, 1_024));
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData));
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, concatBytes(authDataBytes, clientDataHash));
  } catch { invalid(); }
  if (!signatureValid) invalid();
  if (authData.backupEligible !== Boolean(row.backup_eligible)) {
    await audit(db, row.user_id, 'passkey.security_rejected', 'passkey', await sha256Hex(credentialId), { reason: 'backup_eligibility_changed' });
    invalid();
  }
  if (isCounterAnomaly(Number(row.sign_count), authData.signCount)) {
    await audit(db, row.user_id, 'passkey.security_rejected', 'passkey', await sha256Hex(credentialId), { reason: 'signature_counter_anomaly' });
    invalid();
  }
  const updatedAt = new Date().toISOString();
  const updated = await db.prepare(`
    UPDATE passkey_credentials
    SET sign_count = ?, backup_state = ?, last_used_at = ?
    WHERE credential_id = ? AND sign_count = ? AND backup_eligible = ?
  `).bind(
    authData.signCount,
    authData.backupState ? 1 : 0,
    updatedAt,
    credentialId,
    Number(row.sign_count),
    Number(row.backup_eligible)
  ).run();
  if (resultChanges(updated) !== 1) invalid();
  return {
    id: row.user_id,
    name: row.name,
    email: row.email,
    position: row.position,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
    credentialId
  };
}

async function getManager(db, env) {
  const managerId = typeof env?.PASSKEY_MANAGER_ID === 'string' ? env.PASSKEY_MANAGER_ID.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(managerId)) return null;
  return db.prepare(`
    SELECT id, name, email, position, role, must_change_password, webauthn_user_handle
    FROM users
    WHERE id = ? AND email = ? COLLATE NOCASE AND role = 'manager' AND is_active = 1
    LIMIT 1
  `).bind(managerId, MANAGER_EMAIL).first();
}

async function requireManagerPasskey(request, db) {
  const user = await getSessionUser(request, db);
  if (!user) throw new ApiError(401, 'authentication_required', 'Sesi berakhir. Silakan masuk kembali.');
  if (user.role !== 'manager') throw new ApiError(403, 'manager_required', 'Aksi ini hanya tersedia untuk Manager.');
  if (user.authMethod !== 'passkey') throw new ApiError(403, 'passkey_required', 'Masuk dengan passkey Manager untuk mengelola undangan.');
  return user;
}

async function loginOptions(context, db, config) {
  const { request } = context;
  assertTrustedPost(request, context.env);
  await touchRequestLimit(db, request);
  const ipKey = await rateKey('passkey-login-ip', getClientAddress(request));
  if (await isFailureBlocked(db, ipKey, Date.now())) {
    throw new ApiError(429, 'passkey_rate_limited', 'Terlalu banyak percobaan. Coba lagi beberapa menit.');
  }
  await readJson(request, 4_000);
  const challenge = await createChallenge(db, 'discoverable-login');
  return jsonResponse({
    challengeId: challenge.challengeId,
    publicKey: {
      challenge: challenge.challenge,
      rpId: config.rpId,
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials: []
    }
  });
}

async function loginVerify(context, db, config) {
  const { request } = context;
  assertTrustedPost(request, context.env);
  const body = await readJson(request, 20_000);
  let credentialId = 'invalid-credential';
  try {
    if (typeof body.credential?.rawId === 'string') credentialId = base64url(unbase64url(body.credential.rawId, 1_024));
  } catch { credentialId = 'invalid-credential'; }
  const ipKey = await rateKey('passkey-login-ip', getClientAddress(request));
  const credentialKey = await rateKey('passkey-credential', credentialId);
  const nowMs = Date.now();
  if (await isFailureBlocked(db, ipKey, nowMs) || await isFailureBlocked(db, credentialKey, nowMs)) {
    throw new ApiError(429, 'passkey_rate_limited', 'Terlalu banyak percobaan. Coba lagi beberapa menit.');
  }
  let authenticated;
  try {
    const challenge = await consumeChallenge(db, body.challengeId, 'discoverable-login');
    authenticated = await verifyAssertion(body.credential, challenge, config, db);
  } catch (error) {
    if (error instanceof InvalidWebAuthn) {
      await recordPasskeyFailure(db, ipKey, credentialKey);
      throw failure();
    }
    throw error;
  }
  const accountKey = await rateKey('passkey-account', authenticated.id);
  await db.batch([
    db.prepare('DELETE FROM login_attempts WHERE rate_key IN (?, ?, ?)').bind(ipKey, credentialKey, accountKey),
    db.prepare(`
      INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, 'passkey.login', 'user', ?, '{"method":"discoverable"}', ?)
    `).bind(authenticated.id, authenticated.id, new Date().toISOString())
  ]);
  const session = await createSession(db, authenticated.id, { authMethod: 'passkey' });
  return jsonResponse({
    ok: true,
    user: safeUser({ ...authenticated, authMethod: 'passkey' }),
    expiresAt: session.expiresAt
  }, 200, { 'Set-Cookie': session.cookie });
}

async function invitationIssue(context, db) {
  const { request } = context;
  assertTrustedPost(request, context.env);
  const actor = await requireManagerPasskey(request, db);
  const body = await readJson(request, 4_000);
  const userId = typeof body.userId === 'string' ? body.userId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new ApiError(404, 'user_not_found', 'Pengguna aktif tidak ditemukan.');
  }
  const user = await db.prepare(`
    SELECT id, name, role, is_active FROM users WHERE id = ? LIMIT 1
  `).bind(userId).first();
  if (!user || user.role !== 'user' || !user.is_active) {
    throw new ApiError(404, 'user_not_found', 'Pengguna aktif tidak ditemukan.');
  }
  const token = base64url(randomBytes(32));
  const tokenHash = await sha256Hex(token);
  const invitationId = crypto.randomUUID();
  const nowMs = Date.now();
  const expiresAtMs = nowMs + INVITATION_TTL_MS;
  await db.batch([
    db.prepare(`
      UPDATE passkey_invitations
      SET revoked_at_ms = ?
      WHERE user_id = ? AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL
    `).bind(nowMs, userId),
    db.prepare(`
      INSERT INTO passkey_invitations
        (id, user_id, token_hash, created_by, created_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(invitationId, userId, tokenHash, actor.id, nowMs, expiresAtMs),
    db.prepare(`
      INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, 'passkey.invitation_issued', 'user', ?, ?, ?)
    `).bind(actor.id, userId, JSON.stringify({ invitationId, expiresAt: new Date(expiresAtMs).toISOString() }), new Date(nowMs).toISOString())
  ]);
  return jsonResponse({
    invitation: { token, expiresAt: new Date(expiresAtMs).toISOString() },
    user: { id: user.id, name: user.name }
  }, 201);
}

async function invitationOptions(context, db, config) {
  const { request } = context;
  assertTrustedPost(request, context.env);
  await touchRequestLimit(db, request);
  const body = await readJson(request, 4_000);
  const token = typeof body.invitationToken === 'string' && body.invitationToken.length <= 128 ? body.invitationToken : '';
  if (!token) throw failure();
  const tokenHash = await sha256Hex(token);
  const nowMs = Date.now();
  const invitation = await db.prepare(`
    SELECT i.id AS invitation_id, i.user_id, u.id, u.name, u.email, u.position, u.role,
           u.must_change_password, u.webauthn_user_handle
    FROM passkey_invitations i
    JOIN users u ON u.id = i.user_id
    WHERE i.token_hash = ? AND i.consumed_at_ms IS NULL AND i.revoked_at_ms IS NULL
      AND i.expires_at_ms > ? AND u.role = 'user' AND u.is_active = 1
    LIMIT 1
  `).bind(tokenHash, nowMs).first();
  if (!invitation) throw failure();
  const options = await registrationOptions(db, invitation, config, {
    purpose: 'manager-invitation',
    contextId: invitation.invitation_id
  });
  return jsonResponse(options);
}

async function insertInvitationCredential(db, user, invitationId, tokenHash, credential) {
  const nowMs = Date.now();
  const result = await db.prepare(`
    INSERT INTO passkey_credentials
      (credential_id, user_id, public_key_jwk, algorithm, sign_count,
       backup_eligible, backup_state, registration_method, registration_actor_id,
       invitation_id, created_at)
    SELECT ?, i.user_id, ?, -7, ?, ?, ?, 'manager-invitation', i.created_by, i.id, ?
    FROM passkey_invitations i
    JOIN users target ON target.id = i.user_id
    WHERE i.id = ? AND i.user_id = ? AND i.token_hash = ?
      AND i.consumed_at_ms IS NULL AND i.revoked_at_ms IS NULL AND i.expires_at_ms > ?
      AND target.role = 'user' AND target.is_active = 1
  `).bind(
    credential.credentialId,
    credential.publicKeyJwk,
    credential.signCount,
    credential.backupEligible,
    credential.backupState,
    new Date(nowMs).toISOString(),
    invitationId,
    user.id,
    tokenHash,
    nowMs
  ).run();
  if (resultChanges(result) !== 1) throw failure();
}

async function invitationVerify(context, db, config) {
  const { request } = context;
  assertTrustedPost(request, context.env);
  const body = await readJson(request, 20_000);
  const token = typeof body.invitationToken === 'string' && body.invitationToken.length <= 128 ? body.invitationToken : '';
  if (!token) throw failure();
  const tokenHash = await sha256Hex(token);
  const nowMs = Date.now();
  const invitation = await db.prepare(`
    SELECT i.id AS invitation_id, i.user_id, u.id, u.name, u.email, u.position,
           u.role, u.must_change_password, u.webauthn_user_handle
    FROM passkey_invitations i JOIN users u ON u.id = i.user_id
    WHERE i.token_hash = ? AND i.consumed_at_ms IS NULL AND i.revoked_at_ms IS NULL
      AND i.expires_at_ms > ? AND u.role = 'user' AND u.is_active = 1
    LIMIT 1
  `).bind(tokenHash, nowMs).first();
  if (!invitation) throw failure();
  let challenge;
  try {
    challenge = await consumeChallenge(db, body.challengeId, 'manager-invitation', invitation.user_id);
    if (challenge.context_id !== invitation.invitation_id) invalid();
  } catch (error) {
    if (error instanceof InvalidWebAuthn) throw failure();
    throw error;
  }
  let credential;
  try { credential = await parseRegistration(body.credential, challenge, config); } catch (error) {
    if (error instanceof InvalidWebAuthn) throw failure();
    throw error;
  }
  await insertInvitationCredential(db, invitation, invitation.invitation_id, tokenHash, credential);
  const session = await createSession(db, invitation.user_id, { authMethod: 'passkey' });
  const resultUser = {
    id: invitation.user_id,
    name: invitation.name,
    email: invitation.email,
    position: invitation.position,
    role: invitation.role,
    mustChangePassword: false,
    authMethod: 'passkey'
  };
  return jsonResponse({
    registered: true,
    user: safeUser(resultUser),
    expiresAt: session.expiresAt
  }, 201, { 'Set-Cookie': session.cookie });
}

async function managerRecoveryOptions(context, db, config) {
  const { request, env } = context;
  assertTrustedPost(request, env);
  await touchRequestLimit(db, request);
  const body = await readJson(request, 4_000);
  const secret = typeof body.secret === 'string' && body.secret.length <= 256 ? body.secret : '';
  if (!secretMatches(secret, env.MANAGER_ENROLLMENT_SECRET)) throw failure();
  const manager = await getManager(db, env);
  if (!manager) throw failure();
  const existing = await db.prepare('SELECT 1 AS present FROM passkey_credentials WHERE user_id = ? LIMIT 1').bind(manager.id).first();
  if (existing) throw failure();
  const secretHash = await sha256Hex(secret);
  const nowMs = Date.now();
  await db.prepare(`
    INSERT INTO passkey_manager_recovery (user_id, secret_hash, created_at_ms, expires_at_ms)
    SELECT ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM passkey_credentials WHERE user_id = ?)
    ON CONFLICT(user_id) DO UPDATE SET
      secret_hash = excluded.secret_hash,
      created_at_ms = MAX(excluded.created_at_ms, passkey_manager_recovery.created_at_ms + 1),
      expires_at_ms = excluded.expires_at_ms
    WHERE passkey_manager_recovery.consumed_at_ms IS NULL
      AND passkey_manager_recovery.expires_at_ms <= excluded.created_at_ms
      AND NOT EXISTS (SELECT 1 FROM passkey_credentials WHERE user_id = excluded.user_id)
  `).bind(manager.id, secretHash, nowMs, nowMs + MANAGER_RECOVERY_TTL_MS, manager.id).run();
  const recovery = await db.prepare(`
    SELECT secret_hash, created_at_ms, expires_at_ms, consumed_at_ms
    FROM passkey_manager_recovery WHERE user_id = ? LIMIT 1
  `).bind(manager.id).first();
  if (!recovery || !secretMatches(secretHash, recovery.secret_hash)
      || recovery.consumed_at_ms !== null || Number(recovery.expires_at_ms) <= nowMs) throw failure();
  const options = await registrationOptions(db, manager, config, {
    purpose: 'manager-recovery',
    contextId: `${manager.id}:${recovery.created_at_ms}`
  });
  return jsonResponse({ ...options, expiresAt: new Date(Number(recovery.expires_at_ms)).toISOString() });
}

async function managerRecoveryVerify(context, db, config) {
  const { request, env } = context;
  assertTrustedPost(request, env);
  const body = await readJson(request, 20_000);
  const secret = typeof body.secret === 'string' && body.secret.length <= 256 ? body.secret : '';
  if (!secretMatches(secret, env.MANAGER_ENROLLMENT_SECRET)) throw failure();
  const manager = await getManager(db, env);
  if (!manager) throw failure();
  const secretHash = await sha256Hex(secret);
  const nowMs = Date.now();
  const recovery = await db.prepare(`
    SELECT secret_hash, created_at_ms, expires_at_ms, consumed_at_ms
    FROM passkey_manager_recovery WHERE user_id = ? LIMIT 1
  `).bind(manager.id).first();
  if (!recovery || !secretMatches(secretHash, recovery.secret_hash)
      || recovery.consumed_at_ms !== null || Number(recovery.expires_at_ms) <= nowMs) throw failure();
  let challenge;
  try {
    challenge = await consumeChallenge(db, body.challengeId, 'manager-recovery', manager.id);
    if (challenge.context_id !== `${manager.id}:${recovery.created_at_ms}`) invalid();
  } catch (error) {
    if (error instanceof InvalidWebAuthn) throw failure();
    throw error;
  }
  let credential;
  try { credential = await parseRegistration(body.credential, challenge, config); } catch (error) {
    if (error instanceof InvalidWebAuthn) throw failure();
    throw error;
  }
  const inserted = await db.prepare(`
    INSERT INTO passkey_credentials
      (credential_id, user_id, public_key_jwk, algorithm, sign_count,
       backup_eligible, backup_state, registration_method, registration_actor_id,
       invitation_id, created_at)
    SELECT ?, manager.id, ?, -7, ?, ?, ?, 'manager-recovery', manager.id, NULL, ?
    FROM users manager
    JOIN passkey_manager_recovery recovery ON recovery.user_id = manager.id
    WHERE manager.id = ? AND manager.email = ? COLLATE NOCASE
      AND manager.role = 'manager' AND manager.is_active = 1
      AND recovery.secret_hash = ? AND recovery.expires_at_ms > ?
      AND recovery.created_at_ms = ?
      AND recovery.consumed_at_ms IS NULL
      AND NOT EXISTS (SELECT 1 FROM passkey_credentials WHERE user_id = manager.id)
    RETURNING credential_id
  `).bind(
    credential.credentialId,
    credential.publicKeyJwk,
    credential.signCount,
    credential.backupEligible,
    credential.backupState,
    new Date(nowMs).toISOString(),
    manager.id,
    MANAGER_EMAIL,
    secretHash,
    Date.now(),
    recovery.created_at_ms
  ).first();
  if (inserted?.credential_id !== credential.credentialId) throw failure();
  await audit(db, manager.id, 'passkey.manager_recovery_completed', 'user', manager.id, { method: 'one_time_enrollment' });
  return jsonResponse({ registered: true }, 201);
}

async function managerRegistrationOptions(context, db, config) {
  const { request } = context;
  assertTrustedPost(request, context.env);
  const manager = await requireManagerPasskey(request, db);
  await readJson(request, 4_000);
  return jsonResponse(await registrationOptions(db, manager, config, { purpose: 'manager-registration' }));
}

async function managerRegistrationVerify(context, db, config) {
  const { request } = context;
  assertTrustedPost(request, context.env);
  const body = await readJson(request, 20_000);
  const manager = await requireManagerPasskey(request, db);
  let challenge;
  try {
    challenge = await consumeChallenge(db, body.challengeId, 'manager-registration', manager.id);
  } catch (error) {
    if (error instanceof InvalidWebAuthn) throw failure();
    throw error;
  }
  let credential;
  try { credential = await parseRegistration(body.credential, challenge, config); } catch (error) {
    if (error instanceof InvalidWebAuthn) throw failure();
    throw error;
  }
  const result = await db.prepare(`
    INSERT INTO passkey_credentials
      (credential_id, user_id, public_key_jwk, algorithm, sign_count,
       backup_eligible, backup_state, registration_method, registration_actor_id,
       invitation_id, created_at)
    SELECT ?, u.id, ?, -7, ?, ?, ?, 'manager-self', u.id, NULL, ?
    FROM users u
    WHERE u.id = ? AND u.role = 'manager' AND u.is_active = 1
      AND EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.user_id = u.id AND s.auth_method = 'passkey' AND s.expires_at > ?
      )
  `).bind(
    credential.credentialId,
    credential.publicKeyJwk,
    credential.signCount,
    credential.backupEligible,
    credential.backupState,
    new Date().toISOString(),
    manager.id,
    new Date().toISOString()
  ).run();
  if (resultChanges(result) !== 1) throw failure();
  return jsonResponse({ registered: true });
}

export async function handlePasskeyApi(context, db, path) {
  const { request, env } = context;
  if (path === '/passkeys/status') {
    ensureMethod(request, 'GET');
    let enabled = env.PASSKEY_AUTH_ENABLED === 'true';
    if (enabled) {
      try { configuration(env); } catch { enabled = false; }
    }
    return jsonResponse({ enabled });
  }
  const config = requireEnabled(env);
  if (path === '/passkeys/login/options') return loginOptions(context, db, config);
  if (path === '/passkeys/login/verify') return loginVerify(context, db, config);
  // Manager-only rollout: deferred handlers stay unreachable, including with a valid session.
  if (path === '/passkeys/manager-recovery/options') return managerRecoveryOptions(context, db, config);
  if (path === '/passkeys/manager-recovery/verify') return managerRecoveryVerify(context, db, config);
  throw new ApiError(404, 'not_found', 'Endpoint tidak ditemukan.');
}
