"""Synthetic loopback regression checks; all nonlocal traffic is denied."""
import base64
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from qa_fixture_server import serve_in_thread

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
OUT = Path('/workspace/pangsuma-deep-audit-evidence/photo')
ROOT = Path(os.environ.get('AUDIT_SITE', str(Path(__file__).resolve().parents[1] / 'site')))

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    server, _ = serve_in_thread(site=ROOT)
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            for role in ('user', 'manager'):
                for kind in ('petty_cash', 'finance_request'):
                    context = browser.new_context(viewport={'width': 390, 'height': 844})
                    page = context.new_page()
                    writes = []
                    def route(req):
                        if not req.request.url.startswith(base + '/'):
                            req.abort(); return
                        if req.request.method == 'POST':
                            if req.request.url.endswith('/duplicate-check'):
                                req.fulfill(json={'matches': []}); return
                            writes.append(req.request.url)
                            req.fulfill(status=503, json={'error': {'code': 'synthetic', 'message': 'Simulasi lokal'}}); return
                        req.continue_()
                    page.route('**/*', route)
                    page.goto(base + '/' + role, wait_until='networkidle')
                    page.evaluate("navigateToPage('new-report')")
                    page.locator('#reportType').select_option(kind)
                    page.locator('#reportAmount').fill('125000')
                    page.locator('#reportDescription').fill('DATA DEMO regresi foto')
                    page.locator('#reportDate').fill('2026-10-19')
                    evidence = page.locator('.new-request-evidence')
                    file = evidence.locator('input[type=file]')
                    consent = evidence.locator('.receipt-consent input')
                    def record(name, check):
                        try:
                            check()
                            results.append({'domain': 'photo', 'name': f'{role}/{kind}/{name}', 'status': 'pass'})
                        except Exception as exc:
                            results.append({'domain': 'photo', 'name': f'{role}/{kind}/{name}', 'status': 'fail', 'error': str(exc)[:1000]})
                    file.set_input_files({'name': 'DATA-DEMO.png', 'mimeType': 'image/png', 'buffer': PNG})
                    expect(evidence.locator('.receipt-status')).to_contain_text('Siap.')
                    page.locator('#reportForm button[type=submit]').click()
                    def missing():
                        expect(evidence.locator('.receipt-consent-error')).to_be_visible()
                        expect(evidence.locator('.receipt-consent-error')).to_contain_text('tautan publik')
                        expect(consent).to_be_focused()
                        expect(consent).to_have_attribute('aria-invalid', 'true')
                        assert not writes, writes
                        assert 'Koneksi ke layanan gagal' not in page.locator('#toast').inner_text()
                    record('missing-consent-inline-focus-zero-writes', missing)
                    consent.check()
                    def corrected():
                        expect(evidence.locator('.receipt-consent-error')).to_be_hidden()
                        assert consent.get_attribute('aria-invalid') is None
                        assert not writes
                    record('consent-correction-clears-accessible-error', corrected)
                    evidence.locator('.receipt-remove').click()
                    def removed():
                        expect(evidence.locator('.receipt-status')).to_have_text('')
                        expect(evidence.locator('.receipt-preview')).to_be_hidden()
                        assert evidence.locator('.receipt-preview').get_attribute('src') is None
                        expect(evidence.locator('.receipt-file-name')).to_have_text('')
                        expect(consent).not_to_be_checked()
                        assert file.evaluate('(el) => el.files.length') == 0
                        assert not page.evaluate("ReportEvidence.hasPending(document.querySelector('#reportForm'))")
                    record('remove-clears-status-url-input-consent-pending', removed)
                    page.reload(wait_until='networkidle')
                    page.evaluate("navigateToPage('new-report')")
                    def reload_empty():
                        expect(page.locator('.new-request-evidence .receipt-preview')).to_be_hidden()
                        expect(page.locator('.new-request-evidence .receipt-status')).to_have_text('')
                        assert not writes
                    record('removed-photo-does-not-restore-after-reload', reload_empty)
                    page.locator('.new-request-evidence input[type=file]').set_input_files({'name': 'again.png', 'mimeType': 'image/png', 'buffer': PNG})
                    def reselection():
                        expect(page.locator('.new-request-evidence .receipt-preview')).to_be_visible()
                        expect(page.locator('.new-request-evidence .receipt-status')).to_contain_text('Siap.')
                        expect(page.locator('.receipt-consent input')).not_to_be_checked()
                        assert not writes
                    record('reselect-after-removal-requires-fresh-consent', reselection)
                    context.close()
            browser.close()
    finally:
        server.shutdown()
    (OUT / 'regression-results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps({'total': len(results), 'pass': sum(x['status']=='pass' for x in results), 'fail': sum(x['status']=='fail' for x in results)}))
    for row in results:
        if row['status'] != 'pass': print(json.dumps(row))
    assert all(x['status'] == 'pass' for x in results)

if __name__ == '__main__': main()
