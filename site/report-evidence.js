/* Pangsuma report evidence helpers. Parent app owns auth, dialogs, and submission writes. */
(function (root) {
  'use strict';
  const MAX_INPUT = 10 * 1024 * 1024, MAX_PIXELS = 16 * 1000 * 1000, MAX_BYTES = 512 * 1024, MAX_DIM = 2048;
  const ACCEPTED = new Set(['image/jpeg', 'image/png']);
  const contexts = new Set(), formContexts = new WeakMap();
  let config = { getUser: () => null, api: null, notify: () => {}, newKey: () => root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}` };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const clampName = name => String(name || 'nota').replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 180) || 'nota';
  const apiCall = (path, options = {}) => typeof config.api === 'function' ? config.api(path, options) : Promise.reject(new Error('API belum tersedia.'));
  function userCanSee(submission) { const user = typeof config.getUser === 'function' ? config.getUser() : null; return !!(user && submission && (user.role === 'manager' || String(user.id) === String(submission.createdById ?? submission.createdBy ?? submission.ownerId ?? ''))); }
  function userCanUpload(submission) { const user = typeof config.getUser === 'function' ? config.getUser() : null; return !!(user && submission && String(user.id) === String(submission.createdById ?? submission.createdBy ?? submission.ownerId ?? '')); }
  function revoke(url) { if (url) try { URL.revokeObjectURL(url); } catch {} }
  function clearFileInput(input) { if (!input) return; try { input.value = ''; } catch {} if (input.files?.length) { const replacement = input.cloneNode(true); input.replaceWith(replacement); return replacement; } return input; }
  function cleanupContext(ctx) {
    if (!ctx || ctx.cleaned) return;
    ctx.cleaned = true; ctx.generation++; ctx.abort?.abort(); ctx.observer?.disconnect(); clearTimeout(ctx.pendingTimer); revoke(ctx.previewUrl); ctx.previewUrl = null;
    ctx.bitmap?.close?.(); ctx.bitmap = null; contexts.delete(ctx);
    if (ctx.closeHandler && ctx.dialog) ctx.dialog.removeEventListener('close', ctx.closeHandler);
    ctx.workspace?.remove(); if (ctx.container?._reportEvidenceContext === ctx) delete ctx.container._reportEvidenceContext;
  }
  function formatBytes(value) { return value < 1024 ? `${value} B` : `${Math.round(value / 1024)} KB`; }
  function receiptUrl(value) { const url = String(value || ''); return /^\/api\/receipts\/[a-zA-Z0-9-]+$/.test(url) ? url : ''; }
  function dropboxUrl(value) {
    const raw = String(value || ''); let url;
    try { url = new URL(raw); } catch { return ''; }
    if (url.protocol !== 'https:' || !['dropbox.com', 'www.dropbox.com'].includes(url.hostname) || url.username || url.password || url.hash) return '';
    const parts = url.pathname.split('/').filter(Boolean);
    if (!((parts[0] === 'scl' && parts[1] === 'fi' && parts.length === 4) || (parts[0] === 's' && parts.length === 3))) return '';
    return url.href;
  }
  async function sniffImageType(file) {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
    if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return 'image/png';
    return '';
  }
  function readDataUrl(file) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Foto tidak dapat dibaca.')); reader.readAsDataURL(file); });
  }
  async function imageDecoder(file) {
    if (typeof root.createImageBitmap === 'function') {
      try { return await root.createImageBitmap(file); } catch { /* Some gallery providers fail the bitmap path; still validate through Image below. */ }
    }
    const source = await readDataUrl(file);
    const img = new Image();
    if (typeof img.decode === 'function') {
      img.src = source;
      try { await img.decode(); return img; } catch { throw new Error('Foto tidak dapat dibaca. Pilih foto JPG atau PNG yang valid.'); }
    }
    return new Promise((resolve, reject) => { img.onload = () => resolve(img); img.onerror = () => reject(new Error('Foto tidak dapat dibaca.')); img.src = source; });
  }
  async function digest(bytes) { if (!root.crypto?.subtle) return Array.from(bytes).slice(0, 64).join('-'); const hash = await root.crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join(''); }
  function canvasBlob(image, mime, quality, width, height) { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const c = canvas.getContext('2d', { alpha: false }); c.fillStyle = '#fff'; c.fillRect(0, 0, width, height); c.drawImage(image, 0, 0, width, height); return new Promise(resolve => canvas.toBlob(resolve, mime, quality)); }
  async function normalizeImage(file) {
    if (!file || file.size > MAX_INPUT) throw new Error('Foto terlalu besar. Pilih foto hingga 10 MB.');
    const declared = String(file.type || '').toLowerCase(); if (declared === 'image/svg+xml' || declared === 'image/svg') throw new Error('Format SVG tidak didukung. Pilih foto JPG atau PNG.');
    const type = ACCEPTED.has(declared) ? declared : await sniffImageType(file); if (!ACCEPTED.has(type)) throw new Error('Pilih file JPG atau PNG.');
    const decodeFile = file.type === type ? file : file.slice(0, file.size, type);
    const image = await imageDecoder(decodeFile); const sourceWidth = Number(image.width || image.naturalWidth), sourceHeight = Number(image.height || image.naturalHeight);
    if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > MAX_PIXELS) { image.close?.(); throw new Error('Resolusi foto terlalu besar. Pilih foto hingga 16 megapiksel.'); }
    const scale = Math.min(1, MAX_DIM / Math.max(sourceWidth, sourceHeight)); let width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
    const outputMime = type === 'image/png' ? 'image/png' : 'image/jpeg'; let blob;
    try {
      blob = await canvasBlob(image, outputMime, outputMime === 'image/jpeg' ? .86 : undefined, width, height);
      if (!blob) throw new Error('Foto tidak dapat diproses.');
      if (blob.size > MAX_BYTES && outputMime === 'image/jpeg') for (const q of [.78, .68, .58, .48, .38]) { blob = await canvasBlob(image, outputMime, q, width, height); if (blob.size <= MAX_BYTES) break; }
      while (blob.size > MAX_BYTES && Math.max(width, height) > 800) { const factor = Math.max(.88, 800 / Math.max(width, height)); width = Math.max(1, Math.round(width * factor)); height = Math.max(1, Math.round(height * factor)); blob = await canvasBlob(image, outputMime, outputMime === 'image/jpeg' ? .7 : undefined, width, height); if (!blob) throw new Error('Foto tidak dapat diproses.'); }
    } finally { image.close?.(); }
    if (blob.size > MAX_BYTES) throw new Error('Foto belum cukup ringan. Pilih potongan/foto lebih jelas.'); const bytes = new Uint8Array(await blob.arrayBuffer());
    return { blob, bytes, mimeType: outputMime, width, height, sha256: await digest(bytes), filename: clampName(file.name).replace(/\.[^.]+$/, '') + (outputMime === 'image/png' ? '.png' : '.jpg') };
  }
  function readBase64(bytes) { let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); }
  function receiptMarkup(items) { if (!items.length) return '<p class="receipt-empty">Belum ada foto nota pada pengajuan ini.</p>'; return `<ul class="receipt-list">${items.map(item => { const url = receiptUrl(item.url); const shared = dropboxUrl(item.dropboxUrl); return url ? `<li class="receipt-item"><img loading="lazy" src="${esc(url)}" alt="Nota ${esc(item.filename || 'nota')}"><div class="receipt-item-info"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(item.filename || 'nota')}</a>${shared ? ` <a href="${esc(shared)}" target="_blank" rel="noopener noreferrer">Buka di Dropbox</a>` : ''}<span>${formatBytes(Number(item.sizeBytes) || 0)} · ${esc(item.actorName || item.uploadedByName || 'Pengguna')}</span></div></li>` : ''; }).join('')}</ul>`; }
  function updateReceiptControls(ctx) { const maxCount = Number(ctx.maxCount || 10), count = Number(ctx.itemCount ?? ctx.items.length); ctx.count.textContent = `${count}/${maxCount} foto`; const busy = ctx.processing || ctx.uploading; if (ctx.input) ctx.input.disabled = busy || count >= maxCount; if (ctx.file) { ctx.file.disabled = busy || !ctx.prepared; ctx.file.setAttribute('aria-busy', ctx.uploading ? 'true' : 'false'); } }
  async function loadReceipts(ctx) {
    const sequence = ++ctx.listSequence;
    ctx.listLoading = true;
    try {
      const result = await apiCall(`/submissions/${encodeURIComponent(ctx.submission.id)}/receipts`, { signal: ctx.abort.signal });
      if (ctx.cleaned || sequence !== ctx.listSequence) return true;
      ctx.items = Array.isArray(result?.items) ? result.items : [];
      ctx.maxCount = Number(result?.maxCount || 10);
      ctx.itemCount = Number(result?.count ?? ctx.items.length);
      ctx.list.innerHTML = receiptMarkup(ctx.items);
      updateReceiptControls(ctx);
      if (ctx.listStatus !== ctx.status || (!ctx.processing && !ctx.uploading)) ctx.listStatus.textContent = '';
      return true;
    } catch (error) {
      if (!ctx.cleaned && sequence === ctx.listSequence && error?.name !== 'AbortError') {
        ctx.listStatus.innerHTML = 'Lampiran belum dapat dimuat. <button type="button" class="receipt-retry">Coba lagi</button>';
      }
      return false;
    } finally {
      if (!ctx.cleaned && sequence === ctx.listSequence) ctx.listLoading = false;
    }
  }

  function mountReceipts(container, submission) {
    if (!container || !submission || !userCanSee(submission)) return null; const existing = container._reportEvidenceContext;
    if (existing && !existing.cleaned && existing.submission?.id === submission.id) { if (!existing.workspace.isConnected && container.isConnected) container.appendChild(existing.workspace); return { clear: () => cleanupContext(existing), context: existing }; }
    if (existing) cleanupContext(existing); const old = container.querySelector('.receipt-workspace'); if (old) old.remove();
    const owner = userCanUpload(submission); const workspace = document.createElement('section'); workspace.className = 'receipt-workspace'; workspace.innerHTML = `<div class="receipt-heading"><div><h3>Foto nota</h3><p>${owner ? 'Tambahkan foto nota asli untuk mendukung pengajuan.' : 'Foto bukti yang diunggah pemilik pengajuan.'}</p></div><span class="receipt-count" aria-live="polite">Memuat…</span></div>${owner ? `<div class="receipt-picker"><label class="receipt-file-label" for="receipt-file-${esc(submission.id)}">Pilih foto nota dari galeri atau kamera</label><input id="receipt-file-${esc(submission.id)}" class="receipt-file" type="file" accept="image/jpeg,image/png"><p class="receipt-dropbox-disclosure">Foto disimpan di Dropbox; siapa pun yang memiliki tautannya dapat melihatnya.</p><button type="button" class="receipt-upload" disabled aria-busy="false">Setuju &amp; unggah foto</button></div><p class="receipt-file-name" aria-live="polite"></p><img class="receipt-preview" alt="Pratinjau foto nota" hidden>` : ''}<p class="receipt-status" role="status" aria-live="polite"></p><p class="receipt-list-status" role="status" aria-live="polite"></p><div class="receipt-list-region"></div>`; container.appendChild(workspace);
    const ctx = { container, submission, workspace, input: workspace.querySelector('.receipt-file'), file: workspace.querySelector('.receipt-upload'), name: workspace.querySelector('.receipt-file-name'), preview: workspace.querySelector('.receipt-preview'), status: workspace.querySelector('.receipt-status'), count: workspace.querySelector('.receipt-count'), list: workspace.querySelector('.receipt-list-region'), generation: 0, listSequence: 0, listLoading: false, maxCount: 10, itemCount: 0, abort: new AbortController(), cleaned: false, previewUrl: null, prepared: null, uploadKey: null, processing: false, uploading: false };
    ctx.listStatus = workspace.querySelector('.receipt-list-status') || ctx.status;
    container._reportEvidenceContext = ctx; contexts.add(ctx);
    const prepare = async () => { if (!ctx.input || ctx.uploading) return; const file = ctx.input.files?.[0]; ctx.generation++; const generation = ctx.generation; ctx.prepared = null; ctx.uploadKey = null; ctx.processing = !!file; ctx.file.disabled = true; ctx.input.disabled = true; ctx.file.setAttribute('aria-busy', 'false'); revoke(ctx.previewUrl); ctx.previewUrl = null; ctx.preview.hidden = true; if (!file) { ctx.processing = false; ctx.name.textContent = ''; updateReceiptControls(ctx); return; } ctx.name.textContent = file.name; ctx.status.textContent = 'Memproses foto…'; try { const prepared = await normalizeImage(file); if (ctx.cleaned || generation !== ctx.generation) return; ctx.prepared = prepared; ctx.processing = false; ctx.previewUrl = URL.createObjectURL(prepared.blob); ctx.preview.src = ctx.previewUrl; ctx.preview.hidden = false; updateReceiptControls(ctx); ctx.status.textContent = `${prepared.width}×${prepared.height} · ${formatBytes(prepared.blob.size)}. Siap diunggah.`; } catch (e) { if (!ctx.cleaned && generation === ctx.generation) { ctx.processing = false; const oldInput = ctx.input; ctx.input = clearFileInput(oldInput); if (ctx.input !== oldInput) ctx.input.addEventListener('change', prepare); updateReceiptControls(ctx); ctx.status.textContent = e.message || 'Foto tidak dapat diproses.'; } } };
    if (ctx.input) ctx.input.addEventListener('change', prepare);
    workspace.addEventListener('click', event => { if (event.target.closest('.receipt-retry')) { event.preventDefault(); if (!ctx.listLoading) void loadReceipts(ctx); } });
    if (ctx.file) ctx.file.addEventListener('click', async e => { if (!ctx.prepared || ctx.uploading || ctx.processing) { e.preventDefault(); return; } ctx.uploading = true; const uploadToken = (ctx.uploadToken || 0) + 1; ctx.uploadToken = uploadToken; updateReceiptControls(ctx); ctx.status.textContent = 'Mengunggah foto…'; const generation = ctx.generation; ctx.uploadKey ||= String(config.newKey()); const payload = { filename: ctx.prepared.filename, mimeType: ctx.prepared.mimeType, dataBase64: readBase64(ctx.prepared.bytes), dropboxPublicConsent: true }; let committed = false; try { await apiCall(`/submissions/${encodeURIComponent(submission.id)}/receipts`, { method: 'POST', headers: { 'Idempotency-Key': ctx.uploadKey }, body: payload }); committed = true; if (ctx.cleaned || generation !== ctx.generation) return; ctx.status.textContent = 'Foto nota berhasil diunggah.'; ctx.itemCount = Math.min(ctx.maxCount, Number(ctx.itemCount || ctx.items.length) + 1); const oldInput = ctx.input; ctx.input = clearFileInput(oldInput); if (ctx.input !== oldInput) ctx.input.addEventListener('change', prepare); ctx.prepared = null; ctx.uploadKey = null; revoke(ctx.previewUrl); ctx.previewUrl = null; ctx.preview.hidden = true; if (!await loadReceipts(ctx)) { ctx.status.textContent = 'Foto nota berhasil diunggah. Daftar lampiran belum dapat diperbarui.'; } } catch (error) { if (!ctx.cleaned && generation === ctx.generation) ctx.status.innerHTML = committed ? 'Foto nota berhasil diunggah. Daftar lampiran belum dapat diperbarui. <button type="button" class="receipt-retry">Coba lagi</button>' : esc(error?.message || 'Foto belum berhasil diunggah. Coba lagi.'); } finally { if (!ctx.cleaned && ctx.uploadToken === uploadToken) { ctx.uploading = false; updateReceiptControls(ctx); } } });
    const dialog = container.closest('dialog'); if (dialog) { ctx.dialog = dialog; ctx.closeHandler = () => cleanupContext(ctx); dialog.addEventListener('close', ctx.closeHandler); }
    if (typeof MutationObserver !== 'undefined' && root.document?.body) { ctx.observer = new MutationObserver(() => { const body = ctx.container.ownerDocument?.body; if (ctx.container.isConnected === false || body?.isConnected === false) cleanupContext(ctx); }); ctx.observer.observe(root.document.body, { childList: true, subtree: true }); }
    loadReceipts(ctx); return { clear: () => cleanupContext(ctx), context: ctx };
  }
  function fields(form) { return { type: String(form.elements.type?.value || '').trim(), amountIdr: Number(String(form.elements.amountIdr?.value || '').replace(/[^0-9]/g, '')), date: String(form.elements.date?.value || '').trim(), description: String(form.elements.description?.value || '').trim().slice(0, 150) }; }
  function enoughForCheck(v) { return Boolean(v.type && Number.isFinite(v.amountIdr) && v.amountIdr > 0 && /^\d{4}-\d{2}-\d{2}$/.test(v.date) && v.description.length >= 3 && v.description.length <= 150); }
  function matchMarkup(matches) { return matches.slice(0, 5).map(m => `<li><strong>${esc(m.type || 'Pengajuan')}</strong><span>${esc(m.date || 'Tanggal tidak tersedia')} · Rp ${esc(Number(m.amountIdr || 0).toLocaleString('id-ID'))}</span><span>${esc(m.description || '')}${m.status ? ` · ${esc(m.status)}` : ''}</span></li>`).join(''); }
  function mountDuplicateCheck(form) { if (!form) return null; if (formContexts.has(form)) { const x = formContexts.get(form); if (!x.cleaned) return { clear: x.clear, context: x }; x.clear(); } const box = document.createElement('section'); box.className = 'duplicate-warning'; box.setAttribute('aria-live', 'polite'); box.hidden = true; form.appendChild(box); const ctx = { form, box, timer: null, abort: null, generation: 0, cleaned: false }; formContexts.set(form, ctx);
    const check = async () => { const value = fields(form), generation = ++ctx.generation, identity = typeof config.getUser === 'function' ? config.getUser() : null; ctx.abort?.abort(); if (!enoughForCheck(value)) { box.hidden = true; return; } if (root.navigator?.onLine === false) { box.hidden = false; box.textContent = 'Pemeriksaan duplikasi menunggu koneksi.'; return; } ctx.abort = new AbortController(); box.hidden = false; box.textContent = 'Memeriksa kemiripan…'; try { const result = await apiCall('/submissions/duplicate-check', { method: 'POST', body: { ...value, excludeId: form.dataset.submissionId || undefined }, signal: ctx.abort.signal }); const now = typeof config.getUser === 'function' ? config.getUser() : null; if (ctx.cleaned || generation !== ctx.generation || now?.id !== identity?.id || now?.role !== identity?.role || !form.isConnected) return; const matches = Array.isArray(result?.matches) ? result.matches : []; box.innerHTML = matches.length ? `<strong>Kemungkinan mirip—periksa kembali.</strong><p>Pengajuan tetap dapat dikirim.</p><ul>${matchMarkup(matches)}</ul>` : '<p>Tidak ditemukan kemiripan pada kandidat yang diperiksa.</p>'; } catch (e) { if (!ctx.cleaned && generation === ctx.generation && e?.name !== 'AbortError') { box.hidden = false; box.textContent = 'Pemeriksaan kemiripan belum tersedia; Anda tetap dapat mengirim.'; } } };
    const schedule = () => { clearTimeout(ctx.timer); ctx.timer = setTimeout(check, 350); }; ['input', 'change'].forEach(type => form.addEventListener(type, schedule)); ctx.clear = () => { ctx.cleaned = true; ctx.generation++; clearTimeout(ctx.timer); ctx.abort?.abort(); box.remove(); formContexts.delete(form); }; if (typeof form.isConnected !== 'boolean' || form.isConnected) check(); return { clear: ctx.clear, context: ctx }; }
  function hasPending(container) { for (const ctx of contexts) if (!container || ctx.container === container || ctx.container?.contains?.(ctx.workspace) || ctx.workspace?.contains?.(container)) if (!ctx.cleaned && (ctx.processing || ctx.uploading || ctx.prepared || (!ctx.processing && ctx.input?.files?.length))) return true; return false; }
  function isBusy(container) { for (const ctx of contexts) if (!container || ctx.container === container || ctx.container?.contains?.(ctx.workspace) || ctx.workspace?.contains?.(container)) if (!ctx.cleaned && (ctx.processing || ctx.uploading)) return true; return false; }
  function clear() { [...contexts].forEach(cleanupContext); document.querySelectorAll?.('.duplicate-warning').forEach(x => x.remove()); }
  function configure(next = {}) { config = { ...config, ...next }; }
  const apiObject = { configure, mountReceipts, mountDuplicateCheck, clear, hasPending, isBusy, normalizeImage, escapeHTML: esc, enoughForDuplicateCheck: enoughForCheck, validateDropboxUrl: dropboxUrl };
  if (root) root.ReportEvidence = apiObject; if (typeof module !== 'undefined' && module.exports) module.exports = apiObject;
})(typeof window !== 'undefined' ? window : globalThis);
