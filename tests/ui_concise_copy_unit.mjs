import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');

function render(expression) {
  const sandbox = { document: { querySelector: () => null }, window: {}, Intl, Date, String, Number, Boolean, Array, JSON, Math };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('initialize();', `globalThis.__html = ${expression};`), sandbox);
  return sandbox.__html;
}

test('copy UI ringkas menggantikan narasi internal tanpa mengubah batas lokal', () => {
  assert.match(source, /'Saldo tersedia'/);
  assert.match(source, /Riwayat kas harian · Seluruh riwayat \(WIB\)/);
  assert.match(source, /'Batas minimum bawaan'/);
  assert.match(source, /'Batas minimum perangkat ini \(lokal\)'/);
  assert.doesNotMatch(source, /Saldo dikelola melalui keputusan dan ledger\.|Ledger per hari|Batas default server/);
});

test('saldo nol tetap memakai otorisasi pemilik dan action top-up tetap tersedia', () => {
  const html = render("(() => { state.user={id:'m',role:'manager'}; state.cashBalanceIdr=0; state.summary={}; return managerOverview(); })()");
  assert.match(html, /Saldo awal tetap nol sampai pemilik mengonfirmasi angka aktual\./);
  assert.match(html, /data-action="open-cash-topup"/);
  assert.doesNotMatch(html, /Saldo tersedia/);
});

test('Finance dan users memakai copy ringkas pada empty state', () => {
  const finance = render("(() => { state.user={id:'m',role:'manager'}; state.cashFlow={openingConfigured:false}; return financePage(); })()");
  assert.match(finance, />Laporan dan kas\.<\/p>/);
  assert.doesNotMatch(finance, /Pantau Request Finance dan laporan terfilter/);

  const users = render("(() => { state.user={id:'m',role:'manager'}; state.users=[]; state.usersPage={page:1,limit:5,total:0,hasMore:false,query:'',loading:false,error:''}; return usersPage(); })()");
  assert.match(users, /Belum ada pengguna\./);
  assert.doesNotMatch(users, /Daftar akun dimuat dari server setelah bootstrap disetujui\./);
});
