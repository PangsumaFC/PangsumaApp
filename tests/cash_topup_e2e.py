"""Local-only top-up integration, including committed-but-lost network response."""
import os
import re
import subprocess
from playwright.sync_api import sync_playwright, expect
from profile_flow_e2e import BASE, MANAGER, SCREENSHOTS, api, credential, http, login, rotate_first_login

def main():
    password = os.environ['LOCAL_MANAGER_PASSWORD']
    status, data, _ = http('/api/bootstrap', {'managerCredential': credential(password)},
                           headers={'Authorization': 'Bearer ' + os.environ['BOOTSTRAP_TOKEN']})
    assert status == 201, (status, data)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 390, 'height': 844}, timezone_id='Asia/Jakarta')
        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE + '/') else route.abort())
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE, wait_until='networkidle')
        login(page, MANAGER, password)
        rotate_first_login(page, password)
        before = api(page, '/api/overview')['data']
        assert before['cashBalanceIdr'] == 0
        page.locator('[data-page="finance"]:visible').first.click()
        page.locator('[data-action="open-cash-topup"]:visible').first.click()
        page.locator('#cashTopupAmount').fill('250000')
        page.locator('#cashTopupNote').fill('Transfer pemilik untuk operasional lokal')
        with page.expect_response(lambda response: response.url.endswith('/api/cash/topups') and response.request.method == 'POST') as pending:
            page.locator('#cashTopupSubmit').click()
        assert pending.value.status == 201
        expect(page.locator('#cashTopupDialog')).not_to_be_visible()
        overview = api(page, '/api/overview')['data']
        assert overview['cashBalanceIdr'] == 250000
        ledger = [entry for entry in overview['cashLedger'] if entry['event_type'] == 'cash_topup']
        assert len(ledger) == 1 and ledger[0]['amount_idr'] == 250000
        assert ledger[0]['actor_name'] and ledger[0]['created_at']
        audit = [entry for entry in overview['auditEvents'] if entry['action'] == 'cash.topup_created']
        assert len(audit) == 1
        page.locator('[data-page="finance"]:visible').first.click()
        expect(page.locator('#appContent')).to_contain_text('Petty cash ditambah')
        expect(page.locator('#appContent')).to_contain_text('WIB')
        page.locator('details').evaluate_all('(nodes) => nodes.forEach(node => node.open = true)')
        text = page.locator('#appContent').inner_text()
        assert re.search(r'(Senin|Selasa|Rabu|Kamis|Jumat|Sabtu|Minggu)', text)
        assert re.search(r'\d{2}[.:]\d{2}[.:]\d{2}', text)
        # Simulate a successful commit whose HTTP response never reaches the client.
        seen_keys = []
        def lose_first_response(route):
            seen_keys.append(route.request.headers.get('idempotency-key'))
            if len(seen_keys) == 1:
                response = route.fetch()
                assert response.status == 201
                route.abort('failed')
            else:
                route.continue_()
        page.route('**/api/cash/topups', lose_first_response)
        page.locator('[data-page="finance"]:visible').first.click()
        page.locator('[data-action="open-cash-topup"]:visible').first.click()
        page.locator('#cashTopupAmount').fill('50000')
        page.locator('#cashTopupNote').fill('Tambahan lokal uji retry aman')
        page.locator('#cashTopupSubmit').click()
        expect(page.locator('#cashTopupSubmit')).to_be_enabled()
        expect(page.locator('#cashTopupDialog')).to_be_visible()
        page.locator('#cashTopupSubmit').click()
        expect(page.locator('#cashTopupDialog')).not_to_be_visible()
        assert len(seen_keys) == 2 and seen_keys[0] == seen_keys[1] and seen_keys[0]
        after = api(page, '/api/overview')['data']
        assert after['cashBalanceIdr'] == 300000
        assert len([entry for entry in after['cashLedger'] if entry['event_type'] == 'cash_topup']) == 2
        assert len([entry for entry in after['auditEvents'] if entry['action'] == 'cash.topup_created']) == 2
        with page.expect_download() as download:
            page.locator('[data-action="download-pdf"]:visible').click()
        pdf_path = SCREENSHOTS / 'laporan-isi-ulang-lokal.pdf'
        download.value.save_as(pdf_path)
        assert pdf_path.read_bytes().startswith(b'%PDF-')
        pdf_text = subprocess.run(['pdftotext', str(pdf_path), '-'], check=True, capture_output=True, text=True).stdout
        pdf_text = ' '.join(pdf_text.split())
        assert 'Transfer pemilik untuk operasional lokal' in pdf_text
        assert 'Tambahan lokal uji retry aman' in pdf_text
        assert 'Rp300.000' in pdf_text and 'cash.topup_created' in pdf_text
        page.locator('[data-page="overview"]:visible').first.click()
        page.screenshot(path=str(SCREENSHOTS / 'dashboard-isi-ulang-390.png'), full_page=True)
        page.locator('[data-page="finance"]:visible').first.click()
        page.locator('details').evaluate_all('(nodes) => nodes.forEach(node => node.open = true)')
        page.screenshot(path=str(SCREENSHOTS / 'riwayat-isi-ulang-390.png'), full_page=True)
        browser.close()
    assert not errors, errors
    print('CASH_TOPUP_E2E_PASS balance=300000 ledger=2 audit=2 lost_response_replay_once=1 weekday_wib_seconds=1 pdf=1 screenshots=' + str(SCREENSHOTS), flush=True)

if __name__ == '__main__':
    main()
