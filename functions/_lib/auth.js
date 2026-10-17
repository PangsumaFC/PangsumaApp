import { ApiError } from './http.js';

const SESSION_COOKIE = '__Host-pangsuma_session';
const SESSION_SECONDS = 8 * 60 * 60;
const PASSWORD_ITERATIONS = 600_000;
const DUMMY_PASSWORD_HASH = 'pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA==$LMUZSESsDz33KnZ5XGvE2LpyryhpJCz1vaubd9jC+b8=';

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  const size = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < size; index += 1) {
    diff |= (a[index] || 0) ^ (b[index] || 0);
  }
  return diff === 0;
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function derivePassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  ));
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new ApiError(400, 'password_policy', 'Password harus berisi 12–128 karakter.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

export async function verifyPassword(password, encodedHash) {
  const source = typeof encodedHash === 'string' ? encodedHash : DUMMY_PASSWORD_HASH;
  const [algorithm, rawIterations, rawSalt, rawExpected] = source.split('$');
  const parsedIterations = Number(rawIterations);
  const safeHash = algorithm === 'pbkdf2-sha256'
    && Number.isInteger(parsedIterations)
    && parsedIterations >= 100_000
    && parsedIterations <= 900_000
    && rawSalt
    && rawExpected;
  const selected = safeHash ? source : DUMMY_PASSWORD_HASH;
  const [selectedAlgorithm, selectedIterations, selectedSalt, selectedExpected] = selected.split('$');
  let matches = false;
  try {
    const derived = await derivePassword(String(password || ''), base64ToBytes(selectedSalt), Number(selectedIterations));
    const expected = selectedExpected === 'DUMMY_HASH_REPLACE'
      ? new Uint8Array(32)
      : base64ToBytes(selectedExpected);
    matches = constantTimeEqual(bytesToBase64(derived), bytesToBase64(expected));
  } catch {
    matches = false;
  }
  return Boolean(safeHash && selectedAlgorithm === 'pbkdf2-sha256' && matches);
}

export function readSessionToken(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name === SESSION_COOKIE) return valueParts.join('=') || '';
  }
  return '';
}

function cookieHeader(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return cookieHeader('', 0);
}

export async function createSession(db, userId, now = new Date()) {
  const token = randomToken();
  const sessionHash = await sha256Hex(token);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString();
  await db.prepare(
    'INSERT INTO sessions (session_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(sessionHash, userId, createdAt, expiresAt).run();
  return { token, expiresAt, cookie: cookieHeader(token, SESSION_SECONDS) };
}

export async function getSessionUser(request, db, now = new Date()) {
  const token = readSessionToken(request);
  if (!token || token.length > 128) return null;
  const sessionHash = await sha256Hex(token);
  const row = await db.prepare(`
    SELECT u.id, u.name, u.email, u.position, u.role, u.must_change_password,
           s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.session_hash = ? AND s.expires_at > ? AND u.is_active = 1
    LIMIT 1
  `).bind(sessionHash, now.toISOString()).first();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    position: row.position,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
    expiresAt: row.expires_at
  };
}

export async function deleteCurrentSession(request, db) {
  const token = readSessionToken(request);
  if (!token || token.length > 128) return;
  const sessionHash = await sha256Hex(token);
  await db.prepare('DELETE FROM sessions WHERE session_hash = ?').bind(sessionHash).run();
}

export function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    position: user.position,
    role: user.role,
    mustChangePassword: Boolean(user.mustChangePassword)
  };
}

export function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length < 32) return false;
  return constantTimeEqual(provided, expected);
}

export const SESSION_SECONDS_FOR_TESTS = SESSION_SECONDS;
