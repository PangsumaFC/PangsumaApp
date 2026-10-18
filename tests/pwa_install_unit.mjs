import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/pwa-install.js', import.meta.url), 'utf8');

function harness({ mediaStandalone = false, navigatorStandalone = false } = {}) {
  const windowListeners = new Map();
  const mediaListeners = new Map();
  const buttons = [button('login'), button('header')];
  const statuses = [element(), element()];
  const helps = [element()];
  const displayMode = {
    matches: mediaStandalone,
    addEventListener(type, listener) { mediaListeners.set(type, listener); },
  };
  const window = {
    matchMedia() { return displayMode; },
    addEventListener(type, listener) { windowListeners.set(type, listener); },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-pwa-install]') return buttons;
      if (selector === '[data-pwa-install-status]') return statuses;
      if (selector === '[data-pwa-install-help]') return helps;
      return [];
    },
  };
  const navigator = { standalone: navigatorStandalone };
  const context = { window, document, navigator, console };
  vm.runInNewContext(source, context, { filename: 'site/pwa-install.js' });
  return {
    window,
    navigator,
    buttons,
    statuses,
    helps,
    displayMode,
    windowListeners,
    mediaListeners,
    dispatch(type, event = {}) { return windowListeners.get(type)?.(event); },
    async click(button = buttons[0]) {
      const result = button.listeners.get('click')?.();
      await result;
    },
  };
}

function element() {
  const value = { hidden: false, disabled: false, textContent: '', listeners: new Map() };
  value.addEventListener = (type, listener) => value.listeners.set(type, listener);
  return value;
}
function button(name) {
  return { name, ...element() };
}
function promptEvent({ outcome = 'accepted', prompt = async () => {}, userChoice } = {}) {
  let prevented = false;
  return {
    prompt,
    userChoice: userChoice ?? Promise.resolve({ outcome }),
    preventDefault() { prevented = true; },
    get prevented() { return prevented; },
  };
}
function allText(h) { return h.statuses.map(status => status.textContent); }

 test('captures a pending prompt for login/header buttons, prevents default, and syncs visibility', () => {
  const h = harness();
  const event = promptEvent();
  h.dispatch('beforeinstallprompt', event);
  assert.equal(event.prevented, true);
  assert.deepEqual(h.buttons.map(button => [button.hidden, button.disabled]), [[false, false], [false, false]]);
  assert.deepEqual(allText(h), [
    'Pemasangan aplikasi tersedia. Tekan Pasang Pangsuma untuk membuka konfirmasi browser.',
    'Pemasangan aplikasi tersedia. Tekan Pasang Pangsuma untuk membuka konfirmasi browser.',
  ]);
  assert.equal(h.helps[0].hidden, false);
});

test('uses one pending event once and keeps the second button blocked while busy', async () => {
  const h = harness();
  let release;
  let promptCalls = 0;
  const event = promptEvent({ prompt: () => { promptCalls++; return new Promise(resolve => { release = resolve; }); } });
  h.dispatch('beforeinstallprompt', event);
  const firstClick = h.click(h.buttons[0]);
  assert.equal(h.buttons[0].disabled, true);
  assert.equal(h.buttons[1].disabled, true);
  await h.click(h.buttons[1]);
  assert.equal(promptCalls, 1);
  release();
  await firstClick;
  assert.equal(h.buttons[0].disabled, false);
  assert.equal(h.buttons[1].disabled, false);
  assert.match(h.statuses[0].textContent, /Permintaan pemasangan diterima browser/);
});

test('reports accepted and dismissed user choices', async () => {
  for (const outcome of ['accepted', 'dismissed']) {
    const h = harness();
    h.dispatch('beforeinstallprompt', promptEvent({ outcome }));
    await h.click();
    assert.equal(h.statuses[0].textContent, outcome === 'accepted'
      ? 'Permintaan pemasangan diterima browser. Tunggu hingga selesai, lalu buka ikon Pangsuma di layar utama.'
      : 'Pemasangan dibatalkan. Anda tetap dapat memakai aplikasi di browser; coba lagi saat pilihan Pasang tersedia.');
  }
});

test('handles prompt throws and userChoice rejection, then accepts a fresh event after either error', async () => {
  for (const failure of ['prompt', 'choice']) {
    const h = harness();
    const first = failure === 'prompt'
      ? promptEvent({ prompt: () => { throw new Error('prompt failed'); } })
      : promptEvent({ userChoice: Promise.reject(new Error('choice failed')) });
    h.dispatch('beforeinstallprompt', first);
    await h.click();
    assert.match(h.statuses[0].textContent, /Konfirmasi pemasangan belum dapat dibuka/);
    const fresh = promptEvent({ outcome: 'accepted' });
    h.dispatch('beforeinstallprompt', fresh);
    assert.equal(fresh.prevented, true);
    await h.click(h.buttons[1]);
    assert.match(h.statuses[0].textContent, /Permintaan pemasangan diterima browser/);
  }
});

test('marks the app installed and hides buttons/help after appinstalled', () => {
  const h = harness();
  h.dispatch('beforeinstallprompt', promptEvent());
  h.dispatch('appinstalled');
  assert.deepEqual(h.buttons.map(button => [button.hidden, button.disabled]), [[true, false], [true, false]]);
  assert.equal(h.helps[0].hidden, true);
  assert.equal(h.statuses[0].textContent, 'Pangsuma sudah dipasang. Buka dari ikon aplikasi di layar utama.');
});

test('does not capture prompts and stays hidden in media or navigator standalone mode', () => {
  for (const options of [{ mediaStandalone: true }, { navigatorStandalone: true }]) {
    const h = harness(options);
    const event = promptEvent();
    h.dispatch('beforeinstallprompt', event);
    assert.equal(event.prevented, false);
    assert.deepEqual(h.buttons.map(button => button.hidden), [true, true]);
    assert.equal(h.helps[0].hidden, true);
  }
});

test('reacts to display-mode changes and appinstalled while a prompt is pending', () => {
  const h = harness();
  h.dispatch('beforeinstallprompt', promptEvent());
  h.displayMode.matches = true;
  h.mediaListeners.get('change')();
  assert.deepEqual(h.buttons.map(button => button.hidden), [true, true]);
  assert.equal(h.helps[0].hidden, true);
});
