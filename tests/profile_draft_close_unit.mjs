import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function profileDraftDirty('), source.indexOf('\nfunction hasUnsavedDraft('))
  + '\n' + source.slice(source.indexOf('function canCloseAppDialog('), source.indexOf('\nasync function openReportActivity('));

function harness({ values = {}, photoDataUrl, loading = false, saving = false, processing = false, confirm = true } = {}) {
  const fields = new Map(Object.entries(values));
  const calls = { confirms: 0, toasts: [] };
  const context = vm.createContext({
    profileDraft: { loading, saving, processing, photoDataUrl, target: {}, baseline: { nickname: 'Lama', position: 'Bek', quote: 'Tetap' } },
    document: { querySelector: selector => selector === '#userProfileForm' ? { querySelector: field => ({ value: fields.get(field) || '' }) } : null },
    window: { confirm: () => { calls.confirms += 1; return confirm; } },
    showToast: message => calls.toasts.push(message)
  });
  vm.runInContext(code, context);
  return { ...context, calls };
}

test('dialog profil pristine tidak memblokir penutupan atau meminta konfirmasi', () => {
  const h = harness({ values: { '#profileNickname': 'Lama', '#profilePosition': 'Bek', '#profileQuote': 'Tetap' } });
  assert.equal(h.profileDraftDirty(), false);
  assert.equal(h.canCloseAppDialog({ id: 'userProfileDialog' }), true);
  assert.equal(h.calls.confirms, 0);
});

test('perubahan nickname, posisi, kutipan, dan foto terdeteksi sebagai dirty', () => {
  for (const field of ['#profileNickname', '#profilePosition', '#profileQuote']) {
    const values = { '#profileNickname': 'Lama', '#profilePosition': 'Bek', '#profileQuote': 'Tetap' };
    values[field] = 'Baru';
    assert.equal(harness({ values }).profileDraftDirty(), true, field);
  }
  assert.equal(harness({ values: { '#profileNickname': 'Lama', '#profilePosition': 'Bek', '#profileQuote': 'Tetap' }, photoDataUrl: null }).profileDraftDirty(), true);
});

test('cancel mempertahankan dialog, confirm membolehkan discard', () => {
  const cancelled = harness({ values: { '#profileNickname': 'Baru' }, confirm: false });
  assert.equal(cancelled.canCloseAppDialog({ id: 'userProfileDialog' }), false);
  assert.equal(cancelled.calls.confirms, 1);
  const discarded = harness({ values: { '#profileNickname': 'Baru' }, confirm: true });
  assert.equal(discarded.canCloseAppDialog({ id: 'userProfileDialog' }), true);
});

test('pemrosesan atau penyimpanan memblokir close tanpa confirm discard', () => {
  for (const key of ['saving', 'processing']) {
    const h = harness({ [key]: true, values: { '#profileNickname': 'Baru' }, confirm: true });
    assert.equal(h.canCloseAppDialog({ id: 'userProfileDialog' }), false);
    assert.equal(h.calls.confirms, 0);
    assert.equal(h.calls.toasts.length, 1);
  }
});
