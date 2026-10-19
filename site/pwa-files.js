/* Pangsuma PWA file delivery. No PDF is rendered or persisted by this helper. */
(function (root) {
  'use strict';

  var active = null;
  var serial = 0;
  var hasDocument = typeof document !== 'undefined';

  function text(value) { return value == null ? '' : String(value); }
  function safeFilename(value) {
    var name = text(value || 'laporan.pdf').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-');
    if (!name) name = 'laporan.pdf';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    return name.slice(0, 180);
  }
  function sameOriginUrl(value) {
    try {
      var url = new URL(value, root.location && root.location.href || undefined);
      if (root.location && url.origin !== root.location.origin) return null;
      return url.href;
    } catch (_) { return null; }
  }
  function errorMessage(error) {
    return error && error.message ? error.message : 'PDF belum dapat disiapkan. Coba lagi.';
  }

  function isAndroidWebView() {
    // Confirmed interface in the supplied Pangsuma APK, including masked Chrome UAs.
    // Do not infer an APK from a browser's user-agent or installed PWA display mode.
    return !!root.PangsumaFileBridge;
  }
  function showApkDownloadStatus(options) {
    options = options || {};
    if (!hasDocument || (typeof options.isCurrent === 'function' && !options.isCurrent())) return null;
    if (active && typeof active.close === 'function') active.close();
    ++serial;
    var previousFocus = document.activeElement;
    var dialog = document.createElement('dialog');
    dialog.id = 'pwaPdfApkDialog'; dialog.className = 'pwa-files-modal';
    dialog.setAttribute('aria-labelledby', 'pwaPdfApkTitle');
    dialog.setAttribute('aria-describedby', 'pwaPdfApkStatus');
    var title = document.createElement('h2');
    title.id = 'pwaPdfApkTitle'; title.textContent = 'Unduh PDF';
    var status = document.createElement('p');
    status.id = 'pwaPdfApkStatus'; status.className = 'pwa-files-status'; status.setAttribute('role', 'status');
    status.textContent = 'Unduh PDF langsung memerlukan APK yang diperbarui.';
    var closeButton = document.createElement('button');
    closeButton.type = 'button'; closeButton.className = 'pwa-files-close'; closeButton.textContent = 'Tutup';
    dialog.append(title, status, closeButton);
    document.body.appendChild(dialog);
    var closed = false;
    function closeDialog() {
      if (closed) return;
      closed = true;
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      if (active && active.dialog === dialog) active = null;
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    }
    active = { dialog: dialog, close: closeDialog };
    closeButton.addEventListener('click', closeDialog);
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); closeDialog(); });
    dialog.showModal();
    return { close: closeDialog, dialog: dialog };
  }

  function prepare(options) {
    options = options || {};
    if (isAndroidWebView()) return Promise.resolve(showApkDownloadStatus(options));
    if (!hasDocument || typeof root.fetch !== 'function') {
      if (typeof options.onError === 'function') options.onError(new Error('Peramban tidak mendukung unduhan PDF.'));
      return Promise.resolve(null);
    }
    if (active && typeof active.close === 'function') active.close();
    var filename = safeFilename(options.filename);
    var directUrl = sameOriginUrl(options.url);
    if (!directUrl) {
      var invalid = new Error('Tautan PDF harus berasal dari aplikasi ini.');
      if (typeof options.onError === 'function') options.onError(invalid);
      return Promise.resolve(null);
    }
    var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var token = ++serial;
    var dialog = document.createElement('dialog');
    dialog.className = 'pwa-files-modal';
    dialog.id = 'pwaPdfDialog';
    dialog.setAttribute('aria-labelledby', 'pwa-files-title-' + token);
    dialog.setAttribute('aria-describedby', 'pwaPdfStatus');
    dialog.setAttribute('aria-modal', 'true');
    var title = document.createElement('h2');
    title.id = 'pwa-files-title-' + token;
    title.textContent = 'Simpan laporan PDF';
    var status = document.createElement('p');
    status.id = 'pwaPdfStatus';
    status.className = 'pwa-files-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Menyiapkan PDF…';
    var actions = document.createElement('div');
    actions.className = 'pwa-files-actions';
    var download = document.createElement('a');
    download.id = 'pwaPdfDownload';
    download.className = 'pwa-files-download';
    download.textContent = 'Simpan PDF';
    download.setAttribute('download', filename);
    download.setAttribute('aria-disabled', 'true');
    var retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'pwa-files-retry'; retry.textContent = 'Coba lagi'; retry.hidden = true;
    var closeButton = document.createElement('button');
    closeButton.type = 'button'; closeButton.className = 'pwa-files-close'; closeButton.textContent = 'Tutup';
    actions.append(download, retry, closeButton);
    dialog.append(title, status, actions);
    document.body.appendChild(dialog);

    var objectUrl = null;
    var blob = null;
    var closed = false;
    var lastFocus = document.activeElement;
    active = { dialog: dialog, abort: function () { if (controller) controller.abort(); }, close: close };
    function setStatus(message, isError) {
      status.textContent = message;
      status.classList.toggle('is-error', !!isError);
    }
    function restoreFocus() { if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus(); }
    function close() {
      if (closed) return;
      closed = true;
      if (controller) controller.abort();
      if (objectUrl && root.URL && typeof root.URL.revokeObjectURL === 'function') root.URL.revokeObjectURL(objectUrl);
      objectUrl = null; blob = null;
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      if (active && active.dialog === dialog) active = null;
      restoreFocus();
    }
    function showError(error) {
      if (closed) return;
      setStatus(errorMessage(error), true);
      retry.hidden = false;
      download.setAttribute('aria-disabled', 'true');
      if (typeof options.onError === 'function') options.onError(error);
    }
    function retryFetch(event) {
      if (event) event.preventDefault();
      retry.hidden = true;
      setStatus('Menyiapkan PDF…', false);
      load();
    }
    closeButton.addEventListener('click', close);
    retry.addEventListener('click', retryFetch);
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    function load() {
      if (closed) return;
      if (controller) controller.abort();
      controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      root.fetch(directUrl, { credentials: 'same-origin', cache: 'no-store', signal: controller && controller.signal })
        .then(function (response) {
          if (closed || token !== serial || (typeof options.isCurrent === 'function' && !options.isCurrent())) { close(); throw new Error('Sesi aplikasi berubah.'); }
          if (response.status === 401 || response.status === 403) {
            if (typeof options.onUnauthorized === 'function') options.onUnauthorized(response);
            throw new Error('Sesi berakhir. Silakan masuk kembali.');
          }
          if (!response.ok) throw new Error('Server tidak dapat membuat PDF (HTTP ' + response.status + ').');
          var type = (response.headers && response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
          if (type !== 'application/pdf') throw new Error('Server mengirim format yang bukan PDF.');
          return response.blob();
        })
        .then(function (value) {
          if (closed || token !== serial || (typeof options.isCurrent === 'function' && !options.isCurrent())) { close(); throw new Error('Sesi aplikasi berubah.'); }
          if (!value || !value.size) throw new Error('PDF kosong.');
          return value.arrayBuffer().then(function (bytes) {
            var header = new Uint8Array(bytes).slice(0, 5);
            if (String.fromCharCode.apply(null, header) !== '%PDF-') throw new Error('Isi respons bukan PDF yang valid.');
            return value;
          });
        })
        .then(function (value) {
          if (closed) return;
          blob = value;
          objectUrl = root.URL.createObjectURL(blob);
          download.href = objectUrl;
          download.removeAttribute('aria-disabled');
          setStatus('PDF siap. Pilih Simpan PDF untuk mengunduh berkas.', false);
        })
        .catch(function (error) { if (!closed && !(error && error.name === 'AbortError')) showError(error); });
    }
    dialog.showModal();
    load();
    return Promise.resolve({ close: close, dialog: dialog });
  }
  function cleanup() { close(); }
  function close() { if (active && typeof active.close === 'function') active.close(); }
  root.PwaFiles = { prepare: prepare, cleanup: cleanup, isAndroidWebView: isAndroidWebView, showApkDownloadStatus: showApkDownloadStatus };
})(typeof window !== 'undefined' ? window : globalThis);
