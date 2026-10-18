/* Organization controls: read-only previews and audited records, never balance adjustments. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const rupiah = value => {
    try { return new Intl.NumberFormat('id-ID', { style:'currency', currency:'IDR', maximumFractionDigits:0 }).format(BigInt(value || 0)); }
    catch { return '—'; }
  };
  const dateWib = value => value ? new Intl.DateTimeFormat('id-ID', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Jakarta' }).format(new Date(value)) + ' WIB' : '—';
  function previousMonth() {
    const parts = new Intl.DateTimeFormat('en', { timeZone:'Asia/Jakarta', year:'numeric', month:'2-digit' }).formatToParts(new Date());
    const year = Number(parts.find(p => p.type === 'year').value), month = Number(parts.find(p => p.type === 'month').value);
    return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
  }
  const safeInt = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  let hooks = {}, configured = false, generation = 0, reconRequest = 0;
  let alertsPromise = null, settingsPromise = null, alertRevision = 0;
  const initial = () => ({ financeOpen:false, settingsOpen:false, settings:null, settingsDraft:null, settingsConflict:false, items:[], period:'', draft:null, preview:null, reconLoading:false, reconSaving:false, settingsSaving:false, settingsLoading:false, trail:[''], page:0, hasMore:false, nextCursor:null, alerts:null, alertsLoaded:false, error:'', success:'' });
  let state = initial();
  const user = () => hooks.getUser?.();
  const manager = () => user()?.role === 'manager';
  const stamp = () => ({ generation, owner:user()?.id });
  const current = token => token.generation === generation && token.owner === user()?.id && manager();
  const changed = region => hooks.onChange?.(region || 'finance');
  const notify = (text, type = 'error') => hooks.notify?.(text, type);
  const newKey = () => hooks.newKey?.() || crypto.randomUUID();
  const storeKey = kind => `pangsuma.financial.${kind}.v2:${user()?.id || 'none'}`;
  function read(kind) { try { return JSON.parse(sessionStorage.getItem(storeKey(kind)) || '{}'); } catch { return {}; } }
  function write(kind, value) { try { sessionStorage.setItem(storeKey(kind), JSON.stringify(value)); } catch {} }
  function keyFor(kind, payload) {
    const stored = read(kind), fp = JSON.stringify(payload);
    const draft = kind === 'reconciliation' ? (stored.drafts?.[payload.period] || {}) : stored;
    if (draft.fp === fp && draft.key) return draft.key;
    const key = newKey();
    if (kind === 'reconciliation') saveReconDraft(payload.period, { ...draft, fp, key });
    else write(kind, { ...draft, fp, key });
    return key;
  }
  // Reconciliation drafts are account-scoped by storage key and period-scoped inside it.
  // Keep the old flat shape under legacyDraft: it has no trustworthy month and must never
  // be silently discarded or applied to a different month.
  const blankReconDraft = period => ({ period, physicalCashIdr:'', note:'', confirmed:false });
  function reconStore() { const stored = read('reconciliation'); return stored && typeof stored === 'object' ? stored : {}; }
  function draftFor(period) { const stored = reconStore(); const draft = stored.drafts?.[period]; return draft && draft.period === period ? { period, physicalCashIdr:draft.physicalCashIdr ?? '', note:draft.note || '', confirmed:false } : blankReconDraft(period); }
  function saveReconDraft(period, draft) {
    const stored = reconStore(), drafts = { ...(stored.drafts || {}) };
    drafts[period] = { ...drafts[period], ...draft, period, confirmed: Boolean(draft.confirmed) };
    write('reconciliation', { ...stored, drafts });
  }
  function legacyReconDraft() {
    const legacy = reconStore().legacyDraft;
    return legacy && typeof legacy === 'object' ? legacy : null;
  }
  function migrateReconStore() {
    const stored = reconStore();
    if (stored.legacyDraft || stored.drafts) return stored;
    if (Object.keys(stored).length) { const migrated = { drafts:{}, legacyDraft:{ ...stored } }; write('reconciliation', migrated); return migrated; }
    return stored;
  }
  function cleanError(error) {
    if (error?.status === 503) return 'Fitur menunggu skema lengkap. Tidak ada saldo yang diubah.';
    if (error?.status === 409 && error?.code === 'version_conflict') return 'Pengaturan telah berubah. Muat versi terbaru sebelum menyimpan kembali.';
    return error?.message || 'Data belum dapat dimuat. Draf tetap tersimpan; coba lagi.';
  }
  async function loadAlerts(force = false) {
    if (!manager() || alertsPromise || (!force && state.alertsLoaded)) return alertsPromise;
    const token = stamp(), revision = alertRevision;
    const promise = Promise.resolve().then(() => hooks.api('/financial/alerts')).then(result => {
      if (!current(token) || revision !== alertRevision) return;
      state.alerts = result; state.alertsLoaded = true; state.alertError = ''; changed('alerts');
    }).catch(error => { if (current(token) && revision === alertRevision) { state.alertsLoaded = true; state.alertError = cleanError(error); changed('alerts'); } }).finally(() => { if (alertsPromise === promise) alertsPromise = null; });
    alertsPromise = promise; return promise;
  }
  async function loadReconciliations(period, cursor = '', page = 0) {
    if (!manager()) return;
    const token = stamp(), requestId = ++reconRequest;
    state.reconLoading = true; state.error = ''; changed('finance');
    try {
      const query = new URLSearchParams({ period, limit:'5' }); if (cursor) query.set('cursor', cursor);
      const result = await hooks.api(`/cash/reconciliations?${query}`);
      if (!current(token) || requestId !== reconRequest || period !== state.period) return;
      state.items = result.reconciliations || []; state.preview = result.preview && (!result.preview.period || result.preview.period === period) ? { ...result.preview, period } : null;
      state.nextCursor = result.nextCursor || null; state.hasMore = Boolean(result.hasMore); state.page = page;
      state.trail[page] = cursor; state.trail.length = page + 1;
      if (state.trail.length > 200) { state.trail.shift(); state.page--; }
    } catch (error) { if (current(token) && requestId === reconRequest) state.error = cleanError(error); }
    finally { if (current(token) && requestId === reconRequest) { state.reconLoading = false; changed('finance'); } }
  }
  async function loadSettings(force = false) {
    if (!manager() || settingsPromise || (!force && state.settings)) return settingsPromise;
    const token = stamp(); state.settingsLoading = true;
    const promise = Promise.resolve().then(() => hooks.api('/financial/settings')).then(result => {
      if (!current(token)) return;
      state.settings = result; state.settingsConflict = false;
      if (state.settingsDraft === null) { const draft = read('settings'); state.settingsDraft = draft.values || null; }
    }).catch(error => { if (current(token)) state.error = cleanError(error); }).finally(() => {
      if (settingsPromise === promise) settingsPromise = null;
      if (current(token)) { state.settingsLoading = false; changed('finance'); }
    });
    settingsPromise = promise; return promise;
  }
  function renderOverview() {
    if (!manager()) return '';
    if (!state.alertsLoaded && !alertsPromise) queueMicrotask(() => loadAlerts());
    const a = state.alerts, lines = [];
    if (a?.cash?.configured && a.cash.isLow) lines.push(`Saldo di bawah ambang ${rupiah(a.cash.thresholdIdr)}`);
    if (a?.pending?.configured && a.pending.overdueCount) lines.push(`${a.pending.overdueCount} laporan melewati ${a.pending.maxDays} hari`);
    if (a && !lines.length && !state.alertError) return '';
    const text = !a ? 'Memuat peringatan…' : lines.join(' · ');
    return `<section class="fc-overview" aria-label="Peringatan keuangan">${text ? `<p class="fc-alert" role="status">${esc(text)}</p>` : ''}${state.alertError ? `<p role="alert" class="fc-error">${esc(state.alertError)}</p><button type="button" class="fc-secondary" data-fc-action="retry-alerts">Coba lagi</button>` : ''}</section>`;
  }
  function renderRows() {
    if (!state.items.length) return '<p class="fc-muted">Belum ada rekonsiliasi untuk periode ini.</p>';
    return `<div class="fc-history" aria-busy="${state.reconLoading}"><div class="fc-table-wrap" tabindex="0" aria-label="Tabel rekonsiliasi, dapat digeser"><table class="fc-table"><thead><tr><th>Periode</th><th>Saldo ledger</th><th>Fisik</th><th>Selisih</th><th>Manager / dibuat</th><th>Catatan</th></tr></thead><tbody>${state.items.map(row => `<tr><td>${esc(row.period)}</td><td>${esc(rupiah(row.ledgerBalanceIdr))}</td><td>${esc(rupiah(row.physicalCashIdr))}</td><td>${esc(rupiah(row.discrepancyIdr))}</td><td>${esc(row.managerName)}<br><small>${esc(dateWib(row.createdAt))}</small></td><td>${esc(row.note)}</td></tr>`).join('')}</tbody></table></div><div class="form-actions">${state.page > 0 ? '<button class="fc-secondary" type="button" data-fc-action="previous-reconciliations">Sebelumnya</button>' : ''}${state.hasMore ? '<button class="fc-secondary" type="button" data-fc-action="more-reconciliations">Lihat 5 berikutnya</button>' : ''}</div></div>`;
  }
  function renderSettings() {
    const values = state.settingsDraft || state.settings || {}, busy = state.settingsSaving || state.settingsLoading;
    return `<p class="fc-muted">Ambang berlaku untuk organisasi; batas perangkat tetap terpisah. Kolom kosong menonaktifkan peringatan terkait.</p><form id="fc-settings-form" novalidate aria-busy="${busy}"><label>Batas saldo organisasi (Rp)<input name="minimumCashIdr" inputmode="numeric" type="number" min="0" max="${Number.MAX_SAFE_INTEGER}" step="1" value="${esc(values.minimumCashIdr ?? '')}" ${busy ? 'disabled' : ''}></label><label>Pengajuan menunggu (hari)<input name="pendingMaxDays" inputmode="numeric" type="number" min="1" max="3650" step="1" value="${esc(values.pendingMaxDays ?? '')}" ${busy ? 'disabled' : ''}></label><button class="fc-primary" type="submit" ${busy || !state.settings ? 'disabled' : ''}>${state.settingsSaving ? 'Menyimpan…' : 'Simpan'}</button>${state.settingsConflict ? '<button class="fc-secondary" type="button" data-fc-action="reload-settings">Muat pengaturan terbaru</button>' : ''}</form>`;
  }
  function renderFinance() {
    if (!manager()) return '';
    state.period ||= previousMonth(); migrateReconStore(); if (!state.draft || state.draft.period !== state.period) state.draft = draftFor(state.period);
    const d = state.draft, busy = state.reconSaving, legacy = legacyReconDraft();
    return `<section class="fc-finance" aria-labelledby="fc-title"><div class="fc-heading"><div><h2 id="fc-title">Kontrol keuangan</h2><p>Rekonsiliasi untuk bulan yang sudah berakhir. Tanggal mengikuti WIB.</p></div></div><details class="fc-disclosure" data-fc-section="reconciliation" ${state.financeOpen ? 'open' : ''}><summary>Rekonsiliasi akhir bulan</summary><div class="fc-content"><form id="fc-reconciliation-form" novalidate aria-busy="${busy}"><label>Periode tertutup<input type="month" name="period" required max="${previousMonth()}" value="${esc(state.period)}" ${busy ? 'disabled' : ''}></label>${legacy ? `<p class="fc-legacy-notice" role="status">Draf lama dipertahankan tetapi bulannya tidak diketahui. Tidak akan diterapkan otomatis. <button type="button" class="fc-secondary" data-fc-action="restore-legacy">Pulihkan ke ${esc(state.period)}</button></p>` : ''}<p class="fc-preview" aria-live="polite">Saldo ledger: ${state.reconLoading ? 'Memuat…' : state.preview ? esc(rupiah(state.preview.ledgerBalanceIdr)) : 'Akan dihitung saat periode dipilih'}</p><label>Hasil hitung fisik (Rp)<input name="physicalCashIdr" inputmode="numeric" type="number" min="0" max="${Number.MAX_SAFE_INTEGER}" step="1" required value="${esc(d.physicalCashIdr ?? '')}" ${busy ? 'disabled' : ''}></label><label>Catatan<textarea name="note" minlength="3" maxlength="1000" required ${busy ? 'disabled' : ''}>${esc(d.note || '')}</textarea></label><label class="fc-check"><input type="checkbox" name="confirmed" required ${d.confirmed ? 'checked' : ''} ${busy ? 'disabled' : ''}> Saya mencatat hasil hitung fisik; selisih tidak mengubah saldo</label><button class="fc-primary" type="submit" ${busy || state.reconLoading || !state.preview ? 'disabled' : ''}>${busy ? 'Menyimpan…' : 'Simpan rekonsiliasi'}</button><p class="fc-form-error" data-fc-error role="alert"></p></form><h3>Riwayat rekonsiliasi</h3>${renderRows()}</div></details><details class="fc-disclosure" data-fc-section="settings" ${state.settingsOpen ? 'open' : ''}><summary>Pengaturan peringatan</summary><div class="fc-content">${renderSettings()}</div></details>${state.error ? `<p class="fc-error" role="alert">${esc(state.error)}</p>` : ''}${state.success ? `<p class="fc-success" role="status">${esc(state.success)}</p>` : ''}</section>`;
  }
  function capture(form) {
    if (form.id === 'fc-reconciliation-form') {
      if (form.elements.period?.value && form.elements.period.value !== state.period) return false;
      state.draft = { ...state.draft, period:form.elements.period?.value ?? state.period, physicalCashIdr:form.elements.physicalCashIdr?.value ?? '', note:form.elements.note?.value ?? '', confirmed:Boolean(form.elements.confirmed?.checked) };
      saveReconDraft(state.draft.period, state.draft);
    } else if (form.id === 'fc-settings-form') {
      state.settingsDraft = { minimumCashIdr:form.elements.minimumCashIdr.value, pendingMaxDays:form.elements.pendingMaxDays.value };
      write('settings', { ...read('settings'), values:state.settingsDraft });
    }
  }
  async function submitReconciliation(form) {
    if (state.reconSaving || !manager()) return;
    if (form.elements.period.value !== state.period) { form.querySelector('[data-fc-error]').textContent = 'Pilih ulang periode sebelum menyimpan.'; return; }
    capture(form);
    const amount = safeInt(state.draft.physicalCashIdr), note = String(state.draft.note || '').trim(), period = form.elements.period.value;
    if (!state.preview && period === state.period && !state.reconLoading) { await loadReconciliations(period); }
    const formPeriodMatchesState = period === state.period && state.draft.period === period;
    const error = amount === null ? 'Masukkan bilangan rupiah bulat yang aman.' : note.length < 3 || note.length > 1000 ? 'Catatan wajib 3–1000 karakter.' : !formPeriodMatchesState || state.preview?.period !== period ? 'Muat ulang periode yang dipilih sebelum menyimpan.' : !state.draft.confirmed ? 'Konfirmasi pencatatan diperlukan.' : !/^\d{4}-\d{2}$/.test(period) || period > previousMonth() ? 'Pilih bulan yang sudah berakhir.' : '';
    if (error) { form.querySelector('[data-fc-error]').textContent = error; return; }
    const payload = { period, physicalCashIdr:amount, note, confirmed:true }, key = keyFor('reconciliation', payload), token = stamp();
    state.reconSaving = true; state.error = ''; state.success = ''; changed('finance');
    try {
      await hooks.api('/cash/reconciliations', { method:'POST', headers:{ 'Idempotency-Key':key }, body:payload });
      if (!current(token)) return;
      const stored = reconStore(); const drafts = { ...(stored.drafts || {}) }; delete drafts[period]; write('reconciliation', { ...stored, drafts }); state.draft = draftFor(period); state.success = 'Rekonsiliasi tersimpan.'; state.trail = [''];
      await loadReconciliations(period); notify(state.success, 'success');
    } catch (error) { if (current(token)) { state.error = cleanError(error); notify(state.error); } }
    finally { if (current(token)) { state.reconSaving = false; changed('finance'); } }
  }
  async function submitSettings(form) {
    if (state.settingsSaving || !state.settings || !manager()) return;
    capture(form); const values = state.settingsDraft;
    const minimumCashIdr = values.minimumCashIdr === '' ? null : safeInt(values.minimumCashIdr);
    const pendingMaxDays = values.pendingMaxDays === '' ? null : safeInt(values.pendingMaxDays);
    if ((values.minimumCashIdr !== '' && minimumCashIdr === null) || (values.pendingMaxDays !== '' && (pendingMaxDays === null || pendingMaxDays < 1 || pendingMaxDays > 3650))) { state.error = 'Nilai pengaturan tidak valid.'; changed('finance'); return; }
    if (!window.confirm('Simpan pengaturan peringatan organisasi?')) return;
    const payload = { minimumCashIdr, pendingMaxDays, expectedVersion:Number(state.settings.version) }, key = keyFor('settings', payload), token = stamp();
    state.settingsSaving = true; state.error = ''; state.success = ''; changed('finance');
    try {
      const result = await hooks.api('/financial/settings', { method:'PUT', headers:{ 'Idempotency-Key':key }, body:payload });
      if (!current(token)) return;
      state.settings = result; state.settingsDraft = null; state.settingsConflict = false; write('settings', {}); state.success = 'Pengaturan tersimpan.';
      state.alertsLoaded = false; alertRevision++; alertsPromise = null; void loadAlerts(true); notify(state.success, 'success');
    } catch (error) { if (current(token)) { state.settingsConflict = error?.status === 409; state.error = cleanError(error); notify(state.error); } }
    finally { if (current(token)) { state.settingsSaving = false; changed('finance'); } }
  }
  function onToggle(event) {
    const details = event.target.closest?.('details[data-fc-section]'); if (!details || details.isConnected === false || !manager()) return;
    if (details.dataset.fcSection === 'reconciliation') {
      const before = state.financeOpen; state.financeOpen = details.open;
      if (details.open && !before && !state.reconLoading) { state.period ||= previousMonth(); void loadReconciliations(state.period); }
    } else if (details.dataset.fcSection === 'settings') {
      const before = state.settingsOpen; state.settingsOpen = details.open;
      if (details.open && !before && !state.settings && !settingsPromise) void loadSettings();
    }
  }
  function onInput(event) { const form = event.target.closest?.('#fc-reconciliation-form,#fc-settings-form'); if (form && manager() && !(form.id === 'fc-reconciliation-form' && (event.target.name === 'period' || event.target.type === 'month'))) { if (form.id === 'fc-reconciliation-form' && event.target.name !== 'confirmed' && form.elements.confirmed) form.elements.confirmed.checked = false; capture(form); } }
  function onChange(event) {
    if (event.target.name !== 'period' || event.target.closest?.('form')?.id !== 'fc-reconciliation-form') { onInput(event); return; }
    const period = event.target.value;
    if (!/^\d{4}-\d{2}$/.test(period) || period > previousMonth()) { state.error = 'Pilih bulan yang sudah berakhir.'; changed('finance'); return; }
    if (state.period && state.draft) saveReconDraft(state.period, state.draft);
    state.period = period; state.preview = null; state.success = ''; state.error = ''; state.items = []; state.draft = draftFor(period);
    state.trail = ['']; state.page = 0; state.nextCursor = null; state.hasMore = false; void loadReconciliations(period);
  }
  function onClick(event) {
    const button = event.target.closest?.('[data-fc-action]'); if (!button || !manager()) return;
    const action = button.dataset.fcAction;
    if (action === 'approvals') hooks.navigate?.('approvals');
    if (action === 'retry-alerts') { state.alertsLoaded = false; void loadAlerts(true); }
    if (action === 'reload-settings') { state.settingsDraft = null; state.error = ''; write('settings', {}); void loadSettings(true); }
    if (action === 'restore-legacy') {
      const legacy = legacyReconDraft();
      if (legacy && (state.draft?.physicalCashIdr || state.draft?.note)) { state.error = 'Draf periode ini tetap disimpan. Pilih periode kosong untuk memulihkan draf lama.'; changed('finance'); return; }
      if (legacy) { state.draft = { ...blankReconDraft(state.period), physicalCashIdr: String(legacy.physicalCashIdr ?? ''), note: String(legacy.note ?? ''), confirmed: false }; saveReconDraft(state.period, state.draft); state.success = `Draf lama dipulihkan ke ${state.period}; periksa kembali sebelum menyimpan.`; state.error = ''; changed('finance'); }
      return;
    }
    if (state.reconLoading) return;
    if (action === 'more-reconciliations' && state.nextCursor) void loadReconciliations(state.period, state.nextCursor, state.page + 1);
    if (action === 'previous-reconciliations' && state.page > 0) void loadReconciliations(state.period, state.trail[state.page - 1], state.page - 1);
  }
  function configure(options = {}) {
    hooks = options;
    if (!configured) {
      configured = true; document.addEventListener('toggle', onToggle, true); document.addEventListener('click', onClick);
      document.addEventListener('input', onInput); document.addEventListener('change', onChange);
      document.addEventListener('submit', event => { if (event.target.id === 'fc-reconciliation-form') { event.preventDefault(); void submitReconciliation(event.target); } else if (event.target.id === 'fc-settings-form') { event.preventDefault(); void submitSettings(event.target); } });
    }
    return api;
  }
  const api = { configure, renderFinance, renderOverview, refresh() { alertRevision++; state.alertsLoaded = false; state.alertError = ''; alertsPromise = null; changed('alerts'); }, clear() { generation++; reconRequest++; alertRevision++; state = initial(); alertsPromise = null; settingsPromise = null; } };
  window.FinancialControls = api;
})();
