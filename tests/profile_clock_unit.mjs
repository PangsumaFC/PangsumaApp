import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const clockSource = source.slice(source.indexOf('function welcomeClock('), source.indexOf('\nfunction updateWelcomePanel('));
const clock = vm.runInNewContext(`(${clockSource})`, { Date, Intl });

test('sapaan mengikuti jam perangkat dan semua batas waktu', () => {
  for (const [hour, greeting] of [[0, 'malam'], [4, 'malam'], [5, 'pagi'], [10, 'pagi'], [11, 'siang'], [14, 'siang'], [15, 'sore'], [17, 'sore'], [18, 'malam'], [23, 'malam']]) {
    const result = clock(new Date(2026, 9, 17, hour, 0));
    assert.equal(result.greeting, `Selamat ${greeting}`, `jam ${hour}`);
    assert.match(result.date, /17 Oktober 2026/);
  }
});

test('tanggal dashboard mengikuti tanggal lokal, bukan waktu laporan Jakarta', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const time = new Date('2026-10-18T06:30:00Z');
    assert.equal(clock(time).greeting, 'Selamat malam');
    assert.match(clock(time).date, /17 Oktober 2026/);
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(clock(time).greeting, 'Selamat sore');
    assert.match(clock(time).date, /18 Oktober 2026/);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
