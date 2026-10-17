"""Local-only Manager header/navigation and responsive visual regression."""
import os
from playwright.sync_api import sync_playwright, expect
from profile_flow_e2e import BASE, MANAGER, SCREENSHOTS, credential, http, login, rotate_first_login

def main():
    password = os.environ['LOCAL_MANAGER_PASSWORD']
    status, data, _ = http('/api/bootstrap', {'managerCredential': credential(password)},
                           headers={'Authorization': 'Bearer ' + os.environ['BOOTSTRAP_TOKEN']})
    assert status == 201, (status, data)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE + '/') else route.abort())
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE, wait_until='networkidle', timeout=30_000)
        login(page, MANAGER, password)
        rotate_first_login(page, password)
        for width in (320, 390, 768, 1280):
            page.set_viewport_size({'width': width, 'height': 900})
            page.reload(wait_until='networkidle')
            page.locator('#loginGate').wait_for(state='hidden', timeout=20_000)
            expect(page.locator('.account-users-button')).to_be_visible()
            expect(page.get_by_role('button', name='Ganti password', exact=True)).to_be_visible()
            assert page.locator('.account-password-label').is_hidden()
            assert page.locator('.mobile-nav.is-manager .nav-button').count() == 3
            assert page.locator('body').evaluate('(el) => el.scrollWidth <= window.innerWidth')
            assert page.locator('.profile-settings-link').count() == 0
            page.locator('.account-users-button').click()
            expect(page.locator('#appContent')).to_contain_text('Pengguna')
            page.get_by_role('button', name='Ganti password', exact=True).click()
            expect(page.locator('#passwordForm')).to_be_visible()
            page.locator('[data-page="overview"]:visible').first.click()
            page.screenshot(path=str(SCREENSHOTS / f'manager-design-{width}.png'), full_page=True)
        browser.close()
    assert not errors, errors
    print('MANAGER_DESIGN_E2E_PASS responsive=320,390,768,1280 header-icons=users,password nav=3 overflow=0 screenshots=' + str(SCREENSHOTS), flush=True)

if __name__ == '__main__':
    main()
