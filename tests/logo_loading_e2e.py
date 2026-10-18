"""Offline browser regression: static site + intercepted APIs, never production."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:8799'
OUT = Path('/workspace/pangsuma-logo-loading-evidence')
OUT.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for motion in ('no-preference', 'reduce'):
        context = browser.new_context(viewport={'width': 390, 'height': 844}, reduced_motion=motion, service_workers='block')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        held = []
        page.route('**/api/**', lambda r: r.fulfill(status=200, content_type='application/json', body='{"enabled":false}'))
        page.route('**/api/session', lambda r: held.append(r))
        page.goto(BASE, wait_until='domcontentloaded')
        page.wait_for_function('document.querySelector(".pangsuma-loader-logo").complete')
        expect(page.locator('#pangsuma-preloader')).to_be_visible()
        data = page.locator('#pangsuma-preloader').evaluate('''el => ({
          text: el.textContent.trim(), controls: el.querySelectorAll('button,input,a').length,
          logo: getComputedStyle(el.querySelector('.pangsuma-loader-logo')).animationName,
          sweep: getComputedStyle(el.querySelector('.pangsuma-loader-sweep')).animationName,
          emblem: getComputedStyle(el.querySelector('.pangsuma-loader-emblem')).animationName,
          loaded: [...el.querySelectorAll('img')].every(i => i.complete && i.naturalWidth > 0)
        })''')
        assert data['text'] == '' and data['controls'] == 0 and data['loaded'], data
        assert data['logo'] == 'none', data
        assert data['sweep'] == ('none' if motion == 'reduce' else 'pangsumaSweep'), data
        assert data['emblem'] == ('none' if motion == 'reduce' else 'pangsumaBreathe'), data
        page.screenshot(path=str(OUT / f'loader-{motion}.png'))
        page.wait_for_function('document.body.getAttribute("aria-busy") === "true"')
        assert held
        held.pop().fulfill(status=401, content_type='application/json', body='{"error":{"code":"unauthorized"}}')
        expect(page.locator('#pangsuma-preloader')).to_be_hidden()
        page.evaluate('''() => {
          state.user = {id:'test', role:'manager', name:'Local test', nickname:'Test', mustChangePassword:false};
          currentPage='approvals'; renderApp();
        }''')
        pending = []
        page.route('**/api/overview', lambda r: pending.append(r))
        page.evaluate("void fetch('/api/overview')")
        page.wait_for_timeout(40)
        assert pending
        result = page.evaluate('''() => {
          const start=performance.now();
          document.querySelector('[data-page="finance"]').click();
          return {ms:performance.now()-start, hidden:document.querySelector('#pangsuma-preloader').hidden, heading:document.querySelector('#appContent h1').textContent};
        }''')
        assert result['hidden'] and result['ms'] < 200 and result['heading'] == 'Finance', result
        pending.pop().fulfill(status=503, body='{}')
        page.route('**/api/session', lambda r: r.fulfill(status=503, content_type='application/json', body='{}'))
        page.reload(wait_until='networkidle')
        expect(page.locator('#pangsuma-preloader')).to_be_hidden()
        assert not errors, errors
        print(json.dumps({'motion':motion, 'art':data, 'navigation':result, 'server_error_dismissed':True}))
        context.close()
    browser.close()
print('LOGO_LOADING_E2E_PASS')
