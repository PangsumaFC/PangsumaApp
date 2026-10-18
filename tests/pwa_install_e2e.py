"""Offline Chromium responsive + simulated installation lifecycle; not physical Android."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('PWA_INSTALL_TEST_URL', 'http://127.0.0.1:8801')
OUT = Path('/workspace/pangsuma-pwa-install-evidence')
OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for standalone in (False, True):
        context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
        if standalone:
            context.add_init_script("const original=window.matchMedia.bind(window);window.matchMedia=q=>q==='(display-mode: standalone)'?{matches:true,addEventListener(){}}:original(q);")
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/api/**', lambda r: r.fulfill(status=200, content_type='application/json', body='{"enabled":false}'))
        page.route('**/api/session', lambda r: r.fulfill(status=401, content_type='application/json', body='{"error":"Unauthorized"}'))
        page.goto(BASE, wait_until='networkidle')
        expect(page.locator('#loginGate')).to_be_visible()
        expect(page.locator('#pangsuma-preloader')).to_be_hidden()
        expect(page.locator('#loginInstallButton')).to_be_hidden()
        def event(outcome='dismissed', throws=False):
            return page.evaluate('''({outcome,throws})=>{window.__promptCalls=0;const e=new Event('beforeinstallprompt',{cancelable:true}); e.prompt=()=>{window.__promptCalls++;if(throws)throw Error('unavailable');return Promise.resolve()};e.userChoice=Promise.resolve({outcome});window.dispatchEvent(e);return e.defaultPrevented}''', {'outcome': outcome, 'throws': throws})
        if standalone:
            assert event() is False
            expect(page.locator('[data-pwa-install-help]')).to_be_hidden()
            expect(page.locator('#loginInstallButton')).to_be_hidden()
            print('STANDALONE_PASS no_install_cta=1')
        else:
            for width in (320, 360, 390, 760, 1280):
                page.set_viewport_size({'width': width, 'height': 844})
                assert event() is True
                expect(page.locator('#loginInstallButton')).to_be_visible()
                page.locator('#loginInstallButton').scroll_into_view_if_needed()
                metrics = page.locator('#loginInstallButton').evaluate('(el)=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,w:r.width,h:r.height,v:innerWidth}}')
                assert metrics['left'] >= 0 and metrics['right'] <= metrics['v'] and metrics['h'] >= 44, metrics
                page.locator('#loginInstallButton').click()
                expect(page.locator('[data-pwa-install-status]').first).to_contain_text('dibatalkan')
                assert page.evaluate('window.__promptCalls') == 1
                assert event() is True
                page.evaluate("document.body.classList.remove('logged-out');document.querySelector('#loginGate').hidden=true")
                expect(page.locator('#installButton')).to_be_visible()
                header = page.locator('#installButton').bounding_box()
                assert header['x'] >= 0 and header['x']+header['width'] <= width+1, (width, header)
                assert header['height'] >= 44
                page.evaluate("document.body.classList.add('logged-out');document.querySelector('#loginGate').hidden=false")
                expect(page.locator('#loginInstallButton')).to_be_visible()
            for outcome, throws, expected in [('accepted',False,'diterima browser'),('dismissed',True,'belum dapat dibuka')]:
                event(outcome, throws)
                page.locator('#loginInstallButton').click()
                expect(page.locator('[data-pwa-install-status]').first).to_contain_text(expected)
                expect(page.locator('#loginInstallButton')).to_be_hidden()
            event()
            page.evaluate("window.dispatchEvent(new Event('appinstalled'))")
            expect(page.locator('#loginInstallButton')).to_be_hidden()
            expect(page.locator('[data-pwa-install-help]')).to_be_hidden()
            page.screenshot(path=str(OUT/'local-installed-state.png'), full_page=True)
            print('INSTALL_FLOW_PASS login=1 authenticated_header=1 widths=320,360,390,760,1280 accepted=1 dismissed=1 error=1 appinstalled=1')
        assert not errors, errors
        context.close()
    browser.close()
print('PWA_INSTALL_E2E_PASS simulated_events=1 physical_android=0 installed_launcher=0')
