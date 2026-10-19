from __future__ import annotations

import os
import secrets
import uuid

from playwright.sync_api import expect, sync_playwright
from profile_flow_e2e import (
    BASE, MANAGER, SCREENSHOTS, api, credential, http, login,
    login_user_and_rotate, rotate_first_login,
)


def main():
    password = os.environ['LOCAL_MANAGER_PASSWORD']
    status, body, _ = http('/api/bootstrap', {'managerCredential': credential(password)},
                           headers={'Authorization': 'Bearer ' + os.environ['BOOTSTRAP_TOKEN']})
    assert status == 201, (status, body)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        manager_ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
        user_ctx = browser.new_context(viewport={'width': 390, 'height': 844})
        for ctx in (manager_ctx, user_ctx):
            ctx.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE + '/') else route.abort())
        manager = manager_ctx.new_page()
        manager.on('pageerror', lambda e: errors.append(str(e)))
        manager.goto(BASE, wait_until='networkidle', timeout=30_000)
        login(manager, MANAGER, password)
        rotate_first_login(manager, password)
        initial = api(manager, '/api/overview')['data']
        target = next(u for u in initial['users'] if u['role'] == 'user' and u['active'])
        manager.locator('[data-page="users"]').first.click()
        row = manager.locator('tbody tr').filter(has_text=target['name'])
        row.wait_for(timeout=10_000)
        row.locator('[data-action="reset-user-password"]').click()
        temporary = 'Sync-local-' + secrets.token_urlsafe(14)
        manager.locator('#temporaryPassword').fill(temporary)
        manager.locator('#userPasswordSubmit').click()
        manager.locator('#userPasswordDialog').wait_for(state='hidden', timeout=20_000)
        user = user_ctx.new_page()
        user.on('pageerror', lambda e: errors.append(str(e)))
        user.goto(BASE, wait_until='networkidle', timeout=30_000)
        login_user_and_rotate(user, target['email'], temporary)
        manager.locator('[data-page="overview"]').first.click()
        manager.locator('.welcome-card').wait_for(timeout=10_000)
        manager.bring_to_front()
        assert manager.evaluate('document.hidden') is False
        # Instrument notifications without invoking any dashboard refresh or action.
        manager.evaluate('''() => {
          window.__syncToastCount = 0;
          const original = showToast;
          window.showToast = (...args) => { window.__syncToastCount++; return original(...args); };
        }''')
        responses = []
        manager.on('response', lambda response: responses.append(response.headers.get('cache-control', ''))
                   if response.url == BASE + '/api/overview' else None)
        for kind in ('finance_request', 'petty_cash'):
            description = 'Auto sync ' + kind + ' ' + uuid.uuid4().hex[:8]
            result = api(user, '/api/submissions', 'POST', {
                'type': kind, 'amountIdr': 23000, 'date': '2026-10-17',
                'description': description, 'note': 'Local two-session auto refresh test',
            }, {'Idempotency-Key': str(uuid.uuid4())})
            assert result['status'] == 201, result
            # No manager clicks, focus events, reloads, evaluate(refresh...), or writes here.
            expect(manager.locator('#appContent')).to_contain_text(description, timeout=36_000)
            assert manager.evaluate('window.__syncToastCount') == 0
            print(f'MANAGER_AUTO_SYNC_PASS type={kind} user_submit=201 manager_auto_visible=1 manager_actions=0 duplicate_toast=0', flush=True)
        assert responses and all('no-store' in value for value in responses), responses
        current = api(manager, '/api/overview')['data']
        assert current['cashBalanceIdr'] == initial['cashBalanceIdr']
        assert current['cashLedger'] == initial['cashLedger']
        for path in ('/api/overview', '/api/submissions', '/api/history/submissions'):
            own = api(user, path)
            assert own['status'] == 200
            assert 'cashBalanceIdr' not in own['data'] and 'cashLedger' not in own['data']
            assert all(item['createdBy'] == target['id'] for item in own['data']['submissions'])
            assert {item['type'] for item in own['data']['submissions']} == {'finance_request', 'petty_cash'}
        for path in ('/api/history/cash-ledger', '/api/history/audit-events'):
            assert api(user, path)['status'] == 403
        assert api(user, '/api/export.csv')['status'] == 404
        assert manager.evaluate('window.__syncToastCount') == 0
        SCREENSHOTS.mkdir(parents=True, exist_ok=True)
        manager.screenshot(path=str(SCREENSHOTS / 'manager-auto-new-submissions.png'), full_page=True)
        user.screenshot(path=str(SCREENSHOTS / 'user-cash-private.png'), full_page=True)
        user_ctx.close()
        manager_ctx.close()
        browser.close()
    assert not errors, errors
    print('MANAGER_SYNC_FLOW_PASS request=1 petty_cash=1 no_manager_action=1 no_store=1 no_duplicate_toast=1 user_cash_private=1 balance_unchanged=1 ledger_unchanged=1 screenshots=' + str(SCREENSHOTS), flush=True)


if __name__ == '__main__':
    main()
