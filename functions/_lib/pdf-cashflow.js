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
function nominal(value) {
  const n = reportInteger(value);
  return `${n < 0n ? '-' : ''}Rp${(n < 0n ? -n : n).toLocaleString('id-ID')}`;
}
function status(value) {
  return ({ approved: 'Disetujui', sent: 'Terkirim', pending: 'Menunggu', rejected: 'Ditolak' })[value] || value || '';
}
export function unifiedReportRows({ submissions = [], ledger = [] } = {}) {
  const eligible = submissions.filter(isReportSubmission);
  const byId = new Map(eligible.map(row => [String(row.id), row]));
  const linkedById = new Map(submissions.map(row => [String(row.id), row]));
  const represented = new Set(ledger.filter(row => row.submission_id != null).map(row => String(row.submission_id)));
  const rows = ledger.map(row => {
    const submission = byId.get(String(row.submission_id));
    const linkedSubmission = linkedById.get(String(row.submission_id));
    const description = row.description || submission?.description || row.note
      || (row.event_type === 'opening_balance' ? 'Saldo awal kas' : row.event_type === 'cash_topup' ? 'Tambah kas' : row.event_type);
    const note = submission?.note || row.submission_note || row.note;
    const applicant = row.created_by_name || submission?.created_by_name;
    const display = reportDisplayFields({ id: row.submission_id, topupId: row.topup_id, description, note, applicant });
    const ledgerReceipts = receiptUrls(row);
    const linkedReceipts = receiptUrls(linkedSubmission);
    const attachmentUrls = ledgerReceipts.length ? ledgerReceipts : linkedReceipts;
    return { ...row, report_key: `ledger-${row.id}`, report_at: row.created_at,
      report_description: [display.description, display.note && display.note !== display.description ? display.note : ''].filter(Boolean).join(' | '),
      known_demo: display.knownDemo,
      is_cash: true,
      dropbox_receipt_urls: attachmentUrls, report_attachment_urls: attachmentUrls,
      dropbox_receipt_url: attachmentUrls[0] || null,
    };
  });
  for (const submission of eligible) {
    if (represented.has(String(submission.id))) continue;
    const finance = String(submission.type).toLowerCase() === 'finance_request';
    const display = reportDisplayFields({ id: submission.id, description: submission.description, note: submission.note, applicant: submission.created_by_name });
    rows.push({ known_demo: display.knownDemo, report_key: `submission-${submission.id}`,
      report_at: submission.date ? `${submission.date}T00:00:00+07:00` : submission.created_at,
      report_description: [display.description, display.note,
        // Finance status and nominal are structured fields, not request prose.
        // Never scrub source text: user-entered numbers/notes remain verbatim.
        finance ? '' : `Pengajuan ${status(submission.status)} ${nominal(submission.amount_idr ?? submission.amount)}`].filter(Boolean).join(' | '),
      is_cash: false, direction: '', amount_idr: 0, submission_amount_idr: submission.amount_idr ?? submission.amount ?? 0, balance_after_idr: null,
      dropbox_receipt_urls: receiptUrls(submission), report_attachment_urls: receiptUrls(submission),
      dropbox_receipt_url: receiptUrls(submission)[0] || null,
    });
  }
  const hasSimulation = rows.some(row => row.known_demo || /simulasi/i.test(row.report_description));
  // Unknown prose is never scrubbed by substring, including the word SIMULASI.
  // Only the identity + exact templates above permit PDF-only cleanup.
  rows.sort((a, b) => (new Date(a.report_at).getTime() - new Date(b.report_at).getTime())
    || (a.is_cash && b.is_cash ? Number(a.id) - Number(b.id) : a.report_key.localeCompare(b.report_key)));
  return { rows, hasSimulation, totalSubmitted: eligible.reduce((sum, row) => sum + reportInteger(row.amount_idr ?? row.amount), 0n), submissionCount: eligible.length };
}
