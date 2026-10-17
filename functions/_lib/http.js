export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function apiError(status, code, message) {
  return new ApiError(status, code, message);
}

export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(JSON.stringify(payload), { status, headers });
}

export function ensureMethod(request, method) {
  if (request.method !== method) {
    throw new ApiError(405, 'method_not_allowed', 'Metode request tidak didukung.');
  }
}

export function ensureSameOrigin(request) {
  const origin = request.headers.get('Origin');
  let requestOrigin;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    throw new ApiError(400, 'invalid_request', 'Request tidak valid.');
  }
  if (!origin || origin !== requestOrigin) {
    throw new ApiError(403, 'origin_not_allowed', 'Asal request tidak diizinkan.');
  }
}

export async function readJson(request, maxBytes = 12_000) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'json_required', 'Kirim data dengan format JSON.');
  }
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > maxBytes) {
    throw new ApiError(413, 'payload_too_large', 'Data terlalu besar.');
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new ApiError(413, 'payload_too_large', 'Data terlalu besar.');
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, 'invalid_json', 'Isi request tidak dapat dibaca.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'invalid_json', 'Isi request tidak dapat dibaca.');
  }
  return parsed;
}

export function normalizedEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (email.length > 180 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function jakartaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const part = type => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return null;
  return text;
}
