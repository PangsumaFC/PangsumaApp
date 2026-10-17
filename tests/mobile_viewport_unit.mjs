import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/mobile-viewport.js', import.meta.url), 'utf8');
function harness() {
  const frames = [], classes = new Map(), styles = new Map();
  const document = { activeElement: null, body: { dataset: {}, classList: { toggle: (key, value) => classes.set(key, value) } }, documentElement: { clientHeight: 844, style: { setProperty: (key, value) => styles.set(key, value) } }, addEventListener() {} };
  const window = { innerWidth: 390, innerHeight: 844, visualViewport: { height: 844, offsetTop: 0, scale: 1, addEventListener() {} }, addEventListener() {}, requestAnimationFrame: callback => { frames.push(callback); return frames.length; } };
  vm.runInNewContext(source, { window, document });
  frames.shift()();
  return { window, document, classes, styles, controls: window.MobileViewport };
}
test('only an editable focus and actual viewport loss opens keyboard mode', () => {
  const h = harness();
  h.window.visualViewport.height = 500;
  h.controls.measure();
  assert.equal(h.classes.get('keyboard-open'), false);
  h.document.activeElement = { tagName: 'INPUT', type: 'text' };
  h.controls.measure();
  assert.equal(h.classes.get('keyboard-open'), true);
  assert.equal(h.document.body.dataset.keyboardOpen, 'true');
  assert.equal(h.styles.get('--visual-viewport-height'), '500px');
  h.document.activeElement = null;
  h.controls.measure();
  assert.equal(h.classes.get('keyboard-open'), false);
});
test('pinch zoom and non-text controls never hide navigation as a keyboard', () => {
  const h = harness();
  h.window.visualViewport.height = 400;
  for (const type of ['checkbox', 'radio', 'file', 'button', 'range', 'color']) {
    h.document.activeElement = { tagName: 'INPUT', type };
    h.controls.measure();
    assert.equal(h.classes.get('keyboard-open'), false);
  }
  h.document.activeElement = { tagName: 'TEXTAREA' };
  h.window.visualViewport.scale = 2;
  h.controls.measure();
  assert.equal(h.classes.get('keyboard-open'), false);
});
test('orientation updates the baseline rather than mistaking landscape for keyboard loss', () => {
  const h = harness();
  h.document.activeElement = { tagName: 'INPUT', type: 'text' };
  h.window.innerWidth = 844;
  h.window.innerHeight = 390;
  h.document.documentElement.clientHeight = 390;
  h.window.visualViewport.height = 390;
  h.controls.measure();
  assert.equal(h.classes.get('keyboard-open'), false);
  assert.equal(h.styles.get('--visual-viewport-height'), '390px');
});
