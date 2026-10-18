/* Secure PDF browser handoff; no session or token is persisted here. */
(() => {
  'use strict';
  const ALLOWED = ['q', 'periode', 'jenis', 'status', 'pengaju', 'start', 'end'];
  const LABELS = { q: 'Pencarian', periode: 'Periode', jenis: 'Jenis', status: 'Status', pengaju: 'Pengaju', start: 'Dari (WIB)', end: 'Sampai (WIB)' };
  let generation = 0;
  let checking = false;
  let lastLifecycleCheck = 0;

  function elements() {
    return {
      list: document.getElementById('filterList'), button: document.getElementById('checkSession'),
      link: document.getElementById('downloadPdf'), status: document.getElementById('sessionStatus'),
      wrapper: document.getElementById('wrapperHandoff'), canonical: document.getElementById('canonicalUrl'),
      copy: document.getElementById('copyCanonicalUrl')
    };
  }
  function appliedFilters() {
    const source = new URLSearchParams(window.location.search);
    const result = new URLSearchParams();
    ALLOWED.forEach(key => { if (source.has(key)) result.set(key, source.get(key)); });
    return result;
  }
  function exportUrl() {
    const query = appliedFilters().toString();
    return `/api/export.pdf${query ? `?${query}` : ''}`;
  }
  function canonicalUrl() {
    const query = appliedFilters().toString();
    return `${window.location.origin}/pdf-browser.html${query ? `?${query}` : ''}`;
  }
  function isApkWrapper() {
    const ua = typeof navigator === 'object' && navigator ? navigator.userAgent || '' : '';
    return Boolean(window.PangsumaFileBridge) || (/Android/i.test(ua) && /(\bwv\b|Version\/4(?:\.0)?\s+Chrome)/i.test(ua));
  }
  function renderFilters() {
    const { list } = elements();
    if (!list) return;
    list.replaceChildren();
    const filters = appliedFilters();
    if (!filters.size) {
      const item = document.createElement('li'); item.textContent = 'Seluruh periode · semua pengajuan'; list.appendChild(item);
    }
    filters.forEach((value, key) => {
      const item = document.createElement('li'); item.textContent = `${LABELS[key]}: ${value}`; list.appendChild(item);
    });
  }
  function disableDownload() {
    const { link } = elements();
    if (!link) return;
    link.hidden = true; link.href = ''; link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true');
  }
  function setStatus(message, state = '') {
    const { status } = elements();
    if (!status) return;
    status.textContent = message;
    if (state) status.dataset.state = state; else status.removeAttribute('data-state');
  }
  function showWrapperHandoff() {
    const { wrapper, canonical } = elements();
    if (wrapper) wrapper.hidden = false;
    if (canonical) canonical.value = canonicalUrl();
  }
  function enableDownload() {
    if (isApkWrapper()) { disableDownload(); showWrapperHandoff(); return; }
    const { link } = elements();
    if (!link) return;
    link.href = exportUrl(); link.setAttribute('href', link.href); link.hidden = false; link.setAttribute('aria-disabled', 'false');
  }
  async function copyCanonicalUrl() {
    const { canonical } = elements();
    const value = canonicalUrl();
    if (canonical) { canonical.value = value; canonical.focus?.(); canonical.select?.(); }
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('unsupported');
      await navigator.clipboard.writeText(value);
      setStatus('Tautan berhasil disalin. Tempel di Chrome atau browser lain.', 'success');
    } catch (_) {
      if (canonical) { canonical.focus?.(); canonical.select?.(); }
      setStatus('Tidak dapat menyalin otomatis. Pilih tautan di atas, salin manual, lalu tempel di Chrome atau browser lain.', 'error');
    }
  }
  async function checkSession() {
    const requestGeneration = ++generation;
    const { button } = elements();
    checking = true; disableDownload(); if (button) button.disabled = true;
    setStatus('Memeriksa sesi Manager…');
    try {
      const response = await fetch('/api/session', { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      let payload = null; try { payload = await response.json(); } catch (_) { payload = null; }
      if (requestGeneration !== generation) return;
      const user = payload?.user;
      if (response.status === 401) setStatus('Belum login di browser ini. Buka link login, lalu periksa sesi lagi.', 'error');
      else if (response.status === 403 || !response.ok) setStatus(response.status === 403 ? 'Sesi ini tidak memiliki akses Manager.' : 'Sesi belum dapat diverifikasi. Coba lagi.', 'error');
      else if (!user || user.role !== 'manager') setStatus('Sesi terdeteksi, tetapi akun ini bukan Manager.', 'error');
      else if (user.mustChangePassword === true) setStatus('Selesaikan ganti password dari halaman utama sebelum mengunduh PDF.', 'error');
      else if (isApkWrapper()) { showWrapperHandoff(); setStatus('Halaman masih di APK. Salin tautan lalu tempel di Chrome atau browser lain.', 'error'); }
      else { enableDownload(); setStatus('Sesi Manager terverifikasi. Pilih Unduh PDF untuk membuat laporan.', 'success'); }
    } catch (_) { if (requestGeneration === generation) setStatus('Sesi belum dapat diperiksa karena jaringan. Coba lagi.', 'error'); }
    finally { if (requestGeneration === generation) { checking = false; if (button) button.disabled = false; } }
  }
  function lifecycleCheck() { const now = Date.now(); if (!checking && now - lastLifecycleCheck > 250) { lastLifecycleCheck = now; checkSession(); } }
  function init() {
    renderFilters();
    const { button, copy, wrapper, canonical } = elements();
    if (isApkWrapper() && wrapper) { wrapper.hidden = false; if (canonical) canonical.value = canonicalUrl(); }
    button?.addEventListener('click', checkSession); copy?.addEventListener('click', copyCanonicalUrl);
    window.addEventListener('pageshow', lifecycleCheck); window.addEventListener('focus', lifecycleCheck);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') lifecycleCheck(); });
    checkSession();
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  }
  if (typeof window !== 'undefined') window.PdfBrowser = { appliedFilters, exportUrl, canonicalUrl, isApkWrapper, checkSession, copyCanonicalUrl };
})();
