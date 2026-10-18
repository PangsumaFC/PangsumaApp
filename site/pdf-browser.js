/* Legacy bookmark: Finance is the only report-download workspace. */
(() => {
  'use strict';
  function isApkWrapper() { return Boolean(window.PangsumaFileBridge); }
  function init() {
    if (!isApkWrapper()) return;
    const instructions = document.getElementById('browserInstructions');
    if (instructions) instructions.hidden = true;
    const status = document.getElementById('sessionStatus');
    if (status) status.textContent = 'Unduh PDF langsung memerlukan APK yang diperbarui.';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();
