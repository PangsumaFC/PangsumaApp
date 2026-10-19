"""Loopback-only UI checks for avatar previews and the Manager top-up placement."""
import base64
import json
from playwright.sync_api import sync_playwright, expect
from qa_fixture_server import serve_in_thread

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
server, _ = serve_in_thread(host='127.0.0.1', port=0)
base = f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/opt/google/chrome/chrome', headless=True, args=['--no-sandbox'])
        for role in ['manager', 'user']:
            for width in [320, 390, 768, 1280]:
                context = browser.new_context(viewport={'width':width, 'height':1000}, service_workers='block')
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                def routing(route):
                    url = route.request.url
                    if not url.startswith(base + '/'):
                        route.abort(); return
                    if url.endswith('/synthetic-avatar.png'):
                        route.fulfill(content_type='image/png', body=PNG); return
                    if route.request.method != 'GET':
                        raise AssertionError('Browser QA must not submit any records')
                    if url.split('?')[0].endswith(('/api/session','/api/overview')):
                        response = route.fetch()
                        data = response.json()
                        if isinstance(data.get('user'), dict): data['user']['photoUrl'] = base + '/synthetic-avatar.png'
                        route.fulfill(response=response, json=data); return
                    route.continue_()
                page.route('**/*', routing)
                page.goto(base + '/' + role)
                avatar = page.locator('[data-action="preview-avatar"]:visible')
                expect(avatar).to_have_count(1)
                expect(avatar).to_be_visible()
                expect(page.locator('[data-action="edit-user-profile"]:visible')).to_have_count(0)
                avatar.focus()
                page.keyboard.press('Enter')
                dialog = page.locator('#avatarPreviewDialog')
                expect(dialog).to_be_visible()
                expect(page.locator('#userProfileDialog')).not_to_be_visible()
                image = page.locator('#avatarPreviewBody img')
                expect(image).to_be_visible()
                bounds = image.bounding_box(); parent = page.locator('.avatar-preview-image').bounding_box()
                assert bounds and parent and parent['width'] >= 200
                assert all(abs(bounds[k]-parent[k]) < 1 for k in ['x','y','width','height']), (bounds,parent)
                assert bounds['width'] > avatar.bounding_box()['width']
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.keyboard.press('Escape')
                expect(dialog).not_to_be_visible()
                expect(avatar).to_be_focused()
                avatar.press('Space')
                expect(dialog).to_be_visible()
                page.mouse.click(2,2)
                expect(dialog).not_to_be_visible()
                expect(avatar).to_be_focused()
                topup = page.locator('[data-action="open-cash-topup"]:visible')
                if role == 'manager':
                    expect(topup).to_have_count(1)
                    balance = page.locator('.balance-panel')
                    assert balance.locator('[data-action="open-cash-topup"]').count() == 1
                    assert topup.bounding_box()['y'] >= balance.locator('p').bounding_box()['y']
                    topup.click()
                    expect(page.locator('#cashTopupDialog')).to_be_visible()
                    page.keyboard.press('Escape')
                    page.locator('[data-page="finance"]:visible').first.click()
                    expect(page.locator('#financeReportsTitle')).to_be_visible()
                    expect(page.locator('[data-action="open-cash-topup"]:visible')).to_have_count(0)
                    page.locator('.account-users-button:visible').click()
                    edit = page.locator('[data-action="edit-user-profile"][data-id="qa-manager"]:visible')
                    expect(edit).to_have_count(1)
                    edit.click()
                    expect(page.locator('#userProfileDialog')).to_be_visible()
                    page.keyboard.press('Escape')
                else:
                    expect(topup).to_have_count(0)
                    expect(page.locator('.account-users-button:visible')).to_have_count(0)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert not errors, errors
                print(json.dumps({'role':role,'width':width,'previewImage':'aligned and enlarged','keyboardEscapeBackdropFocus':'passed','topupPlacement':'passed','managerOnlyEdit':'passed','overflow':False}), flush=True)
                context.close()
        browser.close()
finally:
    server.shutdown()
