'use strict';
// Installation is browser-controlled; never turn a shortcut into a false success.
(() => {
  const buttons = [...document.querySelectorAll('[data-pwa-install]')];
  const statuses = [...document.querySelectorAll('[data-pwa-install-status]')];
  const displayMode = window.matchMedia('(display-mode: standalone)');
  let pendingPrompt = null;
  let busy = false;
  let installed = false;
  let hasStatus = false;
  const standalone = () => installed || displayMode.matches || navigator.standalone === true;
  function sync() {
    for (const button of buttons) {
      button.hidden = standalone() || !pendingPrompt;
      button.disabled = busy;
    }
    for (const feedback of document.querySelectorAll('[data-pwa-install-feedback]')) feedback.hidden = standalone() || !hasStatus;
    for (const help of document.querySelectorAll('[data-pwa-install-help]')) help.hidden = standalone();
  }
  function status(message) {
    hasStatus = true;
    for (const element of statuses) element.textContent = message;
  }
  window.addEventListener('beforeinstallprompt', event => {
    if (standalone()) return;
    event.preventDefault();
    pendingPrompt = event;
    status('Pemasangan aplikasi tersedia. Tekan Pasang Pangsuma untuk membuka konfirmasi browser.');
    sync();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    pendingPrompt = null;
    status('Pangsuma sudah dipasang. Buka dari ikon aplikasi di layar utama.');
    sync();
  });
  displayMode.addEventListener?.('change', sync);
  for (const button of buttons) button.addEventListener('click', async () => {
    if (busy || standalone() || !pendingPrompt) return;
    const prompt = pendingPrompt;
    pendingPrompt = null; // A browser install event can only be used once.
    busy = true;
    sync();
    try {
      await prompt.prompt();
      const result = await prompt.userChoice;
      status(result.outcome === 'accepted'
        ? 'Permintaan pemasangan diterima browser. Tunggu hingga selesai, lalu buka ikon Pangsuma di layar utama.'
        : 'Pemasangan dibatalkan. Anda tetap dapat memakai aplikasi di browser; coba lagi saat pilihan Pasang tersedia.');
    } catch {
      status('Konfirmasi pemasangan belum dapat dibuka. Muat ulang lalu coba lagi, atau periksa pilihan Instal aplikasi di menu browser.');
    } finally {
      busy = false;
      sync();
    }
  });
  sync();
})();
