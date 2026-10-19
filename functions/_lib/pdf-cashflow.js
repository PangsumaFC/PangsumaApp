import { reportDisplayFields } from './pdf-demo-provenance.js';
// Report-only projection. Never changes submission state, ledger or balances.
export function isReportSubmission(row) {
  const type = String(row.type ?? '').toLowerCase();
  const status = String(row.status ?? '').toLowerCase();
  const managerAutoapproved = String(row.created_by_role ?? row.role ?? '').toLowerCase() === 'manager'
    && row.resolved_by == null && status === 'approved';
  if (!['petty_cash', 'finance_request'].includes(type)) return false;
  if (type === 'finance_request') return ['approved', 'sent'].includes(status);
  return ['approved', 'sent'].includes(status) || managerAutoapproved;
}
export function reportInteger(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  const n = Number(value);
  return BigInt(Number.isFinite(n) ? Math.round(n) : 0);
}
export function validateDropboxReceiptUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.port) return null;
    if (!['dropbox.com', 'www.dropbox.com'].includes(url.hostname.toLowerCase())) return null;
    const privatePath = /^\/(?:home|preview)(?:\/|$)/i.test(url.pathname);
    const sharedFilePath = /^\/scl\/fi\/[^/]+\/[^/]+$/i.test(url.pathname)
      || /^\/s\/[^/]+\/[^/]+$/i.test(url.pathname);
    if (!privatePath && !sharedFilePath) return null;
    if (/(?:^|[?&])(?:token|access_token|auth|authorization|code|secret|key|oauth)(?:=|&|$)/i.test(url.search)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
export function requestNumberOf(row) {
  const value = row?.request_number ?? row?.requestNumber;
  return typeof value === 'string' && /^(?:PC|RF)(?:0[1-9]|1[0-2])\d{4}(?!000000)\d{6}$/.test(value.trim()) ? value.trim() : null;
}

function creationTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
function canonicalRequestOrder(row) {
  const number = requestNumberOf(row);
  // IDs encode MM before YYYY: never compare the raw ID across years.
  return number ? `${number.slice(4, 8)}${number.slice(2, 4)}${number.slice(8)}` : null;
}
function compareStableText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareRequestCreation(a, b) {
  const aTime = creationTime(a.request_created_at);
  const bTime = creationTime(b.request_created_at);
  // Comparing instants is also chronological in WIB (a fixed UTC+07 offset).
  // Missing/invalid creation times never fall back to payment/report dates.
  if (aTime !== bTime) {
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return aTime - bTime;
  }
  const aNumber = canonicalRequestOrder(a);
  const bNumber = canonicalRequestOrder(b);
  if (aNumber !== bNumber) {
    if (aNumber === null) return 1;
    if (bNumber === null) return -1;
    return compareStableText(aNumber, bNumber);
  }
  return compareStableText(String(a.request_internal_id ?? ''), String(b.request_internal_id ?? ''));
}

function receiptUrls(row) {
  const array = Array.isArray(row?.dropbox_receipt_urls) ? row.dropbox_receipt_urls
    : Array.isArray(row?.report_attachment_urls) ? row.report_attachment_urls : null;
  const values = array || (row?.dropbox_receipt_url ? [row.dropbox_receipt_url] : []);
  const result = [];
  for (const value of values) {
    const url = validateDropboxReceiptUrl(value);
    if (url && !result.includes(url)) result.push(url);
    if (result.length >= 10) break;
  }
  return result;
}
export function unifiedReportRows({ submissions = [], ledger = [], reportType = 'petty_cash' } = {}) {
  const eligible = submissions.filter(isReportSubmission);
  const linkedById = new Map(submissions.map(row => [String(row.id), row]));
  const represented = new Set(ledger.filter(row => row.submission_id != null).map(row => String(row.submission_id)));
  const rows = ledger.map(row => {
    const linkedSubmission = linkedById.get(String(row.submission_id));
    // A submission's Keperluan is authoritative, including an empty value.
    // Unlinked cash entries retain their own transaction description.
    const description = linkedSubmission ? linkedSubmission.description
      : row.submission_id != null ? row.description
        : row.description || row.note
          || (row.event_type === 'opening_balance' ? 'Saldo awal kas' : row.event_type === 'cash_topup' ? 'Tambah kas' : row.event_type);
    // Notes are used only to validate the existing exact demo provenance rule.
    const note = linkedSubmission ? linkedSubmission.note : row.submission_note || row.note;
    const applicant = linkedSubmission ? linkedSubmission.created_by_name : row.created_by_name;
    const display = reportDisplayFields({ id: row.submission_id, topupId: row.topup_id, description, note, applicant });
    const ledgerReceipts = receiptUrls(row);
    const linkedReceipts = receiptUrls(linkedSubmission);
    const attachmentUrls = ledgerReceipts.length ? ledgerReceipts : linkedReceipts;
    const request_number = requestNumberOf(linkedSubmission) || requestNumberOf(row);
    return { ...row, request_number, report_key: `ledger-${row.id}`, report_at: row.created_at,
      ...(reportType === 'finance_request' ? { request_created_at: linkedSubmission?.created_at, request_internal_id: linkedSubmission?.id ?? row.submission_id ?? row.id } : {}),
      report_description: display.description || '',
      known_demo: display.knownDemo,
      is_cash: true,
      dropbox_receipt_urls: attachmentUrls, report_attachment_urls: attachmentUrls,
      dropbox_receipt_url: attachmentUrls[0] || null,
    };
  });
  for (const submission of eligible) {
    if (represented.has(String(submission.id))) continue;
    const display = reportDisplayFields({ id: submission.id, description: submission.description, note: submission.note, applicant: submission.created_by_name });
    rows.push({ request_number: requestNumberOf(submission), known_demo: display.knownDemo, report_key: `submission-${submission.id}`,
      report_at: submission.date ? `${submission.date}T00:00:00+07:00` : submission.created_at,
      ...(reportType === 'finance_request' ? { request_created_at: submission.created_at, request_internal_id: submission.id } : {}),
      report_description: display.description || '',
      is_cash: false, direction: '', amount_idr: 0, submission_amount_idr: submission.amount_idr ?? submission.amount ?? 0, balance_after_idr: null,
      dropbox_receipt_urls: receiptUrls(submission), report_attachment_urls: receiptUrls(submission),
      dropbox_receipt_url: receiptUrls(submission)[0] || null,
    });
  }
  const hasSimulation = rows.some(row => row.known_demo || /simulasi/i.test(row.report_description));
  // Unknown prose is never scrubbed by substring, including the word SIMULASI.
  // Only the identity + exact templates above permit PDF-only cleanup.
  rows.sort(reportType === 'finance_request' ? compareRequestCreation : (a, b) =>
    (new Date(a.report_at).getTime() - new Date(b.report_at).getTime())
    || (a.is_cash && b.is_cash ? Number(a.id) - Number(b.id) : a.report_key.localeCompare(b.report_key)));
  return { rows, hasSimulation, totalSubmitted: eligible.reduce((sum, row) => sum + reportInteger(row.amount_idr ?? row.amount), 0n), submissionCount: eligible.length };
}
