// Report-only projection. Never changes submission state, ledger or balances.
export function isReportSubmission(row) {
  return String(row.created_by_role ?? row.role ?? '').toLowerCase() === 'manager'
    || ['approved', 'sent'].includes(String(row.status ?? '').toLowerCase());
}
export function reportInteger(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  const n = Number(value);
  return BigInt(Number.isFinite(n) ? Math.round(n) : 0);
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
  const represented = new Set(ledger.filter(row => row.submission_id != null).map(row => String(row.submission_id)));
  const rows = ledger.map(row => {
    const submission = byId.get(String(row.submission_id));
    const description = row.description || submission?.description || row.note
      || (row.event_type === 'opening_balance' ? 'Saldo awal kas' : row.event_type === 'cash_topup' ? 'Tambah kas' : row.event_type);
    const note = submission?.note || row.submission_note || row.note;
    const applicant = row.created_by_name || submission?.created_by_name;
    return { ...row, report_key: `ledger-${row.id}`, report_at: row.created_at,
      report_description: [description, note && note !== description ? note : '', applicant ? `Pengaju: ${applicant}` : ''].filter(Boolean).join(' | '),
      is_cash: true,
    };
  });
  for (const submission of eligible) {
    if (represented.has(String(submission.id))) continue;
    const finance = String(submission.type).toLowerCase() === 'finance_request';
    rows.push({ report_key: `submission-${submission.id}`,
      report_at: submission.date ? `${submission.date}T00:00:00+07:00` : submission.created_at,
      report_description: [submission.description, submission.note,
        `${finance ? 'Finance' : 'Pengajuan'} ${status(submission.status)} ${nominal(submission.amount_idr ?? submission.amount)}`,
        submission.created_by_name ? `Pengaju: ${submission.created_by_name}` : ''].filter(Boolean).join(' | '),
      is_cash: false, direction: '', amount_idr: 0, balance_after_idr: null,
    });
  }
  const hasSimulation = rows.some(row => /simulasi/i.test(row.report_description));
  // Presentation only: one clear report-level marker replaces repeated row labels.
  // Keep source records untouched, and never infer real transactions from examples.
  if (hasSimulation) for (const row of rows) row.report_description = row.report_description.replace(/\bSIMULASI\b[ \t]*[|:-]?[ \t]*/gi, '').trim();
  rows.sort((a, b) => (new Date(a.report_at).getTime() - new Date(b.report_at).getTime())
    || (a.is_cash && b.is_cash ? Number(a.id) - Number(b.id) : a.report_key.localeCompare(b.report_key)));
  return { rows, hasSimulation, totalSubmitted: eligible.reduce((sum, row) => sum + reportInteger(row.amount_idr ?? row.amount), 0n), submissionCount: eligible.length };
}
