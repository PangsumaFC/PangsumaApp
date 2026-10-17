(() => {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  let frame = 0, baseline = 0, lastWidth = 0;
  function editable(element) {
    if (!element || element.disabled || element.readOnly) return false;
    if (element.isContentEditable) return true;
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    return tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'hidden'].includes(element.type);
  }
  function computeKeyboard({ referenceHeight, visibleHeight, offsetTop = 0, scale = 1, focused = false }) {
    return focused && Math.abs(scale - 1) < 0.05 && referenceHeight - visibleHeight - offsetTop > 120;
  }
  function measure() {
    frame = 0;
    if (!document.body) return;
    const viewport = window.visualViewport;
    const width = window.innerWidth;
    const layoutHeight = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
    const visibleHeight = viewport?.height || window.innerHeight || layoutHeight;
    const focused = editable(document.activeElement);
    if (!baseline || Math.abs(width - lastWidth) > 80) baseline = layoutHeight;
    if (!focused) baseline = layoutHeight;
    lastWidth = width;
    const open = computeKeyboard({ referenceHeight: Math.max(layoutHeight, baseline), visibleHeight, offsetTop: viewport?.offsetTop || 0, scale: viewport?.scale || 1, focused });
    document.body.classList.toggle('keyboard-open', open);
    document.body.dataset.keyboardOpen = String(open);
    document.documentElement.style.setProperty('--visual-viewport-height', `${Math.round(visibleHeight)}px`);
  }
  function schedule() { if (!frame) frame = window.requestAnimationFrame(measure); }
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', () => { baseline = 0; schedule(); }, { passive: true });
  window.addEventListener('pageshow', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule, { passive: true });
  window.visualViewport?.addEventListener('scroll', schedule, { passive: true });
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  document.addEventListener('visibilitychange', schedule);
  window.MobileViewport = Object.freeze({ measure, computeKeyboard });
  schedule();
})();
