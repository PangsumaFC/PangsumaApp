import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ApiError } from './http.js';
import { unifiedReportRows } from './pdf-cashflow.js';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
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

export async function buildFinancialReport({ submissions = [], ledger = [], snapshotAt, managerName, filterDescription = '', periodLabel = '', openingBalanceIdr = null, closingBalanceIdr = null, ledgerIsPartial = false, maxPages = MAX_PDF_PAGES } = {}) {
  const pageLimit = Math.min(MAX_PDF_PAGES, Math.max(1, Math.trunc(Number(maxPages)) || MAX_PDF_PAGES));
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle('Laporan Keuangan Pangsuma FC');
  pdf.setSubject('Buku kas ledger sesuai filter; bukan daftar pengajuan atau audit');
  pdf.setCreator('Pangsuma App');
  const snapshot = snapshotAt || new Date().toISOString();
  const unified = unifiedReportRows({ submissions, ledger });
  const dates = unified.rows.map(row => row.report_at).map(value => new Date(value)).filter(date => Number.isFinite(date.getTime()));
  const earliest = dates.length ? dates.reduce((a, b) => a < b ? a : b) : new Date(snapshot);
  const latest = dates.length ? dates.reduce((a, b) => a > b ? a : b) : new Date(snapshot);
  const periodDate = date => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  const period = periodLabel || `Periode ${periodDate(earliest)} - ${periodDate(latest)} | Seluruh riwayat`;
  const filterLines = filterDescription ? wrap(`Filter: ${filterDescription}`, regular, 7.5, CONTENT_W) : [];
  const scope = 'Saldo hanya kas tercatat; Finance masuk total pengajuan. Tanggal: pencatatan kas / tanggal pengajuan.' + (ledgerIsPartial ? ' Saldo akun termasuk transaksi di luar filter.' : '');
  const scopeLines = wrap(scope, regular, 8, CONTENT_W);
  const headerBottom = 103 + filterLines.length * 10 + scopeLines.length * 10;
  let page; let y; let unicodeReplaced = sanitize(filterDescription).replaced;
  const mark = value => { const result = sanitize(value); unicodeReplaced ||= result.replaced; return result.text; };
  function newPage() {
    if (pdf.getPageCount() >= pageLimit) {
      throw new ApiError(413, 'report_too_large', `Laporan terlalu besar untuk PDF (maksimal ${pageLimit} halaman). Pilih rentang tanggal lebih pendek atau persempit pemohon, jenis, atau status lalu coba lagi.`);
    }
    page = pdf.addPage([PAGE_W, PAGE_H]);
    // Continuation pages start with table content, not repeated report headers.
    y = PAGE_H - MARGIN;
    if (pdf.getPageCount() > 1) return;
    page.drawRectangle({ x: 0, y: PAGE_H - 8, width: PAGE_W, height: 8, color: TEAL });
    page.drawText('PANGSUMA FC', { x: MARGIN, y: PAGE_H - 42, size: 13, font: bold, color: NAVY });
    page.drawText('LAPORAN KEUANGAN', { x: MARGIN, y: PAGE_H - 63, size: 17, font: bold, color: NAVY });
    page.drawText(`Tanggal cetak: ${mark(dateWib(snapshot))} WIB`, { x: PAGE_W - MARGIN - 210, y: PAGE_H - 47, size: 8, font: regular, color: MUTED });
    page.drawText(`Manager: ${mark(managerName || '-').slice(0, 45)}`, { x: PAGE_W - MARGIN - 210, y: PAGE_H - 61, size: 8, font: regular, color: MUTED });
    if (hasSimulation) page.drawText('Memuat data contoh', { x: PAGE_W - MARGIN - 210, y: PAGE_H - 74, size: 8, font: bold, color: rgb(0.72, 0.12, 0.05) });
    page.drawText(mark(period), { x: MARGIN, y: PAGE_H - 80, size: 7.5, font: regular, color: MUTED });
    filterLines.forEach((line, index) => page.drawText(mark(line), { x: MARGIN, y: PAGE_H - 92 - index * 10, size: 7.5, font: regular, color: MUTED }));
    scopeLines.forEach((line, index) => page.drawText(mark(line), { x: MARGIN, y: PAGE_H - 94 - filterLines.length * 10 - index * 10, size: 8, font: regular, color: MUTED }));
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
  const ledgers = [...(Array.isArray(ledger) ? ledger : [])].sort((a, b) => num(a.id) - num(b.id));
  const signed = row => isIncoming(row.direction) ? integerIdr(row.amount_idr ?? row.amount) : isOutgoing(row.direction) ? -integerIdr(row.amount_idr ?? row.amount) : 0n;
  // Opening is before the first displayed movement. The opening_balance ledger
  // entry itself remains visible and contributes to incoming exactly once.
  const openingBalance = openingBalanceIdr !== null ? integerIdr(openingBalanceIdr)
    : ledgers.length ? integerIdr(ledgers[0].balance_after_idr) - signed(ledgers[0]) : 0n;
  const incoming = ledgers.filter(l => isIncoming(l.direction)).reduce((a, l) => a + integerIdr(l.amount_idr ?? l.amount), 0n);
  const outgoing = ledgers.filter(l => isOutgoing(l.direction)).reduce((a, l) => a + integerIdr(l.amount_idr ?? l.amount), 0n);
  const finalBalance = closingBalanceIdr !== null ? integerIdr(closingBalanceIdr) : ledgers.length ? integerIdr(ledgers[ledgers.length - 1].balance_after_idr) : openingBalance;
  const hasSimulation = unified.hasSimulation;

  function ledgerTable(rows) {
    const columns = [
      { key: 'no', label: 'No.', width: 28 }, { key: 'date', label: 'Tanggal', width: 68 },
      { key: 'description', label: 'Keterangan', width: 174 }, { key: 'in', label: 'Masuk', width: 84, align: 'right' },
      { key: 'out', label: 'Keluar', width: 84, align: 'right' }, { key: 'balance', label: 'Saldo', width: 97, align: 'right' },
    ];
    const total = columns.reduce((sum, column) => sum + column.width, 0);
    const headerH = 24; const fontSize = 8.5; const pad = 4; const lineH = 11;
    const pageSubtotal = { in: 0n, out: 0n, hasRows: false };
    const drawFirstPageHeader = () => {
      ensure(headerH + 26);
      if (pdf.getPageCount() !== 1) return;
      page.drawRectangle({ x: MARGIN, y: y - headerH + 4, width: total, height: headerH, color: NAVY });
      let x = MARGIN;
      columns.forEach(column => { text(column.label, x + pad, y - 11, 8, bold, WHITE, { maxWidth: column.width - pad * 2 }); x += column.width; });
      y -= headerH;
    };
    const drawPageSubtotal = () => {
      if (!pageSubtotal.hasRows) return;
      const height = 24;
      if (y - height < 38) { footer(); newPage(); }
      page.drawRectangle({ x: MARGIN, y: y - height + 4, width: total, height, color: PALE });
      let x = MARGIN;
      columns.forEach(column => {
        const value = column.key === 'description' ? 'Subtotal halaman' : column.key === 'in' ? amount(pageSubtotal.in) : column.key === 'out' ? amount(pageSubtotal.out) : '';
        if (value) text(value, x + pad, y - 12, fontSize, bold, NAVY, { maxWidth: column.width - pad * 2, align: column.align });
        x += column.width;
      });
      y -= height;
      pageSubtotal.in = 0n; pageSubtotal.out = 0n; pageSubtotal.hasRows = false;
    };
    drawFirstPageHeader();
    rows.forEach((row, rowIndex) => {
      const cells = columns.map(column => wrap(mark(row[column.key]), regular, fontSize, column.width - pad * 2));
      const lineCount = Math.max(...cells.map(cell => cell.length));
      let offset = 0;
      while (offset < lineCount) {
        const remaining = lineCount - offset;
        const reserveSubtotal = true;
        const availableLines = Math.max(1, Math.floor((y - 38 - (reserveSubtotal ? 24 : 0) - 8) / lineH));
        const count = Math.min(remaining, availableLines);
        const height = Math.max(22, count * lineH + 8);
        // Keep 24pt reserved for this page's subtotal; continuation chunks never
        // repeat monetary cells, but the subtotal must remain on the same page.
        if (reserveSubtotal && y - height < 38 + 24) { drawPageSubtotal(); footer(); newPage(); continue; }
        if (y - height < 38) { footer(); newPage(); continue; }
        if (rowIndex % 2 === 0) page.drawRectangle({ x: MARGIN, y: y - height + 4, width: total, height, color: rgb(0.975, 0.985, 0.985) });
        let x = MARGIN;
        cells.forEach((cell, cellIndex) => {
          const column = columns[cellIndex];
          // A continuation chunk carries text only; monetary values are counted and printed once.
          const slice = offset === 0 ? cell.slice(offset, offset + count) : (cellIndex >= 3 ? [] : cell.slice(offset, offset + count));
          slice.forEach((line, lineIndex) => text(line, x + pad, y - 12 - lineIndex * lineH, fontSize, regular, INK, { maxWidth: column.width - pad * 2, align: column.align }));
          x += column.width;
        });
        if (offset === 0) {
          pageSubtotal.in += isIncoming(row.direction) ? integerIdr(row.amount_idr ?? row.amount) : 0n;
          pageSubtotal.out += isOutgoing(row.direction) ? integerIdr(row.amount_idr ?? row.amount) : 0n;
        }
        pageSubtotal.hasRows = true;
        page.drawLine({ start: { x: MARGIN, y: y - height + 4 }, end: { x: MARGIN + total, y: y - height + 4 }, thickness: 0.35, color: LINE });
        y -= height; offset += count;
      }
    });
    drawPageSubtotal();
    const height = 24;
    if (y - height < 38) { footer(); newPage(); }
    page.drawRectangle({ x: MARGIN, y: y - height + 4, width: total, height, color: PALE });
    let x = MARGIN;
    columns.forEach(column => {
      const value = column.key === 'description' ? 'Total kas keseluruhan' : column.key === 'in' ? amount(incoming) : column.key === 'out' ? amount(outgoing) : '';
      if (value) text(value, x + pad, y - 12, fontSize, bold, NAVY, { maxWidth: column.width - pad * 2, align: column.align });
      x += column.width;
    });
    y -= height + 13;
  }

  newPage();
  ensure(94);
  page.drawRectangle({ x: MARGIN, y: y - 80, width: CONTENT_W, height: 80, color: PALE });
  text(`${ledgerIsPartial ? 'Saldo akun awal' : 'Saldo awal'} ${amount(openingBalance)}`, MARGIN + 10, y - 16, 9, regular, INK);
  text(`${ledgerIsPartial ? 'Saldo akun akhir' : 'Saldo akhir'} ${amount(finalBalance)}`, MARGIN + 10, y - 34, 10, bold, NAVY);
  text(`${ledgerIsPartial ? 'Masuk terpilih' : 'Masuk'} ${amount(incoming)}`, MARGIN + 280, y - 16, 9, regular, INK);
  text(`${ledgerIsPartial ? 'Keluar terpilih' : 'Keluar'} ${amount(outgoing)}`, MARGIN + 280, y - 34, 9, regular, INK);
  text(`Baris laporan ${unified.rows.length}`, MARGIN + 10, y - 52, 8.5, regular, INK);
  text(`Total pengajuan ${amount(unified.totalSubmitted)}`, MARGIN + 10, y - 69, 9, bold, NAVY);
  y -= 96;
  if (unified.rows.length) {
    ledgerTable(unified.rows.map((l, i) => ({
      no: i + 1,
      date: shortDate(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(l.report_at))),
      description: l.report_description,
      in: isIncoming(l.direction) ? amount(l.amount_idr ?? l.amount) : '-',
      out: isOutgoing(l.direction) ? amount(l.amount_idr ?? l.amount) : '-',
      balance: l.is_cash ? amount(l.balance_after_idr) : '-', direction: l.direction, amount_idr: l.amount_idr ?? l.amount,
    })));
  } else text('Tidak ada transaksi pada filter ini.', MARGIN, y, 9, regular, MUTED);
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
