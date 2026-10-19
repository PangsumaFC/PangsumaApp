import { ApiError, isValidIsoDate } from './http.js';

const TYPES = new Set(['petty_cash', 'finance_request']);
const STATUSES = new Set(['pending', 'approved', 'rejected', 'sent']);
const PERIODS = new Set(['mingguini', 'bulanini', 'customWIB']);

function jakartaDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}
function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function valueOf(params, ...keys) {
  for (const key of keys) if (params.has(key)) return params.get(key);
  return '';
}
const STATUS_ALIASES = new Map([
  ['pending', 'pending'], ['approved', 'approved'], ['rejected', 'rejected'], ['sent', 'sent'],
  ['menunggu manager', 'pending'],
  ['menunggu', 'pending'], ['disetujui', 'approved'], ['ditolak', 'rejected'],
  ['terkirim', 'sent'], ['terkirim ke finance', 'sent']
]);
function one(value, name, allowed) {
  if (!value) return '';
  const result = String(value).trim();
  const normalized = name === 'status' ? (STATUS_ALIASES.get(result.toLowerCase()) || result) : result;
  if (!allowed.has(normalized)) throw new ApiError(400, `invalid_${name}`, `${name} filter tidak valid.`);
  return normalized;
}
function escapedLike(value) {
  return String(value).replace(/[\\%_]/g, ch => `\\${ch}`);
}

/** Validate URL query filters. Submission date boundaries are ISO calendar dates in WIB. */
export function parseReportFilters(input = new URLSearchParams(), now = new Date()) {
  const params = input instanceof URLSearchParams ? input : new URLSearchParams(input);
  const periodRaw = valueOf(params, 'periode', 'period').trim();
  const period = periodRaw || '';
  if (period && !PERIODS.has(period)) throw new ApiError(400, 'invalid_period', 'Periode harus mingguini, bulanini, atau customWIB.');
  const today = jakartaDate(now);
  let startDate = valueOf(params, 'start', 'startDate', 'dari').trim();
  let endDate = valueOf(params, 'end', 'endDate', 'sampai').trim();
  const exactDate = valueOf(params, 'date').trim();
  if (exactDate) { startDate = exactDate; endDate = exactDate; }
  if (period === 'mingguini') {
    const day = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    startDate = shiftDate(today, -(day === 0 ? 6 : day - 1));
    endDate = today;
  } else if (period === 'bulanini') {
    startDate = `${today.slice(0, 8)}01`;
    endDate = today;
  }
  if ((startDate && !isValidIsoDate(startDate)) || (endDate && !isValidIsoDate(endDate))) {
    throw new ApiError(400, 'invalid_date_range', 'Tanggal filter harus YYYY-MM-DD yang valid.');
  }
  if ((startDate && !endDate) || (!startDate && endDate) || (startDate && endDate && startDate > endDate)) {
    throw new ApiError(400, 'invalid_date_range', 'Rentang tanggal WIB tidak valid.');
  }
  if (period === 'customWIB' && (!startDate || !endDate)) throw new ApiError(400, 'invalid_date_range', 'customWIB memerlukan start dan end.');
  const q = valueOf(params, 'q', 'search').trim();
  if (q.length > 120) throw new ApiError(400, 'invalid_search', 'Pencarian maksimal 120 karakter.');
  const applicant = valueOf(params, 'pengaju', 'applicant', 'createdBy').trim();
  if (applicant.length > 120) throw new ApiError(400, 'invalid_applicant', 'Pengaju maksimal 120 karakter.');
  const type = one(valueOf(params, 'jenis', 'type', 'kind'), 'type', TYPES);
  const status = one(valueOf(params, 'status'), 'status', STATUSES);
  return { period, startDate, endDate, q, applicant, type, status };
}

/** Build a parameterized WHERE fragment. `s` and `creator` are the report query aliases. */
export function buildSubmissionFilterSql(filters, { alias = 's', creatorAlias = 'creator' } = {}) {
  const f = filters || {};
  const clauses = [];
  const params = [];
  if (f.startDate) { clauses.push(`${alias}.date >= ?`); params.push(f.startDate); }
  if (f.endDate) { clauses.push(`${alias}.date <= ?`); params.push(f.endDate); }
  if (f.type) { clauses.push(`${alias}.type = ?`); params.push(f.type); }
  if (f.status) { clauses.push(`${alias}.status = ?`); params.push(f.status); }
  if (f.applicant) {
    const like = `%${escapedLike(f.applicant)}%`;
    clauses.push(`(${alias}.created_by = ? OR ${creatorAlias}.name LIKE ? ESCAPE '\\' OR ${creatorAlias}.email LIKE ? ESCAPE '\\')`);
    params.push(f.applicant, like, like);
  }
  if (f.q) {
    const localizedStatus = STATUS_ALIASES.get(String(f.q).trim().toLowerCase());
    if (localizedStatus) { clauses.push(`${alias}.status = ?`); params.push(localizedStatus); }
    else {
      const like = `%${escapedLike(f.q)}%`;
      clauses.push(`(${alias}.description LIKE ? ESCAPE '\\' OR ${alias}.note LIKE ? ESCAPE '\\' OR ${creatorAlias}.name LIKE ? ESCAPE '\\' OR ${alias}.date LIKE ? ESCAPE '\\' OR ${alias}.request_number LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like, like);
    }
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', clauses, params };
}

export function hasSubmissionSpecificFilter(filters) {
  return Boolean(filters?.q || filters?.type || filters?.status || filters?.applicant);
}

export function reportPeriodLabel(filters) {
  if (!filters?.startDate || !filters?.endDate) return 'Seluruh periode';
  return `Periode ${filters.startDate} – ${filters.endDate} WIB`;
}

export function reportFilterDescription(filters) {
  const bits = [];
  if (filters?.period === 'mingguini') bits.push('minggu ini');
  else if (filters?.period === 'bulanini') bits.push('bulan ini');
  else if (filters?.startDate) bits.push(`${filters.startDate} s/d ${filters.endDate} WIB`);
  if (filters?.type) bits.push(filters.type === 'petty_cash' ? 'Petty Cash' : 'Request Finance');
  if (filters?.status) bits.push(`status ${{ pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak', sent: 'Terkirim ke Finance' }[filters.status] || filters.status}`);
  if (filters?.applicant) bits.push(`pengaju ${filters.applicant}`);
  if (filters?.q) bits.push(`pencarian “${filters.q}”`);
  return bits.length ? bits.join(' · ') : 'Semua pengajuan';
}

export { escapedLike, jakartaDate };
