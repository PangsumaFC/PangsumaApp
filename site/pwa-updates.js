/* Pangsuma PWA update coordination. No automatic reload; callers own draft/transaction policy. */
const BUILD_RE = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

export function isNewerBuild(candidate, current) {
  const next = String(candidate || '');
  const installed = String(current || '');
  return BUILD_RE.test(next) && BUILD_RE.test(installed)
    ? next.localeCompare(installed, 'en', { numeric: true }) > 0
    : false;
}

export function createPwaUpdateCoordinator(options = {}) {
  const win = options.window || globalThis.window;
  const doc = options.document || globalThis.document;
  const nav = options.navigator || globalThis.navigator || {};
  const currentBuild = String(options.currentBuild || '');
  const fetchVersion = options.fetchVersion || (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await (options.fetch || globalThis.fetch)(`/version.json?check=${Date.now()}`, {
        cache: 'no-store', credentials: 'same-origin', headers: { 'Cache-Control': 'no-cache' }, signal: abort.signal,
      });
      if (!response.ok) throw new Error(`version request failed: ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  });
  const getRegistration = options.getRegistration || (async () => nav.serviceWorker?.getRegistration?.());
  const setAvailable = options.setAvailable || (() => {});
  const isBlocked = options.isBlocked || (() => false);
  const onError = options.onError || (() => {});
  let availableBuild = '';
  let checking = null;
  let reloading = null;
  let lastError = null;
  let bound = false;

  function publish(build) {
    const next = isNewerBuild(build, currentBuild) ? String(build) : '';
    if (next === availableBuild) return next;
    availableBuild = next;
    setAvailable(next, currentBuild);
    return next;
  }

  function check({ force = false } = {}) {
    if (checking) return checking;
    if (!force && (doc?.hidden || nav.onLine === false)) return Promise.resolve(Boolean(availableBuild));
    checking = Promise.resolve().then(async () => {
      try {
        lastError = null;
        const payload = await fetchVersion();
        const build = payload?.build ?? payload?.version;
        if (!BUILD_RE.test(String(build || ''))) throw new Error('Metadata versi tidak valid.');
        publish(build);
        return Boolean(availableBuild);
      } catch (error) {
        lastError = error;
        onError(error);
        return false;
      } finally {
        checking = null;
      }
    });
    return checking;
  }

  async function checkRegistration(registration) {
    try {
      const result = registration?.update?.();
      if (result && typeof result.then === 'function') await result;
    } catch (error) {
      onError(error);
    }
    return check();
  }

  async function reload() {
    if (reloading) return reloading;
    if (isBlocked()) return false;
    reloading = (async () => {
      try {
        const registration = await getRegistration();
        // update() checks the script; a newly installing worker can still be pending.
        if (registration?.update) await registration.update();
        const worker = registration?.installing || registration?.waiting;
        if (worker && worker.state !== 'activated' && worker.state !== 'redundant') {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error('Pembaruan masih disiapkan. Coba muat ulang kembali.')); }, 10000);
            function changed() {
              if (worker.state === 'activated' || worker.state === 'redundant') {
                clearTimeout(timer); worker.removeEventListener('statechange', changed);
                worker.state === 'activated' ? resolve() : reject(new Error('Pembaruan belum aktif. Coba lagi.'));
              }
            }
            worker.addEventListener('statechange', changed); changed();
          });
        }
        if (isBlocked()) return false;
        win?.location?.reload?.();
        return true;
      } catch (error) {
        onError(error);
        return false;
      } finally {
        reloading = null;
      }
    })();
    return reloading;
  }

  function onMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object') return;
    const build = data.build ?? data.version ?? data.appBuild ?? data?.payload?.build;
    if (build) publish(build);
  }
  function onControllerChange() { check(); }
  function onSignal() { if (!doc?.hidden && nav.onLine !== false) check(); }

  function bind() {
    if (bound) return api;
    bound = true;
    win?.addEventListener?.('focus', onSignal);
    win?.addEventListener?.('pageshow', onSignal);
    win?.addEventListener?.('online', onSignal);
    doc?.addEventListener?.('visibilitychange', onSignal);
    nav.serviceWorker?.addEventListener?.('message', onMessage);
    nav.serviceWorker?.addEventListener?.('controllerchange', onControllerChange);
    return api;
  }
  function unbind() {
    if (!bound) return api;
    bound = false;
    win?.removeEventListener?.('focus', onSignal);
    win?.removeEventListener?.('pageshow', onSignal);
    win?.removeEventListener?.('online', onSignal);
    doc?.removeEventListener?.('visibilitychange', onSignal);
    nav.serviceWorker?.removeEventListener?.('message', onMessage);
    nav.serviceWorker?.removeEventListener?.('controllerchange', onControllerChange);
    return api;
  }
  const api = {
    bind, unbind, check, checkRegistration, reload,
    get availableBuild() { return availableBuild; },
    get lastError() { return lastError; },
    get checking() { return Boolean(checking); },
    get reloading() { return Boolean(reloading); },
  };
  return api;
}

if (typeof globalThis !== 'undefined') globalThis.PangsumaPwaUpdates = { isNewerBuild, createPwaUpdateCoordinator };
