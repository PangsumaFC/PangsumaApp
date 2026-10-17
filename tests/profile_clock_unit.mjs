import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const clockSource = source.slice(source.indexOf('function welcomeClock('), source.indexOf('\nfunction updateWelcomePanel('));
const clock = vm.runInNewContext(`(${clockSource})`, { Date, Intl });

test('sapaan mengikuti WIB pada semua batas waktu', () => {
  for (const [hour, greeting] of [[0, 'malam'], [4, 'malam'], [5, 'pagi'], [10, 'pagi'], [11, 'siang'], [14, 'siang'], [15, 'sore'], [17, 'sore'], [18, 'malam'], [23, 'malam']]) {
    const result = clock(new Date(`2026-10-17T${String(hour).padStart(2, '0')}:00:00+07:00`));
    assert.equal(result.greeting, `Selamat ${greeting}`, `jam WIB ${hour}`);
    assert.match(result.date, /17 Oktober 2026/);
  }
});

test('tanggal dan sapaan tetap WIB meski zona waktu perangkat berbeda', () => {
  const original = process.env.TZ;
  try {
    const time = new Date('2026-10-18T13:30:00+07:00');
    for (const timezone of ['Pacific/Honolulu', 'Asia/Tokyo', 'UTC']) {
      process.env.TZ = timezone;
      assert.equal(clock(time).greeting, 'Selamat siang');
      assert.match(clock(time).date, /18 Oktober 2026/);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
