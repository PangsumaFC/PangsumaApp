import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../site/pangsuma-theme.css', import.meta.url), 'utf8');

test('password header is one native icon-only action with an Indonesian accessible name', () => {
  const controls = html.match(/<button[^>]*class="[^"]*account-password-button[^\"]*"[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.equal(controls.length, 1);
  const button = controls[0];
  assert.match(button, /type="button"/);
  assert.match(button, /data-page="change-password"/);
  assert.match(button, /aria-label="Ganti kata sandi"/);
  assert.match(button, /title="Ganti kata sandi"/);
  assert.match(button, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.doesNotMatch(button, /<span|tabindex="-1"/);
  assert.doesNotMatch(html + css, /account-password-label/);
});

test('shared header icons have a non-shrinking 44px target and visible keyboard focus', () => {
  const rule = css.match(/\.account-icon-button\s*\{([^}]+)\}/)?.[1] || '';
  for (const property of ['width', 'min-width', 'height', 'min-height']) {
    assert.match(rule, new RegExp(`(?:^|;)\\s*${property}:\\s*44px`));
  }
  assert.match(rule, /flex:\s*none/);
  assert.match(rule, /place-items:\s*center/);
  assert.match(css, /button:focus-visible[^}]*outline:\s*3px solid var\(--blue-deep\)/);
  assert.doesNotMatch(css, /account-password-button\.is-manager/);
});
