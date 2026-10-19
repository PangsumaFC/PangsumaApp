"""Local-only regression for Manager submissions, PDF downloads and mobile photo decoding."""
import base64
import os
import subprocess

from playwright.sync_api import expect, sync_playwright
from profile_flow_e2e import (
    BASE, MANAGER, SCREENSHOTS, api, credential, http, login,
    rotate_first_login, set_file, tiny_png, visible_dialog,
)


def main():
    password = os.environ['LOCAL_MANAGER_PASSWORD']
    status, data, _ = http('/api/bootstrap', {'managerCredential': credential(password)},
                           headers={'Authorization': 'Bearer ' + os.environ['BOOTSTRAP_TOKEN']})
    assert status == 201, (status, data)
    errors = []
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        engine = os.environ.get('PANGSUMA_TEST_BROWSER', 'chromium')
        browser = (p.webkit.launch(headless=True) if engine == 'webkit' else
                   p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                     args=['--no-sandbox']))
        device = p.devices['iPhone 13' if engine == 'webkit' else 'Pixel 7']
        context = browser.new_context(viewport={'width': 390, 'height': 844},
                                      is_mobile=True, has_touch=True,
                                      ignore_https_errors=BASE.startswith('https://'),
                                      user_agent=device['user_agent'])
        context.set_default_timeout(10_000)
        context.route('**/*', lambda route: route.continue_()
                      if route.request.url.startswith(BASE + '/') else route.abort())
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE, wait_until='networkidle')
        login(page, MANAGER, password)
        rotate_first_login(page, password)
        overview = api(page, '/api/overview')['data']
        manager = overview['user']
        user = next(u for u in overview['users'] if u['role'] == 'user')
        assert manager['role'] == 'manager'

        # Insufficient cash must reject the whole Manager transaction, not leave pending.
        blocked = api(page, '/api/submissions', 'POST', {
            'type': 'petty_cash', 'amountIdr': 125000, 'date': '2026-10-18',
            'description': 'Manager balance guard local'
        }, {'Idempotency-Key': '44444444-4444-4444-8444-444444444444'})
        assert blocked['status'] == 409 and blocked['data']['error']['code'] == 'insufficient_petty_cash', blocked
        unchanged = api(page, '/api/overview')['data']
        assert unchanged['submissions'] == overview['submissions']
        assert unchanged['cashLedger'] == overview['cashLedger']
        assert unchanged['auditEvents'] == overview['auditEvents']
        opening = api(page, '/api/cash/opening-balance', 'POST', {'amountIdr': 500000, 'ownerConfirmed': True})
        assert opening['status'] == 201, opening
        overview = api(page, '/api/overview')['data']

        # The Manager must reach the shared form through the actual mobile UI.
        page.evaluate('Object.defineProperty(crypto, "randomUUID", {value: undefined, configurable: true})')
        for kind in ('petty_cash', 'finance_request'):
            page.locator('[data-action="open-report-choice"]').click()
            page.locator("#reportType").select_option(kind)
            expect(page.locator('#reportForm')).to_be_visible()
            page.locator('#reportAmount').fill('125000')
            page.locator('#reportDescription').fill('=Manager local ' + kind)
            with page.expect_response(lambda r: r.url.endswith('/api/submissions')
                                      and r.request.method == 'POST') as response:
                page.locator('#reportForm [type="submit"]').click()
            assert response.value.status == 201, response.value.text()
            original = response.value.json()['submission']
            assert original['status'] == 'approved', original
            replay = api(page, '/api/submissions', 'POST', response.value.request.post_data_json,
                         {'Idempotency-Key': response.value.request.all_headers()['idempotency-key']})
            assert replay['status'] == 200 and replay['data']['alreadyCreated'], replay
            assert replay['data']['submission']['id'] == original['id'], replay
            page.locator('#reportForm').wait_for(state='detached')
            expect(page.locator('[data-action="open-report-choice"]')).to_be_visible()
        after = api(page, '/api/overview')['data']
        own = [s for s in after['submissions'] if s['createdBy'] == manager['id']]
        assert len(own) == 2 and all(s['status'] == 'approved' for s in own), own
        for action in ('approve', 'reject'):
            denied = api(page, f"/api/submissions/{own[0]['id']}/{action}", 'POST',
                         {'reason': 'Local rejection'} if action == 'reject' else {})
            assert denied['status'] == 403 and denied['data']['error']['code'] == 'self_decision_not_allowed', denied
        assert after['cashBalanceIdr'] == overview['cashBalanceIdr'] - 125000
        assert len(after['cashLedger']) == len(overview['cashLedger']) + 1
        assert after['summary']['pending'] == 0 and after['summary']['financeWaiting'] == 1
        petty = next(s for s in own if s['type'] == 'petty_cash')
        assert sum(e['submission_id'] == petty['id'] for e in after['cashLedger']) == 1
        finance = next(s for s in own if s['type'] == 'finance_request')
        sent = api(page, f"/api/submissions/{finance['id']}/send", 'POST', {})
        assert sent['status'] == 200 and sent['data']['submission']['status'] == 'sent', sent
        sent_replay = api(page, f"/api/submissions/{finance['id']}/send", 'POST', {})
        assert sent_replay['status'] == 200 and sent_replay['data']['alreadyApplied'], sent_replay
        page.screenshot(path=str(SCREENSHOTS / 'manager-own-submissions.png'), full_page=True)
        print('MANAGER_SUBMISSION_UI_PASS types=2 created=201 own_approved=2 self_decision=403 cash_debited_once=1 finance_sent=1 insufficient_rollback=1', flush=True)

        # Save to both profiles with the real mobile chooser, including the Manager's own profile.
        page.evaluate('window.createImageBitmap = undefined')
        for target in (manager, user):
            page.locator('[data-page="users"]:visible').first.click()
            path = f"/api/users/{target['id']}/profile"
            if target['role'] == 'user':
                page.evaluate('() => { window.createImageBitmap = async () => { throw new Error("Gallery bitmap unavailable"); }; }')
            page.locator(f'[data-action="edit-user-profile"][data-id="{target["id"]}"]').click()
            dialog = visible_dialog(page)
            with page.expect_file_chooser() as chooser_info:
                dialog.locator('#profilePhoto').click()
            chooser_info.value.set_files({
                'name': 'gallery.PNG',
                'mimeType': 'application/octet-stream' if target['role'] == 'user' else 'image/png',
                'buffer': tiny_png(),
            })
            expect(dialog.locator('#profilePhotoStatus')).to_contain_text('Foto siap')
            expect(dialog.locator('#profileError')).to_be_hidden()
            with page.expect_response(lambda r: r.request.method == 'PUT' and r.url.endswith(path)) as response:
                dialog.locator('#profileSubmit').click()
            assert response.value.status == 200, response.value.text()
            dialog.wait_for(state='hidden')
            saved = api(page, path)['data']['user']
            assert saved['photoUrl'], saved
            page.reload(wait_until='networkidle')
            if target['role'] == 'user':
                page.locator('[data-page="users"]:visible').first.click()
            page.wait_for_function("url => [...document.images].some(img => img.src.includes(url) && img.complete && img.naturalWidth > 0)", arg=saved['photoUrl'])
            print('MANAGER_PHOTO_CHOOSER_PASS target=' + target['role'] + ' save=200 chooser=1 reload=1 natural_width=1', flush=True)
        # Empty MIME metadata from a gallery must not reject an otherwise valid image.
        page.locator(f'[data-action="edit-user-profile"][data-id="{manager["id"]}"]').click()
        dialog = visible_dialog(page)
        png64 = base64.b64encode(tiny_png()).decode()
        page.evaluate('''async raw => {
            const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
            await prepareProfilePhoto(new File([bytes], 'gallery.PNG', {type:''}));
        }''', png64)
        expect(dialog.locator('#profilePhotoStatus')).to_contain_text('Foto siap')
        page.evaluate('''async () => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 4;
            canvas.getContext('2d').fillRect(0, 0, 4, 4);
            const raw = canvas.toDataURL('image/jpeg').split(',')[1];
            const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
            await prepareProfilePhoto(new File([bytes], 'gallery.jpg', {type:'image/jpg'}));
        }''')
        expect(dialog.locator('#profilePhotoStatus')).to_contain_text('Foto siap')
        expect(dialog.locator('#profileError')).to_be_hidden()
        previous = dialog.locator('#profilePreview img').get_attribute('src')
        # Image.decode, not just onload, must reject corrupt bytes in the fallback.
        set_file(page, '#profilePhoto', 'broken.jpg', b'not an image', 'image/jpeg')
        expect(dialog.locator('#profileError')).to_be_visible()
        assert dialog.locator('#profilePreview img').get_attribute('src') == previous
        page.once("dialog", lambda prompt: prompt.accept())
        dialog.locator('[data-action="close-dialog"]').first.click()
        print('MANAGER_PHOTO_METADATA_PASS empty_mime=1 jpg_alias=1 invalid_replacement_rejected=1 draft_preserved=1', flush=True)

        # CSV was removed; the supported export is the complete, filtered PDF report.
        csv_response = page.evaluate("""async () => {
            const r = await fetch('/api/export.csv');
            return {status: r.status, type: r.headers.get('content-type')};
        }""")
        assert csv_response['status'] == 404, csv_response
        page.locator('[data-page="finance"]:visible').first.click()
        search = page.locator('#managerReportFiltersForm [name="q"]')
        search.fill('Manager local petty_cash')
        page.locator('#managerReportFiltersForm [type="submit"]').click()
        expect(page.locator('#managerReportsRegion .manager-report-filters')).to_have_attribute(
            'aria-busy', 'false', timeout=15_000)
        pdf_url = page.evaluate('() => ManagerReportFilters.pdfUrl("petty_cash")')
        assert 'q=Manager+local+petty_cash' in pdf_url and 'laporan=petty_cash' in pdf_url, pdf_url
        with page.expect_download() as download:
            page.locator('[data-action="download-pdf"][data-report-type="petty_cash"]:visible').click()
        assert download.value.failure() is None
        downloaded = SCREENSHOTS / 'manager-filtered-report.pdf'
        download.value.save_as(downloaded)
        raw = downloaded.read_bytes()
        assert raw.startswith(b'%PDF-'), raw[:16]
        pdf_text = subprocess.run(['pdftotext', str(downloaded), '-'], check=True,
                                  capture_output=True, text=True).stdout
        normalized_pdf = ' '.join(pdf_text.split())
        assert 'Laporan Petty Cash' in normalized_pdf
        assert 'Manager local petty_cash' in normalized_pdf
        assert 'Manager local finance_request' not in normalized_pdf
        page.screenshot(path=str(SCREENSHOTS / 'manager-filtered-report.png'), full_page=True)
        print('MANAGER_PDF_DOWNLOAD_PASS csv_status=404 filtered=1 download=1 pdf=1 full_report=1', flush=True)
        assert not errors, errors
        context.close()
        browser.close()
    print('MANAGER_ACTIONS_E2E_PASS browser=' + engine + ' browser_errors=0 random_uuid_fallback=1 screenshots=' + str(SCREENSHOTS), flush=True)


if __name__ == '__main__':
    main()
