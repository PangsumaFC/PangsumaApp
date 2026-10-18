"""Local-only dashboard design and behavior regression."""
import os
import secrets
import uuid
from datetime import date
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from profile_flow_e2e import BASE, MANAGER, SCREENSHOTS, credential, http, login, rotate_first_login, api


def create_request(page, kind, description, amount=1000):
    result = api(page, "/api/submissions", "POST", {
        "type": kind, "amountIdr": amount, "date": date.today().isoformat(),
        "description": description, "note": "Dashboard design fixture",
    }, {"Idempotency-Key": str(uuid.uuid4())})
    assert result["status"] == 201, result
    return result["data"]["submission"]["id"]


def capture(page, path):
    page.wait_for_function("() => getComputedStyle(document.getElementById('toast')).opacity === '0'")
    page.evaluate("document.activeElement?.blur(); document.getElementById('mainContent').scrollTop = 0; window.scrollTo(0, 0)")
    page.screenshot(path=str(path), full_page=True)


def main():
    manager_password = os.environ["LOCAL_MANAGER_PASSWORD"]
    status, data, _ = http("/api/bootstrap", {"managerCredential": credential(manager_password)},
                           headers={"Authorization": "Bearer " + os.environ["BOOTSTRAP_TOKEN"]})
    assert status == 201, (status, data)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        manager_ctx = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Asia/Jakarta")
        manager_ctx.route("**/*", lambda route: route.continue_() if route.request.url.startswith(BASE + "/") else route.abort())
        manager = manager_ctx.new_page()
        manager.on("pageerror", lambda error: errors.append("manager: " + str(error)))
        manager.goto(BASE, wait_until="networkidle", timeout=30_000)
        login(manager, MANAGER, manager_password)
        manager_password = rotate_first_login(manager, manager_password)

        # Create a fresh user through the real manager APIs, then use the existing
        # client credential endpoint so this test does not depend on seeded names.
        email = f"dashboard-{secrets.token_hex(5)}@example.invalid"
        created = api(manager, "/api/users", "POST", {"name": "Dashboard Fixture", "email": email, "position": "QA"})
        assert created["status"] == 201, created
        user_id = created["data"]["user"]["id"]
        temporary = "Dashboard-temp-" + secrets.token_urlsafe(10)
        reset = api(manager, f"/api/users/{user_id}/password", "POST", {"credential": credential(temporary)})
        assert reset["status"] == 200, reset

        user_ctx = browser.new_context(viewport={"width": 390, "height": 844}, timezone_id="Asia/Jakarta", is_mobile=True, has_touch=True)
        user_ctx.route("**/*", lambda route: route.continue_() if route.request.url.startswith(BASE + "/") else route.abort())
        user = user_ctx.new_page()
        user.on("pageerror", lambda error: errors.append("user: " + str(error)))
        user.goto(BASE, wait_until="networkidle", timeout=30_000)
        login(user, email, temporary)
        # Mandatory first-login change using the shared helper contract.
        new_password = "Dashboard-user-" + secrets.token_urlsafe(10)
        user.locator("#currentPassword").fill(temporary)
        user.locator("#newPassword").fill(new_password)
        user.locator("#confirmPassword").fill(new_password)
        user.locator("#passwordForm button[type='submit']").click()
        user.locator("#passwordForm").wait_for(state="detached", timeout=20_000)

        own = create_request(user, "finance_request", "User finance pending")
        petty = create_request(user, "petty_cash", "User petty pending", 500)
        finance_approved = create_request(user, "finance_request", "User finance approved")
        reject_id = create_request(user, "finance_request", "User finance rejected")
        # One real manager-owned request verifies self-decision protection.
        manager_own = create_request(manager, "finance_request", "Manager own request")
        self_decision = api(manager, f"/api/submissions/{manager_own}/approve", "POST", {})
        assert self_decision["status"] == 403 and self_decision["data"]["error"]["code"] == "self_decision_not_allowed", self_decision

        approved = api(manager, f"/api/submissions/{own}/approve", "POST", {})
        assert approved["status"] == 200 and approved["data"]["submission"]["status"] == "approved", approved
        finance_ok = api(manager, f"/api/submissions/{finance_approved}/approve", "POST", {})
        assert finance_ok["status"] == 200, finance_ok
        sent = api(manager, f"/api/submissions/{own}/send", "POST", {})
        assert sent["status"] == 200 and sent["data"]["submission"]["status"] == "sent", sent
        rejected = api(manager, f"/api/submissions/{reject_id}/reject", "POST", {"reason": "Bukti belum lengkap"})
        assert rejected["status"] == 200 and rejected["data"]["submission"]["decisionReason"] == "Bukti belum lengkap", rejected
        # Petty request remains pending; zero balance must never be bypassed for a visual test.

        # User dashboard: one visible primary CTA (plus mobile nav is the same action).
        user.reload(wait_until="networkidle")
        user.locator("#loginGate").wait_for(state="hidden", timeout=15_000)
        expect(user.locator(".user-primary-action")).to_have_count(0)
        expect(user.locator(".user-status-section")).to_have_count(1)
        assert user.locator(".user-status-section .item-row").count() <= 3
        assert user.locator(".mobile-nav.is-user .mobile-add").count() == 1
        assert user.locator(".account-users-button").is_hidden()
        expect(user.locator(".account-password-button")).to_be_visible()
        expect(user.locator(".user-status-section")).to_contain_text("Bukti belum lengkap")
        user.locator("[data-page=\"new-report\"]:visible").first.click()
        expect(user.locator("#reportForm")).to_be_visible()
        user.locator("#reportType").select_option("finance_request")
        expect(user.locator("#reportType")).to_have_value("finance_request")
        user.locator("#reportType").select_option("petty_cash")
        expect(user.locator("#reportType")).to_have_value("petty_cash")
        user.locator("[data-page=\"overview\"]:visible").first.click()
        for width in (390, 320, 768, 1280):
            user.set_viewport_size({"width": width, "height": 844})
            user.wait_for_timeout(100)
            measured = user.evaluate("() => ({w: document.documentElement.clientWidth, s: document.documentElement.scrollWidth})")
            assert measured["s"] <= measured["w"] + 1, measured
            capture(user, SCREENSHOTS / f"dashboard-user-{width}.png")

        # Offline notice is visibility-only and must disappear again without clearing data.
        before = user.locator("#appContent").inner_text()
        user_ctx.set_offline(True)
        expect(user.locator("#offlineNotice")).to_be_visible()
        expect(user.locator("#offlineNotice")).to_contain_text("Data terakhir tetap tampil")
        user_ctx.set_offline(False)
        expect(user.locator("#offlineNotice")).to_be_hidden()
        assert user.locator("#appContent").inner_text() == before

        manager.reload(wait_until="networkidle")
        manager.locator("#loginGate").wait_for(state="hidden", timeout=15_000)
        expect(manager.locator(".balance-panel")).to_be_visible()
        expect(manager.locator(".metric").filter(has_text="Menunggu persetujuan")).to_contain_text("1")
        expect(manager.locator(".recent-section")).to_have_count(1)
        expect(manager.locator(".manager-action-queue")).to_have_count(0)
        assert manager.locator(".item-actions").count() == 0
        ids = manager.locator(".item-row [data-action=report-detail]").evaluate_all("els => els.map(e => e.dataset.id)")
        assert len(ids) == len(set(ids)), ids
        manager.locator("[data-page=finance]:visible").first.click()
        expect(manager.locator("[data-panel=\"cash-insights\"]")).to_have_count(1)
        send = manager.locator(f'[data-action="send-finance"][data-id="{finance_approved}"]')
        expect(send).to_be_visible(timeout=15_000)
        expect(manager.locator(f'[data-action="send-finance"][data-id="{own}"]')).to_have_count(0)
        manager.evaluate("state.submissions = []")  # Filter page need not exist in the summary/history page.
        send.click()
        expect(manager.locator("#confirmDialog")).to_be_visible()
        manager.locator("#confirmForm button[type=submit]").click()
        expect(manager.locator("#confirmDialog")).to_be_hidden()
        expect(manager.locator(f'[data-action="send-finance"][data-id="{finance_approved}"]')).to_have_count(0)
        assert api(manager, "/api/overview")["data"]["summary"]["financeWaiting"] == 1
        assert manager.locator('.item-side').evaluate_all("els => els.every(e => e.getBoundingClientRect().width >= 144)")
        assert manager.locator('.item-amount').evaluate_all("els => els.every(e => e.getBoundingClientRect().height < 32)")
        capture(manager, SCREENSHOTS / "dashboard-manager-finance-1280.png")
        manager.locator("[data-page=overview]:visible").first.click()
        for width in (390, 320, 768, 1280):
            manager.set_viewport_size({"width": width, "height": 844})
            manager.wait_for_timeout(100)
            measured = manager.evaluate("() => ({w: document.documentElement.clientWidth, s: document.documentElement.scrollWidth})")
            assert measured["s"] <= measured["w"] + 1, measured
            capture(manager, SCREENSHOTS / f"dashboard-manager-{width}.png")
        assert not errors, errors
        browser.close()
    print(f"DASHBOARD_DESIGN_E2E_PASS screenshots={SCREENSHOTS}", flush=True)


if __name__ == "__main__":
    main()
