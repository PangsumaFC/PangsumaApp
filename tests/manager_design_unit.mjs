import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../site/pangsuma-theme.css', import.meta.url), 'utf8');

test('manager navigation keeps overview approvals finance only', () => {
  const managerNav = app.match(/manager:\s*\[([\s\S]*?)\n  \],\n  user:/)?.[1] || '';
  assert.match(managerNav, /id: 'overview'/);
  assert.match(managerNav, /id: 'approvals'/);
  assert.match(managerNav, /id: 'finance'/);
  assert.doesNotMatch(managerNav, /id: 'users'/);
});

test('header retains accessible users and password page selectors', () => {
  assert.match(html, /account-users-button[^>]+data-page="users"/);
  assert.match(html, /account-password-button[^>]+data-page="change-password"/);
  assert.match(html, /aria-label="Ganti password"/);
  assert.match(html, /account-password-button[^>]*account-icon-button/);
});

test('manager mobile nav is evenly arranged in three columns and controls focus', () => {
  assert.match(css, /\.mobile-nav\.is-manager\s*\{\s*grid-template-columns:\s*repeat\(3,/);
  assert.match(css, /button:disabled\s*\{[^}]*opacity:/s);
  assert.match(css, /\.primary-button:focus-visible/);
});

test('dashboard omits duplicate team settings and global controls do not add a competing bevel', () => {
  assert.doesNotMatch(app, /Pengaturan profil tim/);
  assert.match(css, /button:not\(:disabled\)\s*\{[^}]*box-shadow:\s*none/);
});
