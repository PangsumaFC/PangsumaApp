import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ApiError } from './http.js';

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 30;
const CONTENT_W = PAGE_W - MARGIN * 2;
const NAVY = rgb(0.035, 0.12, 0.22);
const TEAL = rgb(0.02, 0.48, 0.48);
const PALE = rgb(0.93, 0.97, 0.97);
const INK = rgb(0.12, 0.16, 0.20);
const MUTED = rgb(0.38, 0.44, 0.48);
const LINE = rgb(0.80, 0.85, 0.86);
const WHITE = rgb(1, 1, 1);
const MAX_PDF_PAGES = 150;

function sanitize(value) {
  let replaced = false;
  let text = String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...');
  text = text.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, () => { replaced = true; return '?'; });
  return { text, replaced };
}

function safeText(value) { return sanitize(value).text; }

function amount(value) {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) value = BigInt(value);
  if (typeof value === 'bigint') return `${value < 0n ? '-' : ''}Rp${(value < 0n ? -value : value).toLocaleString('id-ID')}`;
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return `${sign}Rp${Math.abs(Math.round(n)).toLocaleString('id-ID')}`;
}
function dateWib(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return safeText(value).slice(0, 24);
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d).replace(',', '');
}
function shortDate(value) {
  if (!value) return '-';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00+07:00`);
  return Number.isNaN(d.getTime()) ? safeText(value).slice(0, 10) : new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function integerIdr(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return BigInt(Math.round(num(value)));
}
function isIncoming(value) { return ['in', 'credit'].includes(String(value ?? '').toLowerCase()); }
function isOutgoing(value) { return ['out', 'debit'].includes(String(value ?? '').toLowerCase()); }
function statusLabel(value) {
  const key = String(value ?? '').toLowerCase();
  return ({ pending: 'Menunggu', approved: 'Disetujui', sent: 'Terkirim', rejected: 'Ditolak', cancelled: 'Dibatalkan' }[key] || (key ? safeText(value) : '-'));
}
function roleLabel(value) {
  const key = String(value ?? '').toLowerCase();
  return key === 'manager' ? 'Manager' : 'User';
}

function wrap(text, font, size, maxWidth) {
  const value = safeText(text);
  if (!value) return ['-'];
  const lines = [];
  let line = '';
  const words = value.split(/\s+/);
  const splitWord = (word) => {
    const parts = [];
    let rest = word;
    while (rest) {
      let lo = 1; let hi = rest.length; let best = 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (font.widthOfTextAtSize(rest.slice(0, mid), size) <= maxWidth) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      parts.push(rest.slice(0, best)); rest = rest.slice(best);
    }
    return parts;
  };
  for (const word of words) {
    const chunks = font.widthOfTextAtSize(word, size) <= maxWidth ? [word] : splitWord(word);
    for (const chunk of chunks) {
      const candidate = line ? `${line} ${chunk}` : chunk;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
      else { if (line) lines.push(line); line = chunk; }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ['-'];
}

export async function buildFinancialReport({ submissions = [], ledger = [], audits = [], snapshotAt, managerName, filterDescription = '', periodLabel = '', openingBalanceIdr = null, closingBalanceIdr = null, ledgerIsPartial = false, maxPages = MAX_PDF_PAGES } = {}) {
  const pageLimit = Math.min(MAX_PDF_PAGES, Math.max(1, Math.trunc(Number(maxPages)) || MAX_PDF_PAGES));
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle('Laporan Keuangan Pangsuma FC');
  pdf.setSubject('Petty Cash, Request Finance, dan jejak audit');
  pdf.setCreator('Pangsuma App');
  const snapshot = snapshotAt || new Date().toISOString();
  const dates = [...submissions.map(row => row.date ? `${row.date}T00:00:00+07:00` : row.created_at), ...ledger.map(row => row.created_at), ...audits.map(row => row.created_at)].map(value => new Date(value)).filter(date => Number.isFinite(date.getTime()));
  const earliest = dates.length ? dates.reduce((a, b) => a < b ? a : b) : new Date(snapshot);
  const latest = dates.length ? dates.reduce((a, b) => a > b ? a : b) : new Date(snapshot);
  const periodDate = date => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  const period = periodLabel || `Periode ${periodDate(earliest)} - ${periodDate(latest)} | Seluruh riwayat`;
  const filterLines = filterDescription ? wrap(`Filter: ${filterDescription}`, regular, 7.5, CONTENT_W) : [];
  const headerBottom = 100 + filterLines.length * 10;
  let page; let y; let pendingHeading = ''; let unicodeReplaced = sanitize(filterDescription).replaced;
  const mark = value => { const result = sanitize(value); unicodeReplaced ||= result.replaced; return result.text; };
  function newPage() {
    if (pdf.getPageCount() >= pageLimit) {
      throw new ApiError(413, 'report_too_large', `Laporan terlalu besar untuk PDF (maksimal ${pageLimit} halaman). Persempit filter lalu coba lagi.`);
    }
    page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: PAGE_H - 8, width: PAGE_W, height: 8, color: TEAL });
    page.drawText('PANGSUMA FC', { x: MARGIN, y: PAGE_H - 42, size: 13, font: bold, color: NAVY });
    page.drawText('LAPORAN KEUANGAN', { x: MARGIN, y: PAGE_H - 63, size: 19, font: bold, color: NAVY });
    page.drawText(`Tanggal cetak: ${mark(dateWib(snapshot))} WIB`, { x: PAGE_W - MARGIN - 240, y: PAGE_H - 47, size: 8, font: regular, color: MUTED });
    page.drawText(`Manager: ${mark(managerName || '-').slice(0, 45)}`, { x: PAGE_W - MARGIN - 240, y: PAGE_H - 61, size: 8, font: regular, color: MUTED });
    page.drawText(mark(period), { x: MARGIN, y: PAGE_H - 80, size: 7.5, font: regular, color: MUTED });
    filterLines.forEach((line, index) => page.drawText(mark(line), { x: MARGIN, y: PAGE_H - 92 - index * 10, size: 7.5, font: regular, color: MUTED }));
    y = PAGE_H - headerBottom;
  }
  function footer() {
    page.drawLine({ start: { x: MARGIN, y: 24 }, end: { x: PAGE_W - MARGIN, y: 24 }, thickness: 0.5, color: LINE });
    page.drawText('Pangsuma FC | Dokumen internal', { x: MARGIN, y: 12, size: 7, font: regular, color: MUTED });

  }
  function ensure(height = 20) { if (y - height < 38) { footer(); newPage(); } }
  function text(value, x, yy, size = 9, font = regular, color = INK, opts = {}) {
    const valueText = mark(value);
    const width = opts.maxWidth;
    const measured = font.widthOfTextAtSize(valueText, size);
    const xx = opts.align === 'right' && width ? x + width - measured : x;
    page.drawText(valueText, { x: xx, y: yy, size, font, color, maxWidth: width });
  }
  function heading(label) { pendingHeading = label; }
  function table({ columns, rows, totals }) {
    const headerH = 22; const fontSize = 7.4; const pad = 5; const lineH = 9.4;
    const total = columns.reduce((a, c) => a + c.width, 0);
    if (total > CONTENT_W + 0.01) throw new Error(`Table width ${total} exceeds content width ${CONTENT_W}`);
    if (pendingHeading) {
      const lines = rows.length ? Math.max(...columns.map(column => wrap(mark(rows[0][column.key]), regular, fontSize, column.width - pad * 2).length)) : 0;
      const firstHeight = rows.length ? Math.max(22, lines * lineH + 8) : 27;
      ensure(27 + headerH + Math.min(firstHeight, PAGE_H - headerBottom - 38 - 27 - headerH));
      text(pendingHeading, MARGIN, y, 12, bold, NAVY);
      page.drawRectangle({ x: MARGIN, y: y - 7, width: 38, height: 2, color: TEAL });
      y -= 27; pendingHeading = '';
    }
    function drawHeader() {
      ensure(headerH + 26);
      page.drawRectangle({ x: MARGIN, y: y - headerH + 4, width: total, height: headerH, color: NAVY });
      let x = MARGIN;
      columns.forEach(c => { text(c.label, x + pad, y - 11, 7, bold, WHITE, { maxWidth: c.width - pad * 2 }); x += c.width; });
      y -= headerH;
    }
    drawHeader();
    rows.forEach((row, rowIndex) => {
      const cells = columns.map(c => wrap(mark(row[c.key]), regular, fontSize, c.width - pad * 2));
      const rowHeight = Math.max(22, Math.max(...cells.map(c => c.length)) * lineH + 8);
      if (rowIndex > 0 && rowHeight <= PAGE_H - headerBottom - headerH - 38 && y - rowHeight < 38) {
        footer(); newPage(); drawHeader();
      }
      let offset = 0;
      while (offset < Math.max(...cells.map(c => c.length))) {
        const remaining = Math.max(...cells.map(c => c.length)) - offset;
        const availableLines = Math.max(1, Math.floor((y - 38 - 8) / lineH));
        const count = Math.min(remaining, Math.max(1, availableLines));
        const h = Math.max(22, count * lineH + 8);
        if (y - h < 38) { footer(); newPage(); drawHeader(); continue; }
        if (rowIndex % 2 === 0) page.drawRectangle({ x: MARGIN, y: y - h + 4, width: total, height: h, color: rgb(0.975, 0.985, 0.985) });
        let x = MARGIN;
        cells.forEach((cell, ci) => {
          const col = columns[ci]; const slice = cell.slice(offset, offset + count);
          slice.forEach((line, li) => text(line, x + pad, y - 12 - li * lineH, fontSize, regular, INK, { maxWidth: col.width - pad * 2, align: col.align }));
          x += col.width;
        });
        page.drawLine({ start: { x: MARGIN, y: y - h + 4 }, end: { x: MARGIN + total, y: y - h + 4 }, thickness: 0.35, color: LINE });
        y -= h; offset += count;
      }
    });
    if (totals) {
      const cells = columns.map(c => totals[c.key] === undefined ? [] : wrap(mark(totals[c.key]), bold, fontSize, c.width - pad * 2));
      const height = Math.max(24, Math.max(...cells.map(c => c.length)) * lineH + 8);
      if (y - height < 38) { footer(); newPage(); drawHeader(); }
      page.drawRectangle({ x: MARGIN, y: y - height + 4, width: total, height, color: PALE });
      let x = MARGIN;
      columns.forEach((c, i) => {
        cells[i].forEach((line, li) => text(line, x + pad, y - 12 - li * lineH, fontSize, bold, NAVY, { maxWidth: c.width - pad * 2, align: c.align }));
        x += c.width;
      });
      y -= height;
    }
    y -= 13;
  }

  const subs = [...(Array.isArray(submissions) ? submissions : [])].sort((a, b) => {
    const ad = new Date(a.date || a.created_at || 0).getTime(); const bd = new Date(b.date || b.created_at || 0).getTime();
    return (ad - bd) || String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
  const ledgers = [...(Array.isArray(ledger) ? ledger : [])].sort((a, b) => num(a.id) - num(b.id));
  const auditRows = [...(Array.isArray(audits) ? audits : [])].sort((a, b) => (new Date(a.created_at || a.date || 0) - new Date(b.created_at || b.date || 0)) || num(a.id) - num(b.id));
  const petty = subs.filter(s => String(s.type || '').toLowerCase() === 'petty_cash');
  const finance = subs.filter(s => String(s.type || '').toLowerCase() !== 'petty_cash');
  const totalFor = (list, statuses) => list.filter(s => statuses.includes(String(s.status).toLowerCase())).reduce((a, s) => a + integerIdr(s.amount_idr ?? s.amount), 0n);
  const totalSubmitted = list => list.reduce((a, s) => a + integerIdr(s.amount_idr ?? s.amount), 0n);
  const financeApproved = totalFor(finance, ['approved']); const financeSent = totalFor(finance, ['sent']);
  const opening = ledgers.find(l => l.event_type === 'opening_balance' && num(l.amount_idr) > 0) || ledgers.find(l => l.event_type === 'opening_balance');
  const openingBalance = openingBalanceIdr !== null ? integerIdr(openingBalanceIdr) : integerIdr(opening?.balance_after_idr ?? (opening ? opening.amount_idr : 0));
  const incoming = ledgers.filter(l => isIncoming(l.direction)).reduce((a, l) => a + integerIdr(l.amount_idr ?? l.amount), 0n);
  const outgoing = ledgers.filter(l => isOutgoing(l.direction)).reduce((a, l) => a + integerIdr(l.amount_idr ?? l.amount), 0n);
  const finalBalance = closingBalanceIdr !== null ? integerIdr(closingBalanceIdr) : ledgers.length ? integerIdr(ledgers[ledgers.length - 1].balance_after_idr) : openingBalance;

  newPage();
  ensure(108);
  page.drawRectangle({ x: MARGIN, y: y - 96, width: CONTENT_W, height: 96, color: PALE });
  text('RINGKASAN', MARGIN + 14, y - 17, 8, bold, TEAL);
  text(`${ledgerIsPartial ? 'Saldo akun awal' : 'Saldo awal'} ${amount(openingBalance)}`, MARGIN + 14, y - 35, 9, regular, INK);
  text(`${ledgerIsPartial ? 'Saldo akun akhir' : 'Saldo akhir'} ${amount(finalBalance)}`, MARGIN + 14, y - 53, 11, bold, NAVY);
  const stats = [`${ledgerIsPartial ? 'Masuk terpilih' : openingBalanceIdr !== null ? 'Masuk periode' : 'Masuk + saldo awal'} ${amount(incoming)}`, `${ledgerIsPartial ? 'Keluar terpilih' : 'Keluar'} ${amount(outgoing)}`, `Finance disetujui ${amount(financeApproved)}`, `Finance terkirim ${amount(financeSent)}`];
  stats.forEach((s, i) => text(s, MARGIN + 260 + (i % 2) * 245, y - 35 - Math.floor(i / 2) * 18, 8, regular, INK));
  text(`Petty Cash: ${petty.length} pengajuan | Total diajukan ${amount(totalSubmitted(petty))}`, MARGIN + 14, y - 74, 8, regular, INK);
  text(`Request Finance: ${finance.length} pengajuan | Total diajukan ${amount(totalSubmitted(finance))}`, MARGIN + 14, y - 88, 8, regular, INK);
  text(`Baris ledger ${ledgers.length} | Audit ${auditRows.length}`, MARGIN + 505, y - 88, 8, regular, INK);
  y -= 112;

  if (ledgers.length) {
    heading(ledgerIsPartial ? 'Petty Cash - Buku Kas Terpilih (Saldo Akun)' : 'Petty Cash - Buku Kas');
    table({ columns: [
      { key: 'no', label: 'No', width: 38 }, { key: 'date', label: 'Tanggal (WIB)', width: 92 }, { key: 'description', label: 'Keterangan / ID Referensi', width: 330 },
      { key: 'in', label: 'Masuk', width: 100, align: 'right' }, { key: 'out', label: 'Keluar', width: 100, align: 'right' }, { key: 'balance', label: 'Saldo', width: 111, align: 'right' }
    ], rows: ledgers.map((l, i) => ({ no: i + 1, date: dateWib(l.created_at ?? l.date), description: [l.description || l.note || (l.event_type === 'opening_balance' ? 'Saldo awal Petty Cash' : l.event_type), l.description && l.note && l.note !== l.description ? l.note : '', l.created_by_name ? `Pengaju: ${l.created_by_name}` : '', l.actor_name ? `Pencatat: ${l.actor_name}` : '', `Ledger #${l.id}${l.submission_id ? ` | Pengajuan ${l.submission_id}` : ''}`].filter(Boolean).join(' | '), in: isIncoming(l.direction) ? amount(l.amount_idr ?? l.amount) : '-', out: isOutgoing(l.direction) ? amount(l.amount_idr ?? l.amount) : '-', balance: amount(l.balance_after_idr) })), totals: { description: 'Total buku kas', in: amount(incoming), out: amount(outgoing) } });
  }

  function submissionTable(rows) {
    table({ columns: [
      { key: 'id', label: 'No.', width: 80 }, { key: 'date', label: 'Tanggal', width: 62 }, { key: 'status', label: 'Status', width: 80 },
      { key: 'applicant', label: 'Pengaju / Jabatan', width: 170 }, { key: 'amount', label: 'Nominal', width: 102, align: 'right' }, { key: 'reason', label: 'Keterangan / Catatan / Keputusan', width: 287 }
    ], rows: rows.map((s, index) => ({ id: index + 1, date: shortDate(s.date || s.created_at), status: statusLabel(s.status), applicant: `${s.created_by_name || s.applicant_name || s.created_by || '-'} / ${roleLabel(s.created_by_role || s.role)}${s.created_by_position || s.position ? ` / ${s.created_by_position || s.position}` : ''}`, amount: amount(s.amount_idr ?? s.amount), reason: [s.description, s.note, s.decision_reason].filter(Boolean).join(' | ') || '-' })), totals: { applicant: 'Total pengajuan', amount: amount(totalSubmitted(rows)) } });
  }
  if (petty.length) { heading('Pengajuan Petty Cash'); submissionTable(petty); }
  if (finance.length) { heading('Request Finance'); submissionTable(finance); }

  if (auditRows.length) {
    heading('Lampiran Audit');
    table({ columns: [
      { key: 'id', label: 'ID', width: 45 }, { key: 'date', label: 'Waktu (WIB)', width: 100 }, { key: 'action', label: 'Aksi', width: 145 },
      { key: 'actor', label: 'Aktor', width: 115 }, { key: 'entity', label: 'Entitas', width: 105 }, { key: 'details', label: 'Rincian', width: 271 }
    ], rows: auditRows.map(a => ({ id: a.id ?? '-', date: dateWib(a.created_at ?? a.date), action: a.action || '-', actor: a.actor_name || a.actor || 'Sistem', entity: `${a.entity_type || '-'} #${a.entity_id || '-'}`, details: typeof a.details_json === 'string' ? a.details_json : JSON.stringify(a.details_json ?? {}) })) });
  }

  if (!subs.length && !ledgers.length && !auditRows.length) text('Tidak ada transaksi pada filter ini.', MARGIN, y, 9, regular, MUTED);
  if (unicodeReplaced) { ensure(22); text('Karakter di luar font ditampilkan sebagai ?.', MARGIN, y, 7, regular, MUTED); }
  footer();
  const pages = pdf.getPages();
  pages.forEach((entry, index) => {
    const label = `Halaman ${index + 1} dari ${pages.length}`;
    entry.drawText(label, { x: PAGE_W - MARGIN - regular.widthOfTextAtSize(label, 7), y: 12, size: 7, font: regular, color: MUTED });
  });
  return pdf.save();
}

export { safeText, amount, dateWib, statusLabel, wrap };
