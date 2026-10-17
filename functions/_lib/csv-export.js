const FORMULA_PREFIX = /^[\s]*[=+\-@]/;

/**
 * Serialize one CSV field. Numeric values remain numeric-looking (notably
 * negative amounts); only textual formula-like values receive a leading
 * apostrophe to prevent spreadsheet formula execution.
 */
export function csvCell(value) {
  const isText = typeof value === 'string';
  let text = String(value ?? '');
  if (isText && FORMULA_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvLine(values) {
  return `${values.map(csvCell).join(',')}\r\n`;
}

export const CSV_HEADERS = [
  'Kategori', 'ID', 'Waktu', 'Tanggal laporan', 'Jenis', 'Status', 'Nominal IDR',
  'Pengaju', 'Jabatan', 'Keperluan', 'Catatan', 'Alasan keputusan', 'Aktor',
  'Arah ledger', 'Saldo setelah IDR', 'Aksi audit', 'Tipe entitas', 'ID entitas',
  'Rincian audit'
];

export function csvHeader() {
  return `\uFEFF${csvLine(CSV_HEADERS)}`;
}
