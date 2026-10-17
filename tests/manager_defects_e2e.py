"""Local-only Manager submission, CSV download, and realistic gallery regression."""
import base64
import csv
import io
import json
import os
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from profile_flow_e2e import (
    BASE, MANAGER, SCREENSHOTS, api, credential, http, login,
    rotate_first_login, visible_dialog,
)


def main():
    status, data, _ = http('/api/bootstrap', {'managerCredential': credential(os.environ['LOCAL_MANAGER_PASSWORD'])},
                           headers={'Authorization': 'Bearer ' + os.environ['BOOTSTRAP_TOKEN']})
    assert status == 201, (status, data)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        context = browser.new_context(**p.devices['Pixel 7'], accept_downloads=True)
        context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE + '/') else route.abort())
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE, wait_until='networkidle')
        login(page, MANAGER, os.environ['LOCAL_MANAGER_PASSWORD'])
        rotate_first_login(page, os.environ['LOCAL_MANAGER_PASSWORD'])
        initial = api(page, '/api/overview')['data']
        actor = initial['user']
        target = next(user for user in initial['users'] if user['role'] == 'user')
        created = []
        for kind in ('petty_cash', 'finance_request'):
            page.locator('[data-page="overview"]:visible').first.click()
            page.locator('[data-action="open-report-choice"]').click()
            page.locator(f'[data-action="choose-report-type"][data-type="{kind}"]').click()
            expect(page.locator('#reportForm')).to_be_visible()
            description = f'Manager own {kind} {uuid.uuid4().hex[:8]}'
            page.locator('#reportAmount').fill('12000')
            page.locator('#reportDescription').fill(description)
            page.locator('#reportNote').fill('Local-only regression')
            # Background sync must not discard a Manager report draft.
            page.evaluate('refreshManagerOverview({force:true})')
            expect(page.locator('#reportDescription')).to_have_value(description)
            with page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/api/submissions')) as response:
                page.locator('#reportForm button[type="submit"]').click()
            assert response.value.status == 201
            item = response.value.json()['submission']
            assert item['createdBy'] == actor['id'] and item['status'] == 'pending'
            created.append(item)
            page.locator('#reportForm').wait_for(state='detached')
            card = page.locator('.item-row').filter(has_text=description).first
            expect(card.locator('[data-action="approve"]')).to_be_disabled()
            expect(card.locator('[data-action="reject"]')).to_be_disabled()
            for action in ('approve', 'reject'):
                result = api(page, f"/api/submissions/{item['id']}/{action}", 'POST', {'reason': 'local self-decision test'})
                assert result['status'] == 403 and result['data']['error']['code'] == 'self_decision_not_allowed', result
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            print(f'MANAGER_SELF_REPORT_PASS type={kind} submit=201 owner=self status=pending self_decisions=403 draft_preserved=1', flush=True)

        before_photo = api(page, '/api/overview')['data']
        # Full-size deterministic pixel image, downsampled by the real browser upload path.
        fixtures = page.evaluate('''() => {
          const c=document.createElement('canvas'); c.width=1200; c.height=900;
          const x=c.getContext('2d'); const data=x.createImageData(c.width,c.height);
          let seed=1729;
          for(let i=0;i<data.data.length;i+=4) {
            seed=(Math.imul(seed,1664525)+1013904223)>>>0;
            data.data[i]=seed&255; data.data[i+1]=(seed>>>8)&255;
            data.data[i+2]=(seed>>>16)&255; data.data[i+3]=255;
          }
          x.putImageData(data,0,0);
          return ['image/jpeg','image/png','image/webp'].map(mime=>({mime,url:c.toDataURL(mime,.88)}));
        }''')
        profile_path = f"/api/users/{target['id']}/profile"
        page.locator('[data-page="users"]:visible').first.click()
        for fixture in fixtures:
            page.locator('tbody tr').filter(has_text=target['name']).locator('[data-action="edit-user-profile"]').click()
            dialog = visible_dialog(page)
            expect(dialog.locator('[data-action="choose-profile-photo"]')).to_be_enabled()
            # Capture the real chooser event from a touch, not a synthetic input change.
            # This tests Chromium activation, not Android's native gallery UI.
            with page.expect_file_chooser() as cancelled:
                dialog.locator('[data-action="choose-profile-photo"]').tap()
            cancelled.value.set_files([])
            expect(dialog.locator('#profileError')).to_be_hidden()
            with page.expect_file_chooser() as chooser:
                dialog.locator('[data-action="choose-profile-photo"]').tap()
            assert not chooser.value.is_multiple()
            chooser.value.set_files({
                'name': 'realistic.' + fixture['mime'].split('/')[1],
                'buffer': base64.b64decode(fixture['url'].split(',')[1]),
                'mimeType': fixture['mime']
            })
            expect(dialog.locator('#profilePhotoStatus')).to_contain_text('Foto siap', timeout=15000)
            expect(dialog.locator('#profilePreview img')).to_be_visible()
            dialog.locator('#profileNickname').fill('Local gallery regression')
            with page.expect_response(lambda r: r.request.method == 'PUT' and r.url.endswith(profile_path)) as response:
                dialog.locator('#profileSubmit').click()
            assert response.value.status == 200, response.value.text()
            dialog.wait_for(state='hidden')
            saved = api(page, profile_path)['data']['user']
            photo_response = page.request.get(BASE + saved['photoUrl'])
            assert photo_response.status == 200
            assert photo_response.headers['content-type'] == 'image/jpeg'
            assert len(photo_response.body()) <= 131072
            print(f"MOBILE_PHOTO_CHOOSER_PASS touch=1 cancel_reopen=1 input={fixture['mime']} input_size=1200x900 persisted_bytes={len(photo_response.body())} save=200 get=200 native_gallery_verified=0", flush=True)
        after_photo = api(page, '/api/overview')['data']
        for key in ('cashBalanceIdr', 'cashLedger', 'submissions', 'summary'):
            assert after_photo[key] == before_photo[key], key
        page.screenshot(path=str(SCREENSHOTS / 'manager-gallery-saved.png'), full_page=True)

        for width in (320, 390, 768, 1280):
            page.set_viewport_size({'width': width, 'height': 900})
            page.locator('[data-page="finance"]:visible').first.click()
            with page.expect_download(timeout=20000) as download:
                page.get_by_role('button', name='Unduh rekap lengkap CSV').tap()
            assert download.value.failure() is None
            assert download.value.url == BASE + '/api/export.csv', download.value.url
            destination = SCREENSHOTS / f'manager-download-{width}.csv'
            download.value.save_as(destination)
            raw = destination.read_bytes()
            assert raw.startswith(b'\xef\xbb\xbf')
            rows = list(csv.reader(io.StringIO(raw.decode('utf-8-sig'))))
            assert len(rows[0]) == 19 and all(len(row) == 19 for row in rows)
            assert {row[1] for row in rows[1:] if row[0] == 'Pengajuan'} == {item['id'] for item in created}
            assert any(row[0] == 'Audit' and row[15] == 'user.profile_updated' for row in rows[1:])
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            print(f'CSV_MOBILE_DOWNLOAD_PASS width={width} touch=1 url=server_not_blob rows={len(rows)-1} bom=1 all_submissions=1 profile_audit=1 overflow=0', flush=True)
        # Capability negotiation is simulated here; no Android bridge runs in Chromium.
        for native_downloads in (False, True):
            page.evaluate('''nativeDownloads => {
              window.PangsumaFileBridge = {};
              window.__pangsumaNativeDownloads = nativeDownloads;
            }''', native_downloads)
            with page.expect_download(timeout=20000) as download:
                page.get_by_role('button', name='Unduh rekap lengkap CSV').tap()
            assert download.value.failure() is None
            assert download.value.url.startswith('blob:') is not native_downloads
            destination = SCREENSHOTS / f'manager-capability-{native_downloads}.csv'
            download.value.save_as(destination)
            assert destination.read_bytes().startswith(b'\xef\xbb\xbf')
            print(f'CSV_APK_CAPABILITY_SIMULATED_PASS native_downloads={int(native_downloads)} native_runtime_verified=0', flush=True)
        page.evaluate('''() => {
          delete window.PangsumaFileBridge;
          delete window.__pangsumaNativeDownloads;
        }''')
        final = api(page, '/api/overview')['data']
        assert final['cashBalanceIdr'] == initial['cashBalanceIdr']
        assert final['cashLedger'] == initial['cashLedger']
        page.screenshot(path=str(SCREENSHOTS / 'manager-finance-csv.png'), full_page=True)
        assert not errors, errors
        context.close()
        browser.close()
    print('MANAGER_DEFECTS_FOCUSED_PASS production_writes=0 browser_errors=0 artifacts=' + str(SCREENSHOTS), flush=True)


if __name__ == '__main__':
    main()
