"""Reconciliation draft regressions on the real app; loopback only, mocked writes."""
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, str(Path(__file__).parent))
from qa_fixture_server import serve_in_thread


def main():
    server, _ = serve_in_thread()
    base = f"http://127.0.0.1:{server.server_port}"
    posts, blocked = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        context = browser.new_context(service_workers="block", timezone_id="Asia/Jakarta")
        def route_request(route):
            req = route.request
            if not req.url.startswith(base + "/"):
                blocked.append(req.url); return route.abort()
            if urlsplit(req.url).path == "/api/cash/reconciliations":
                if req.method == "GET":
                    period = parse_qs(urlsplit(req.url).query)["period"][0]
                    return route.fulfill(json={"reconciliations": [], "hasMore": False, "preview": {"period": period, "ledgerBalanceIdr": "100000", "ledgerCutoffId": 1}})
                posts.append({"body": req.post_data_json, "key": req.headers.get("idempotency-key")})
                return route.fulfill(status=503, json={"error": {"code": "mock_retry", "message": "Respons lokal hilang; coba lagi"}})
            return route.continue_()
        context.route("**/*", route_request)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        def open_finance():
            page.locator('[data-page="finance"]:visible').first.click()
            page.locator('[data-fc-section="reconciliation"] summary').click()
            expect(page.locator('.fc-preview')).to_contain_text('100.000')
        def select_period(value):
            page.locator('#fc-reconciliation-form [name="period"]').fill(value)
            page.locator('#fc-reconciliation-form [name="period"]').dispatch_event('change')
            expect(page.locator('.fc-preview')).to_contain_text('100.000')
            expect(page.locator('#fc-reconciliation-form [name="period"]')).to_have_value(value)
        def amount(): return page.locator('#fc-reconciliation-form [name="physicalCashIdr"]')
        def note(): return page.locator('#fc-reconciliation-form [name="note"]')
        def confirmed(): return page.locator('#fc-reconciliation-form [name="confirmed"]')
        page.goto(base + '/manager', wait_until='networkidle')
        open_finance(); select_period('2026-08')
        amount().fill('123'); note().fill('Agustus aman'); confirmed().check()
        select_period('2026-09')
        expect(amount()).to_have_value(''); expect(note()).to_have_value(''); expect(confirmed()).not_to_be_checked()
        amount().fill('456'); note().fill('September aman'); confirmed().check()
        select_period('2026-08')
        expect(amount()).to_have_value('123'); expect(note()).to_have_value('Agustus aman'); expect(confirmed()).not_to_be_checked()
        page.reload(wait_until='networkidle'); open_finance()
        expect(page.locator('#fc-reconciliation-form [name="period"]')).to_have_value('2026-09')
        expect(amount()).to_have_value('456'); expect(note()).to_have_value('September aman'); expect(confirmed()).not_to_be_checked()
        select_period('2026-08'); confirmed().check()
        for i in range(2):
            page.locator('#fc-reconciliation-form [type="submit"]').click()
            expect(page.locator('#fc-reconciliation-form [type="submit"]')).to_be_enabled()
            expect(page.locator('.fc-error')).to_contain_text('Fitur menunggu')
        assert len(posts) == 2 and posts[0]['key'] == posts[1]['key'], posts
        assert all(x['body']['period'] == '2026-08' and x['body']['physicalCashIdr'] == 123 for x in posts)
        select_period('2026-09'); confirmed().check()
        page.locator('#fc-reconciliation-form [type="submit"]').click()
        expect(page.locator('#fc-reconciliation-form [type="submit"]')).to_be_enabled()
        select_period('2026-08'); confirmed().check()
        page.locator('#fc-reconciliation-form [type="submit"]').click()
        expect(page.locator('#fc-reconciliation-form [type="submit"]')).to_be_enabled()
        assert len(posts) == 4 and posts[0]['key'] == posts[3]['key'] and posts[2]['key'] != posts[3]['key'], posts
        # Altering reviewed values invalidates the checkbox immediately.
        amount().fill('124'); expect(confirmed()).not_to_be_checked()
        # A forged/stale form month cannot overwrite another month's saved draft or submit.
        before = page.evaluate("sessionStorage.getItem('pangsuma.financial.reconciliation.v2:qa-manager')")
        page.evaluate("() => { const f=document.querySelector('#fc-reconciliation-form'); f.elements.period.value='2026-07'; f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); }")
        expect(page.locator('[data-fc-error]')).to_contain_text('Pilih ulang periode')
        assert page.evaluate("sessionStorage.getItem('pangsuma.financial.reconciliation.v2:qa-manager')") == before
        assert len(posts) == 4
        # An unrelated authenticated account must receive a clean form, not this account's draft.
        page.evaluate("() => { state.user={...state.user,id:'qa-manager-other'}; FinancialControls.clear(); renderApp(); }")
        page.locator('[data-fc-section="reconciliation"] summary').click()
        expect(amount()).to_have_value(''); expect(note()).to_have_value('')
        # Legacy drafts remain recoverable explicitly and never restore their old confirmation.
        page.evaluate("() => { sessionStorage.setItem('pangsuma.financial.reconciliation.v2:qa-manager-other',JSON.stringify({physicalCashIdr:'789',note:'Legacy preserved',confirmed:true})); FinancialControls.clear(); renderApp(); }")
        page.locator('[data-fc-section="reconciliation"] summary').click()
        expect(amount()).to_have_value('')
        page.locator('[data-fc-action="restore-legacy"]').click()
        expect(amount()).to_have_value('789'); expect(note()).to_have_value('Legacy preserved'); expect(confirmed()).not_to_be_checked()
        assert not blocked and not errors, (blocked, errors)
        browser.close()
    server.shutdown()
    print('RECONCILIATION_QA_PASS switch=1 reload=1 account_isolation=1 legacy_recovery=1 confirmation_reset=1 mismatch_rejected=1 retry_key=1 loopback_only=1 production_writes=0')


if __name__ == '__main__':
    main()
