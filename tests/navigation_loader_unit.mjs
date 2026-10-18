import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../site/pangsuma-theme.css', import.meta.url), 'utf8');

function block(name, nextName) {
  const start = app.indexOf(`function ${name}`);
  const end = nextName ? app.indexOf(`function ${nextName}`, start) : app.length;
  assert.notEqual(start, -1, `${name} should exist`);
  return app.slice(start, end === -1 ? app.length : end);
}

test('preloader dismisses immediately without a timer or load gate', () => {
  const dismiss = block('hidePreloader', 'refreshOverview');
  assert.match(dismiss, /preloader\.hidden = true/);
  assert.doesNotMatch(dismiss, /setTimeout|addEventListener\(['"]load/);
  assert.doesNotMatch(css, /pangsuma-preloader[^\n]*transition:/);
});

test('initial session attempt always ends the preloader in finally', () => {
  const initialize = block('initialize');
  assert.match(initialize, /try \{/);
  assert.match(initialize, /await api\('\/session'\)/);
  assert.match(initialize, /finally \{[\s\S]*hidePreloader\(\)/);
});

test('menu navigation renders before any background refresh can block it', () => {
  const bindEvents = block('bindEvents');
  const navigation = bindEvents.slice(bindEvents.indexOf("closest('[data-page]')"), bindEvents.indexOf("closest('[data-action]')"));
  assert.match(navigation, /navigateToPage\(page\);/);
  assert.doesNotMatch(navigation, /await|refreshOverview/);
  const navigate = block('navigateToPage', 'handleNavigationPop');
  assert.match(navigate, /currentPage = page;/);
  assert.match(navigate, /renderApp\(\);/);
  assert.doesNotMatch(navigate, /await|refreshOverview|setTimeout/);
});

test('explicit API buttons expose a compact crest busy affordance', () => {
  const busy = block('setButtonBusy', 'friendlyError');
  assert.match(busy, /setAttribute\('aria-busy', 'true'\)/);
  assert.match(busy, /classList\.add\('is-busy'\)/);
  assert.match(css, /is-busy::before[\s\S]*pangsuma-icon-192\.png/);
});

const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../site/sw.js', import.meta.url), 'utf8');

test('loading displays only approved logo art without captions or controls', () => {
  const loader = html.slice(html.indexOf('  <div class="pangsuma-preloader"'), html.indexOf('  <a class="skip-link"'));
  assert.match(loader, /pangsuma-loading-logo\.png/);
  assert.match(loader, /pangsuma-loading-emblem\.png/);
  assert.doesNotMatch(loader, /<(?:button|p|h[1-6]|span|text)(?:\s|>)/);
  assert.match(loader, /aria-label="Memuat Pangsuma App"/);
  assert.doesNotMatch(css, /spinOuter|subtleFloat/);
  const logoRule = css.match(/\.pangsuma-loader-logo \{([^}]+)\}/)[1];
  assert.doesNotMatch(logoRule, /animation|transform/);
});

test('only light sweep rotates and emblem motion is subpixel with reduced-motion off switch', () => {
  assert.match(css, /loader-sweep[^\n]*animation: pangsumaSweep/);
  assert.match(css, /translateY\(-\.45px\) scale\(1\.003\)/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*loader-sweep, \.pangsuma-loader-emblem \{ animation: none !important/);
  assert.match(sw, /'\/pangsuma-loading-logo\.png'/);
  assert.match(sw, /'\/pangsuma-loading-emblem\.png'/);
});
