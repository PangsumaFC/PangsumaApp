import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../site/mobile-polish.css', import.meta.url), 'utf8');

test('UI precision layer is versioned and loaded after product styles', () => {
  assert.match(index, /app-build" content="2026\.10\.18\.5/);
  assert.match(index, /mobile-polish\.css\?v=2026\.10\.18\.5/);
  assert.ok(index.indexOf('mobile-polish.css') > index.indexOf('pangsuma-theme.css'));
});

test('profile photo picker uses a visible native input and image wildcard', () => {
  assert.match(index, /label class="profile-photo-label" for="profilePhoto"/);
  assert.match(index, /id="profilePhoto"[^>]*accept="image\/\*"/);
  assert.doesNotMatch(index, /profile-photo-label[^>]*data-action="choose-profile-photo"/);
  assert.doesNotMatch(index, /id="profilePhoto"[^>]*class="sr-only"/);
  assert.match(css, /#profilePhoto::file-selector-button/);
});

test('UI precision preserves readable values and aligns threshold content', () => {
  assert.match(css, /\.cash-health-card\s*\{[^}]*grid-template-columns/);
  assert.match(css, /\.cash-health-threshold\s*\{[^}]*border-left/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /\.cash-health-threshold\s*\{[^}]*text-align:\s*left/);
});

test('responsive controls retain touch-safe dimensions without page clipping', () => {
  assert.match(css, /\.form-actions\s*>\s*button[^}]*min-width/);
  assert.match(css, /\.topbar\s*\{[^}]*align-items:\s*center/);
  assert.match(css, /\.item-amount\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
});

test('flat control pass removes bevels and keeps active navigation quiet', () => {
  assert.match(css, /\.primary-button\s*\{[^}]*border-color:\s*var\(--blue-deep/);
  assert.match(css, /\.install-button[\s\S]*?\.danger-button[\s\S]*?box-shadow:\s*none/);
  assert.match(css, /\.sidebar \.nav-button\[aria-current="page"\][\s\S]*?box-shadow:\s*none/);
});

test('manager cash actions fill narrow cards without overflow', () => {
  assert.match(css, /\.balance-actions\s*\{\s*min-width:\s*0/);
  assert.match(css, /\.balance-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  assert.match(css, /@media\s*\(max-width:\s*359px\)[\s\S]*?\.balance-actions\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.cash-health-threshold\s*\{\s*text-align:\s*left/);
});
