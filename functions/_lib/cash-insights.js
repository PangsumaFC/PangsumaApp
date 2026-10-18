import { ApiError } from './http.js';

const MAX_PAGE = 500;

export function toBigIntAmount(value) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined || value === '') return 0n;
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new Error('invalid_integer_amount');
  return BigInt(text);
}

export function formatInteger(value) { return toBigIntAmount(value).toString(); }

export function wibDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid_date');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function shiftWibDate(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function cashTrendWindow(today = wibDate(new Date())) {
  const end = today;
  const start = shiftWibDate(end, -29);
  const previousEnd = shiftWibDate(end, -30);
  const previousStart = shiftWibDate(end, -59);
  return { start, end, previousStart, previousEnd, timezone: 'Asia/Jakarta' };
}

function envMinimum(env) {
  const raw = env?.CASH_MINIMUM_IDR;
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+$/.test(String(raw))) return null;
  const value = BigInt(raw);
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? value.toString() : null;
}

async function readAllLedger(db, ledgerAnchorId) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const predicates = ['id <= ?'];
    const params = [ledgerAnchorId];
    if (cursor !== null) { predicates.push('id < ?'); params.push(cursor); }
    const result = await db.prepare(`
      SELECT id, event_type, direction, CAST(amount_idr AS TEXT) AS amount_idr,
             CAST(balance_after_idr AS TEXT) AS balance_after_idr, created_at
      FROM cash_ledger
      WHERE ${predicates.join(' AND ')}
      ORDER BY id DESC LIMIT ${MAX_PAGE}
    `).bind(...params).all();
    const page = result.results || [];
    rows.push(...page);
    if (page.length < MAX_PAGE) break;
    cursor = page[page.length - 1].id;
  }
  return rows;
}

function add(map, key, amount) { map.set(key, (map.get(key) || 0n) + toBigIntAmount(amount)); }

function daysBetween(start, end) {
  const result = [];
  for (let day = start; day <= end; day = shiftWibDate(day, 1)) result.push(day);
  return result;
}

export async function getCashInsights(db, env = {}, options = {}) {
  const today = options.today || wibDate(new Date());
  const window = cashTrendWindow(today);
  let snapshotAt = options.snapshotAt || new Date().toISOString();
  // A requested future analysis date is only used by deterministic fixtures; never
  // move a live snapshot backwards, but include the requested day when it is
  // ahead of the current clock so historical-window tests remain reproducible.
  if (!options.snapshotAt && options.today) {
    const requestedEnd = new Date(`${options.today}T23:59:59.999+07:00`).toISOString();
    if (requestedEnd > snapshotAt) snapshotAt = requestedEnd;
  }
  // Establish one immutable boundary: the account value and ledger high-water mark
  // come from the same SQLite statement. Ledger IDs are append-only and monotonic,
  // so paging by this anchor cannot mix a later balance with an earlier ledger.
  const anchor = await db.prepare(`
    SELECT CAST(COALESCE(ca.balance_idr, 0) AS TEXT) AS balance_idr,
           COALESCE((SELECT MAX(id) FROM cash_ledger), 0) AS ledger_high_water_id
    FROM cash_accounts ca WHERE ca.id = 'operational' LIMIT 1
  `).first();
  if (!anchor) throw new ApiError(503, 'operational_cash_unavailable', 'Akun kas operasional belum tersedia. Coba lagi setelah konfigurasi kas selesai.');
  const account = anchor;
  const ledger = await readAllLedger(db, Number(account.ledger_high_water_id || 0));
  const snapshotStable = true;
  const daily = new Map();
  const opening = { value: 0n };
  let topups = 0n;
  let outgoing = 0n;
  for (const row of [...ledger].reverse()) {
    const amount = toBigIntAmount(row.amount_idr);
    if (row.direction === 'debit') outgoing += amount;
    if (row.event_type === 'opening_balance' && amount > 0n) opening.value += amount;
    if (row.event_type !== 'opening_balance' && row.direction === 'credit') topups += amount;
    // Migration 0001 contains a zero opening placeholder; it is not a financial event.
    if (row.event_type === 'opening_balance' && amount === 0n) continue;
    const day = wibDate(row.created_at);
    const after = toBigIntAmount(row.balance_after_idr);
    const item = daily.get(day) || { incoming: 0n, outgoing: 0n, opening: after + (row.direction === 'debit' ? amount : -amount), closing: after, count: 0 };
    item.closing = after;
    item.count++;
    if (row.direction === 'credit') item.incoming += amount;
    if (row.direction === 'debit') item.outgoing += amount;
    daily.set(day, item);
  }
  const balance = toBigIntAmount(account?.balance_idr || 0);
  const expected = opening.value + topups - outgoing;
  const days = daysBetween(window.previousStart, window.end);
  const trend = days.map(day => ({ day, outgoingIdr: (daily.get(day)?.outgoing || 0n).toString() }));
  const current = trend.filter(row => row.day >= window.start && row.day <= window.end).reduce((sum, row) => sum + BigInt(row.outgoingIdr), 0n);
  const previous = trend.filter(row => row.day >= window.previousStart && row.day <= window.previousEnd).reduce((sum, row) => sum + BigInt(row.outgoingIdr), 0n);
  return {
    timezone: 'Asia/Jakarta',
    account: { balanceIdr: balance.toString() },
    totals: { openingIdr: opening.value.toString(), topupsIdr: topups.toString(), outgoingIdr: outgoing.toString() },
    snapshotAt, snapshotStable, ledgerAnchorId: Number(account.ledger_high_water_id || 0),
    accounting: snapshotStable
      ? { expectedBalanceIdr: expected.toString(), discrepancyIdr: (balance - expected).toString(), isBalanced: balance === expected }
      : { expectedBalanceIdr: null, discrepancyIdr: null, isBalanced: null },
    minimumIdr: envMinimum(env),
    daily: [...daily.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, value]) => ({ day, incomingIdr: value.incoming.toString(), outgoingIdr: value.outgoing.toString(), openingIdr: value.opening.toString(), closingIdr: value.closing.toString(), rowCount: value.count })),
    trend: { window, days: trend, outgoingIdr: current.toString(), precedingOutgoingIdr: previous.toString() }
  };
}

export const __test = { daysBetween, envMinimum };
