import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../functions/_lib/http.js';
import { buildSubmissionFilterSql, parseReportFilters } from '../functions/_lib/report-filters.js';

const parse = (query, now = new Date('2028-02-29T16:30:00.000Z')) => parseReportFilters(new URLSearchParams(query), now);

test('report filters calculate Monday-Sunday week and actual current month in WIB', () => {
  assert.deepEqual(parse('periode=mingguini'), { period: 'mingguini', startDate: '2028-02-28', endDate: '2028-02-29', q: '', applicant: '', type: '', status: '' });
  const month = parse('periode=bulanini');
  assert.equal(month.startDate, '2028-02-01'); assert.equal(month.endDate, '2028-02-29');
  const sunday = parse('periode=mingguini', new Date('2028-03-05T12:00:00.000Z'));
  assert.deepEqual([sunday.startDate, sunday.endDate], ['2028-02-28', '2028-03-05']);
});

test('custom WIB dates accept leap day but reject impossible calendar and reversed/partial ranges', () => {
  assert.equal(parse('periode=customWIB&start=2028-02-29&end=2028-02-29').startDate, '2028-02-29');
  for (const query of ['periode=customWIB&start=2027-02-29&end=2027-03-01', 'start=2028-02-30&end=2028-03-01', 'start=2028-03-02&end=2028-03-01', 'start=2028-03-01', 'periode=customWIB&start=2028-03-01']) {
    assert.throws(() => parse(query), (e) => e instanceof ApiError && e.status === 400 && e.code === 'invalid_date_range');
  }
});

test('type/status/search/applicant hostile values fail closed and LIKE wildcards are escaped', () => {
  for (const query of ['type=petty_cash%27%20OR%201%3D1', 'status=approved%27%20OR%201%3D1', `q=${'x'.repeat(121)}`, `applicant=${'x'.repeat(121)}`]) {
    assert.throws(() => parse(query), (e) => e instanceof ApiError && e.status === 400);
  }
  const filters = parse('q=100%_\\&applicant=Alpha%_\\');
  const sql = buildSubmissionFilterSql(filters);
  assert.match(sql.where, /ESCAPE '\\'/);
  assert.deepEqual(sql.params.slice(-7), ['Alpha%_\\', '%Alpha\\%\\_\\\\%', '%Alpha\\%\\_\\\\%', '%100\\%\\_\\\\%', '%100\\%\\_\\\\%', '%100\\%\\_\\\\%', '%100\\%\\_\\\\%']);
  assert.match(sql.where, /s\.date LIKE/);
});
