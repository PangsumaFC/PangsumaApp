"""Local-only regression for gallery decoding; does not rerun the full profile flow."""
import base64
import secrets
import struct

from playwright.sync_api import expect, sync_playwright

from profile_flow_e2e import (
    BASE, MANAGER, SCREENSHOTS, api, credential, data_url_png, http, login,
    rotate_first_login, set_file, tiny_png, visible_dialog,
)
import os


def main():
    token = os.environ['BOOTSTRAP_TOKEN']
    password = os.environ['LOCAL_MANAGER_PASSWORD']
    status, data, _ = http('/api/bootstrap', {'managerCredential': credential(password)},
                           headers={'Authorization': f'Bearer {token}'})
    assert status == 201, (status, data)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                    args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 390, 'height': 844})
        context.set_default_timeout(5_000)
        context.set_default_navigation_timeout(10_000)
        context.route('**/*', lambda route: route.continue_()
                      if route.request.url.startswith(BASE + '/') else route.abort())
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE, wait_until='networkidle', timeout=10_000)
        login(page, MANAGER, password)
        rotate_first_login(page, password)
        overview = api(page, '/api/overview')['data']
        target = next(user for user in overview['users'] if user['role'] == 'user')
        manager = overview['user']
        manager_path = f"/api/users/{manager['id']}/profile"
        page.locator('.welcome-avatar-button').click()
        manager_dialog = visible_dialog(page)
        set_file(page, '#profilePhoto', 'manager-dashboard-avatar.png', tiny_png(), 'image/png')
        expect(manager_dialog.locator('#profilePhotoStatus')).to_contain_text('Foto siap', timeout=5_000)
        with page.expect_response(lambda response: response.request.method == 'PUT'
                                  and response.url.endswith(manager_path), timeout=10_000) as manager_response:
            manager_dialog.locator('#profileSubmit').click()
        assert manager_response.value.status == 200
        manager_dialog.wait_for(state='hidden', timeout=10_000)
        page.reload(wait_until='networkidle', timeout=10_000)
        expect(page.locator('.welcome-avatar-button img')).to_be_visible(timeout=10_000)
        assert api(page, manager_path)['data']['user']['photoUrl']
        path = f"/api/users/{target['id']}/profile"
        page.locator("[data-page='users']:visible").first.click()
        page.locator('tbody tr').first.wait_for(timeout=5_000)

        def open_profile():
            page.locator('tbody tr').filter(has_text=target['name']).locator(
                "[data-action='edit-user-profile']").click()
            return visible_dialog(page)

        fake = bytearray(30)
        fake[:4] = b'RIFF'
        struct.pack_into('<I', fake, 4, 22)
        fake[8:16] = b'WEBPVP8 '
        struct.pack_into('<I', fake, 16, 10)
        fake[20:26] = bytes([0x30, 0, 0, 0x9d, 1, 0x2a])
        struct.pack_into('<HH', fake, 26, 1, 1)
        padded = bytearray(fake + bytes(6))
        struct.pack_into('<I', padded, 4, 28)
        struct.pack_into('<I', padded, 16, 16)
        invalids = [
            ('header-only.webp', bytes(fake), 'image/webp'),
            ('padded-fake.webp', bytes(padded), 'image/webp'),
            ('image.svg', b"<svg xmlns='http://www.w3.org/2000/svg'></svg>", 'image/svg+xml'),
            ('spoof.jpg', b'not-a-real-jpeg', 'image/jpeg'),
            ('header-only.jpg', bytes([0xff,0xd8,0xff,0xc0,0,8,8,0,1,0,1,1,0xff,0xda,0,2,0,0,0xff,0xd9]), 'image/jpeg'),
            ('huge.png', b'\x89PNG' + b'x' * (10 * 1024 * 1024 + 1), 'image/png'),
        ]
        before = api(page, path)['data']['user']
        before_overview = api(page, '/api/overview')['data']
        for filename, raw, mime in invalids:
            dialog = open_profile()
            writes = []
            def record(request):
                if request.method == 'PUT' and request.url.endswith(path):
                    writes.append(request.url)
            page.on('request', record)
            set_file(page, '#profilePhoto', filename, raw, mime)
            expect(dialog.locator('#profileError')).to_be_visible(timeout=5_000)
            expect(dialog.locator('#profilePhotoStatus')).to_have_text('', timeout=5_000)
            expect(dialog.locator('#profileSubmit')).to_be_enabled(timeout=5_000)
            assert not writes, (filename, writes)
            page.remove_listener('request', record)
            if filename == 'header-only.webp':
                dialog.screenshot(path=str(SCREENSHOTS / 'header-only-webp-rejected.png'))
            dialog.locator("[data-action='close-dialog']").first.click()
            dialog.wait_for(state='hidden', timeout=5_000)
            rejected = api(page, path, 'PUT', {
                'nickname': 'invalid', 'dashboardPosition': 'invalid', 'quote': 'invalid',
                'photoDataUrl': 'data:' + mime + ';base64,' + base64.b64encode(raw).decode(),
            })
            assert rejected['status'] == (413 if filename == 'huge.png' else 400), (filename, rejected)
            assert api(page, path)['data']['user'] == before, filename
            print(f"PROFILE_IMAGE_FOCUSED_REJECT filename={filename} browser=1 no_upload=1 server={rejected['status']} profile_unchanged=1", flush=True)
        after_invalids = api(page, '/api/overview')['data']
        for key in ('cashBalanceIdr', 'cashLedger', 'submissions', 'summary', 'auditEvents'):
            assert after_invalids[key] == before_overview[key], key

        # Exercise the real gallery/canvas/save path for each supported format.
        jpeg = page.evaluate("""() => {
            const c=document.createElement('canvas'); c.width=2; c.height=3;
            const x=c.getContext('2d'); x.fillStyle='red'; x.fillRect(0,0,2,3);
            return c.toDataURL('image/jpeg').split(',')[1];
        }""")
        webp = base64.b64decode('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=')
        for filename, raw, mime in [
            ('valid.png', tiny_png(), 'image/png'),
            ('valid.jpg', base64.b64decode(jpeg), 'image/jpeg'),
            ('valid.webp', webp, 'image/webp'),
        ]:
            dialog = open_profile()
            dialog.locator('#profileNickname').fill('Gallery Alias')
            set_file(page, '#profilePhoto', filename, raw, mime)
            expect(dialog.locator('#profilePhotoStatus')).to_contain_text('Foto siap', timeout=5_000)
            expect(dialog.locator('#profileError')).to_be_hidden()
            with page.expect_response(lambda response: response.request.method == 'PUT'
                                      and response.url.endswith(path), timeout=10_000) as response:
                dialog.locator('#profileSubmit').click()
            assert response.value.status == 200, filename
            dialog.wait_for(state='hidden', timeout=10_000)
            saved = api(page, path)['data']['user']
            assert saved['nickname'] == 'Gallery Alias' and saved['photoUrl'], saved
            assert api(page, f"/api/users/{target['id']}/photo")['status'] == 200
            print(f'PROFILE_IMAGE_FOCUSED_VALID filename={filename} preview=1 saved=200 photo=200', flush=True)

        # An invalid replacement must retain, not overwrite, a previously valid draft.
        dialog = open_profile()
        set_file(page, '#profilePhoto', 'valid.png', tiny_png(), 'image/png')
        expect(dialog.locator('#profilePhotoStatus')).to_contain_text('Foto siap', timeout=5_000)
        previous = dialog.locator('#profilePreview img').get_attribute('src')
        set_file(page, '#profilePhoto', 'header-only.webp', bytes(fake), 'image/webp')
        expect(dialog.locator('#profileError')).to_be_visible(timeout=5_000)
        assert dialog.locator('#profilePreview img').get_attribute('src') == previous
        set_file(page, '#profilePhoto', 'recovery.png', tiny_png(), 'image/png')
        expect(dialog.locator('#profilePhotoStatus')).to_contain_text('Foto siap', timeout=5_000)
        expect(dialog.locator('#profileError')).to_be_hidden()
        dialog.locator('#profileSubmit').click()
        dialog.wait_for(state='hidden', timeout=10_000)
        page.screenshot(path=str(SCREENSHOTS / 'gallery-upload-saved.png'), full_page=True)
        final = api(page, '/api/overview')['data']
        for key in ('cashBalanceIdr', 'cashLedger', 'submissions', 'summary'):
            assert final[key] == before_overview[key], key
        assert not errors, errors
        context.close()
        browser.close()
    print('PROFILE_IMAGE_FOCUSED_PASS malformed_browser=6 malformed_api=6 valid_gallery=3 draft_preserved=1 recovery=1 financial_unchanged=1 browser_errors=0 full_profile_e2e_rerun=0 screenshots=' + str(SCREENSHOTS), flush=True)


if __name__ == '__main__':
    main()
