import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../site/mobile-polish.css', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');

function has(pattern, message) {
  assert.match(css, pattern, message);
}

test('mobile polish is an isolated late-loaded layer and targets real app surfaces', () => {
  assert.ok(css.length > 2000);
  assert.match(css, /\.mobile-nav/);
  assert.match(css, /\.mobile-add/);
  assert.match(css, /\.app-dialog/);
  assert.match(css, /\.dialog-panel/);
  assert.match(css, /\.table-wrap/);
  assert.match(css, /\.item-amount/);
  assert.match(css, /\.form-actions/);
  assert.match(index, /viewport-fit=cover/, 'the existing viewport supports safe-area insets');
});

test('safe-area and Android gesture navigation protect every edge and the dock', () => {
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    has(new RegExp(`safe-area-inset-${edge}`), `safe-area ${edge} inset is covered`);
  }
  has(/--mp-content-bottom:[^;]*safe-area-inset-bottom/);
  has(/\.mobile-nav[\s\S]*padding-bottom:[^;]*safe-area-inset-bottom/);
  has(/main[\s\S]*padding-bottom:[^;]*var\(--mp-content-bottom\)/);
  has(/height:\s*100dvh/);
});

test('keyboard hook removes fixed/raised navigation and leaves a flow-safe content bottom', () => {
  has(/body\.keyboard-open[\s\S]*\.mobile-nav[\s\S]*display:\s*none/);
  has(/body\[data-keyboard-open="true"\][\s\S]*\.mobile-nav[\s\S]*display:\s*none/);
  has(/keyboard-open[\s\S]*padding-bottom:\s*max\(24px/);
  has(/\.mobile-add[\s\S]*visibility:\s*hidden/);
  assert.doesNotMatch(css, /\.mobile-nav\s*\{[^}]*position:\s*fixed/);
});

test('dialogs and tables remain bounded internal scroll regions', () => {
  has(/dialog\.report-choice, dialog\.app-dialog[\s\S]*max-height:\s*min\(90dvh/);
  has(/dialog\.report-choice, dialog\.app-dialog[\s\S]*overflow:\s*auto/);
  has(/dialog\.report-choice, dialog\.app-dialog[\s\S]*overscroll-behavior:\s*contain/);
  has(/\.dialog-actions[\s\S]*position:\s*sticky/);
  has(/\.table-wrap[\s\S]*overflow-x:\s*auto/);
  assert.doesNotMatch(css, /body\s*\{[^}]*overflow-x\s*:\s*auto/);
});

test('narrow portrait and short landscape layouts wrap rather than clip actions or money', () => {
  has(/@media\s*\(max-width:\s*390px\)/);
  has(/@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*520px\)/);
  has(/\.item-amount[\s\S]*overflow-wrap:\s*anywhere/);
  has(/\.item-amount[\s\S]*white-space:\s*normal/);
  has(/\.form-actions[\s\S]*align-items:\s*stretch/);
  has(/\.dialog-actions[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test('focus, touch, status, loading, and reduced-motion requirements are explicit', () => {
  has(/min-height:\s*44px/);
  has(/outline:\s*2px\s+solid\s+var\(--mp-focus\)/);
  has(/\.status, \.login-error, \.field-error/);
  has(/button:disabled[\s\S]*opacity:\s*\.65/);
  has(/prefers-reduced-motion:\s*reduce/);
  has(/\.pangsuma-loader-ring, \.pangsuma-loader-emblem, \.is-busy::before[\s\S]*animation:\s*none/);
  assert.ok((css.match(/!important/g) || []).length <= 6, 'important is reserved for motion reset');
});
