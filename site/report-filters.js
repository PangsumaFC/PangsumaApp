/* Manager reports: bounded keyset pages, cancellable search, and filter/PDF parity. */
(() => {
  let hooks = null, bound = false, searchTimer = null, controller = null, generation = 0;
  const PAGE_SIZE = 25;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const fresh = (owner = '') => ({ owner, filters: {}, draftFilters: null, draftQ: '', items: [], total: 0, hasMore: false, hasPrevious: false, nextCursor: '', previousCursor: '', loaded: false, loading: false, error: '', label: 'Semua pengajuan' });
  let current = fresh();
  const owner = () => hooks?.getUser?.()?.role === 'manager' ? hooks.getUser().id : '';
  function cancelSearch() { clearTimeout(searchTimer); searchTimer = null; }
  function syncOwner() { const id = owner(); if (id !== current.owner) { cancelSearch(); controller?.abort(); generation++; current = fresh(id); } return id; }
  function params(filters = current.filters) { const p = new URLSearchParams(); Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v); }); return p; }
  function pdfUrl() { syncOwner(); const query = params().toString(); return `/api/export.pdf${query ? `?${query}` : ''}`; }
  function change() {
    const active = document.activeElement;
    const keep = active?.form?.id === 'managerReportFiltersForm' ? { name: active.name, start: active.selectionStart, end: active.selectionEnd } : null;
    hooks?.onChange?.();
    if (keep) queueMicrotask(() => { const next = document.querySelector(`#managerReportFiltersForm [name=\"${keep.name}\"]`); if (next) { next.focus({ preventScroll: true }); if (typeof keep.start === 'number') next.setSelectionRange(keep.start, keep.end); } });
  }
  function readForm(form) { const fd = new FormData(form); const out = {}; ['q','periode','jenis','status','pengaju','start','end'].forEach(k => { const v = String(fd.get(k) || '').trim(); if (v) out[k] = v; }); return out; }
  async function load(direction = 'first') {
    cancelSearch();
    const id = syncOwner(); if (!id || !hooks?.api) return;
    const request = current, n = ++generation;
    if (controller) controller.abort(); controller = new AbortController(); request.loading = true; request.error = ''; change();
    const p = params(); p.set('limit', String(PAGE_SIZE));
    if (direction === 'after' && request.nextCursor) p.set('cursor', request.nextCursor);
    if (direction === 'before' && request.previousCursor) p.set('cursor', request.previousCursor);
    try {
      const result = await hooks.api(`/reports?${p}`, { signal: controller.signal });
      if (request !== current || n !== generation || owner() !== id) return;
      request.items = result.items || result.rows || []; request.total = Number(result.total || 0); request.hasMore = Boolean(result.hasMore); request.hasPrevious = Boolean(result.hasPrevious || result.previousCursor); request.nextCursor = result.nextCursor || ''; request.previousCursor = result.previousCursor || ''; request.label = result.filterDescription || 'Semua pengajuan'; request.loaded = true;
    } catch (error) { if (error?.name !== 'AbortError' && request === current && n === generation) request.error = error?.message || 'Laporan belum dapat dimuat. Coba lagi setelah terhubung.'; }
    finally { if (request === current && n === generation) { request.loading = false; change(); } }
  }
  function option(value, label, selected) { return `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(label)}</option>`; }
  function render() {
    if (!syncOwner()) return '';
    if (!current.loaded && !current.loading && !current.error) Promise.resolve().then(() => load());
    const f = current.draftFilters || current.filters, custom = f.periode === 'customWIB';
    const rows = current.loaded ? (current.items.length ? `<div class="list-stack manager-filtered-results" aria-label="Hasil laporan">${current.items.map(item => hooks.renderCard(item)).join('')}</div>` : '<div class="surface empty-state"><strong>Tidak ada laporan yang cocok</strong><span>Ubah filter atau rentang tanggal.</span></div>') : '<p class="field-help">Memuat daftar laporan dari server…</p>';
    return `<section class="manager-report-filters" aria-labelledby="managerReportsTitle" aria-busy="${current.loading}"><div class="section-row"><div><h2 id="managerReportsTitle">Laporan User &amp; Manager</h2><p>PDF mengikuti semua filter yang diterapkan; daftar dimuat bertahap untuk perangkat dengan memori rendah.</p></div></div><form id="managerReportFiltersForm"><fieldset><div class="report-filter-grid"><label class="report-filter-search">Pencarian<input name="q" type="search" maxlength="120" placeholder="Keterangan, catatan, atau pengaju" value="${esc(current.draftQ || f.q)}" autocomplete="off"></label><label>Periode<select name="periode">${[['','Seluruh periode'],['mingguini','Minggu ini'],['bulanini','Bulan ini'],['customWIB','Rentang khusus']].map(x => option(x[0],x[1],f.periode || '')).join('')}</select></label><label>Jenis<select name="jenis">${[['','Semua jenis'],['petty_cash','Petty Cash'],['finance_request','Request Finance']].map(x => option(x[0],x[1],f.jenis || '')).join('')}</select></label><label>Status<select name="status">${[['','Semua status'],['pending','Menunggu'],['approved','Disetujui'],['sent','Terkirim ke Finance'],['rejected','Ditolak']].map(x => option(x[0],x[1],f.status || '')).join('')}</select></label><label>Pengaju<input name="pengaju" maxlength="120" placeholder="Nama, email, atau ID" value="${esc(f.pengaju)}"></label><label>Dari (WIB)<input name="start" type="date" value="${esc(f.start)}" ${custom ? 'required' : 'disabled'}></label><label>Sampai (WIB)<input name="end" type="date" value="${esc(f.end)}" ${custom ? 'required' : 'disabled'}></label></div><div class="report-filter-actions"><button class="primary-button" type="submit">Terapkan filter</button><button class="secondary-button" type="button" data-manager-report-action="reset">Reset</button></div></fieldset></form><p class="field-help" role="status" aria-live="polite">${esc(current.loading ? 'Memuat laporan…' : current.label)}${current.loaded ? ` · ${current.items.length} dari ${current.total} laporan ditampilkan` : ''}</p>${current.error ? `<p class="inline-error" role="alert">${esc(current.error)}</p><button class="secondary-button" type="button" data-manager-report-action="retry">Coba lagi</button>` : ''}${rows}<nav class="report-pagination" aria-label="Navigasi laporan">${current.hasPrevious ? `<button class="secondary-button" type="button" ${current.loading ? 'disabled' : ''} data-manager-report-action="before">Sebelumnya</button>` : ''}${current.hasMore ? `<button class="secondary-button" type="button" ${current.loading ? 'disabled' : ''} data-manager-report-action="after">Berikutnya</button>` : ''}${current.hasPrevious ? `<button class="secondary-button" type="button" ${current.loading ? 'disabled' : ''} data-manager-report-action="reset-page">Kembali ke awal</button>` : ''}</nav></section>`;
  }
  function applyFilters(form, manual = true) {
    cancelSearch();
    if (manual ? !form.reportValidity() : form.checkValidity?.() === false) return;
    const filters = readForm(form);
    if (filters.start && filters.end && filters.start > filters.end) { if (manual) hooks?.onError?.('Tanggal awal tidak boleh melewati tanggal akhir.'); return; }
    current.filters = filters; current.draftFilters = { ...filters }; current.draftQ = filters.q || ''; current.loaded = false; current.items = []; current.nextCursor = ''; current.previousCursor = ''; load();
  }
  function bind() {
    if (bound) return; bound = true;
    document.addEventListener('change', event => { const t = event.target; if (t?.form?.id !== 'managerReportFiltersForm') return; if (t.name === 'periode') { const custom = t.value === 'customWIB'; ['start','end'].forEach(name => { const input = t.form.elements.namedItem(name); input.disabled = !custom; input.required = custom; }); } current.draftFilters = readForm(t.form); });
    document.addEventListener('input', event => { const t = event.target; if (t?.form?.id !== 'managerReportFiltersForm') return; current.draftFilters = readForm(t.form); if (t.name !== 'q') return; current.draftQ = t.value; cancelSearch(); const form = t.form, scheduledOwner = owner(); searchTimer = setTimeout(() => { searchTimer = null; if (owner() === scheduledOwner && form.isConnected !== false) applyFilters(form, false); }, 325); });
    document.addEventListener('submit', event => { if (event.target?.id !== 'managerReportFiltersForm') return; event.preventDefault(); applyFilters(event.target); });
    document.addEventListener('click', event => { const button = event.target.closest?.('[data-manager-report-action]'); if (!button || current.loading) return; const action = button.dataset.managerReportAction; if (action === 'reset') { current = fresh(owner()); load(); } else if (action === 'retry') load(); else if (action === 'after') load('after'); else if (action === 'before') load('before'); else if (action === 'reset-page') { current.nextCursor = ''; current.previousCursor = ''; load(); } });
  }
  function configure(options) { if (hooks) return; hooks = options; bind(); }
  window.ManagerReportFilters = { configure, render, pdfUrl, findItem(id) { return syncOwner() ? current.items.find(item => item.id === id) || null : null; }, clear() { cancelSearch(); controller?.abort(); controller = null; generation++; current = fresh(); }, refresh() { if (syncOwner() && current.loaded && !current.loading) load(); } };
})();
