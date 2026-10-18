"""Bounded Chromium regressions for the known audit findings.

This suite uses only the local profile runner and its temporary D1 database.  It
keeps network races deterministic by delaying selected local API responses.
"""
from __future__ import annotations

import datetime as dt
import os
import uuid

from playwright.sync_api import expect, sync_playwright

from profile_flow_e2e import BASE, MANAGER, SCREENSHOTS, api, credential, http, login, rotate_first_login, tiny_png


def seed_report(page, description: str):
    result = api(page, "/api/submissions", "POST", {
        "type": "finance_request", "amountIdr": 1250,
        "date": dt.datetime.now(dt.timezone.utc).date().isoformat(),
        "description": description, "note": "Fixture audit lokal",
    }, {"Idempotency-Key": str(uuid.uuid4())})
    assert result["status"] == 201, result
    return result.get("data", {}).get("submission") or result.get("data")


def main():
    password = os.environ["LOCAL_MANAGER_PASSWORD"]
    status, data, _ = http("/api/bootstrap", {"managerCredential": credential(password)},
                           headers={"Authorization": "Bearer " + os.environ["BOOTSTRAP_TOKEN"]})
    assert status == 201, (status, data)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, timezone_id="Asia/Jakarta")
        ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(BASE + "/") else r.abort())
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        login(page, MANAGER, password)
        rotate_first_login(page, password)

        # Finance drafts are keyed by type: changing page/rendering must never
        # silently turn a Finance request into Petty Cash.
        page.locator('[data-action="open-report-choice"]:visible').first.click()
        page.locator("#reportType").select_option("finance_request")
        form = page.locator("#reportForm")
        form.locator('[name="amountIdr"]').fill("1250")
        form.locator('[name="description"]').fill("Draft Finance tetap")
        form.locator('[name="note"]').fill("Jangan hilang saat navigasi")
        page.locator('[data-page="finance"]:visible').first.click()
        page.locator('[data-page="overview"]:visible').first.click()
        page.locator('[data-action="open-report-choice"]:visible').first.click()
        expect(page.locator("#reportType")).to_have_value("finance_request")
        expect(page.locator('#reportForm [name="description"]')).to_have_value("Draft Finance tetap")
        expect(page.locator('#reportForm [name="amountIdr"]')).to_have_value("1250")
        expect(page.locator('#reportForm [name="note"]')).to_have_value("Jangan hilang saat navigasi")

        # Native selects emit input before change. Both stored drafts and retry
        # keys must remain isolated when repeatedly switching form types.
        finance_key, petty_key = str(uuid.uuid4()), str(uuid.uuid4())
        page.evaluate("key => writeDraft('report', 'finance_request', {...readDraft('report','finance_request'), idempotencyKey:key})", finance_key)
        page.locator("#reportType").select_option("petty_cash")
        expect(page.locator('#reportForm [name="description"]')).to_have_value("")
        page.locator('#reportForm [name="amountIdr"]').fill("990")
        page.locator('#reportForm [name="description"]').fill("Draft Petty terpisah")
        page.locator('#reportForm [name="note"]').fill("Catatan Petty saja")
        page.evaluate("key => writeDraft('report', 'petty_cash', {...readDraft('report','petty_cash'), idempotencyKey:key})", petty_key)
        page.locator("#reportType").select_option("finance_request")
        expect(page.locator('#reportForm [name="amountIdr"]')).to_have_value("1250")
        expect(page.locator('#reportForm [name="description"]')).to_have_value("Draft Finance tetap")
        expect(page.locator('#reportForm [name="note"]')).to_have_value("Jangan hilang saat navigasi")
        assert page.evaluate("submissionIdempotencyKey") == finance_key
        page.locator("#reportType").select_option("petty_cash")
        expect(page.locator('#reportForm [name="amountIdr"]')).to_have_value("990")
        expect(page.locator('#reportForm [name="description"]')).to_have_value("Draft Petty terpisah")
        assert page.evaluate("submissionIdempotencyKey") == petty_key
        page.locator("#reportType").select_option("finance_request")

        # Manager refresh/polling is allowed to update server state but not an
        # active new-report draft.  Delayed overview makes the race observable.
        pending = page.locator('#reportForm [name="description"]')
        pending.fill("Draft polling tidak tertimpa")
        held: list = []
        def hold_overview(route):
            held.append(route)
            # Keep the response pending until the draft assertion has run.
        page.route("**/api/overview", hold_overview)
        # Do not await this intentionally held request: evaluate() otherwise
        # waits for the Promise returned by refreshManagerOverview and deadlocks.
        page.evaluate("void refreshManagerOverview({force:true})")
        page.wait_for_timeout(150)
        expect(pending).to_have_value("Draft polling tidak tertimpa")
        assert held, "refresh race did not issue an overview request"
        held[0].continue_()
        page.unroute("**/api/overview", hold_overview)
        page.wait_for_timeout(100)
        expect(page.locator("#reportForm")).to_be_visible()
        expect(page.locator('#reportForm [name="description"]')).to_have_value("Draft polling tidak tertimpa")

        # Advanced filters remain compact, keyboard accessible, and fit every
        # supported viewport.  Search is server-backed and status uses raw aliases.
        page.locator('[data-page="finance"]:visible').first.click()
        region = page.locator("#managerReportsRegion")
        advanced = region.locator("details.report-filter-advanced")
        expect(advanced.locator("summary")).to_be_visible()
        assert advanced.locator("summary").evaluate("el => el.tagName === 'SUMMARY'")
        advanced.locator("summary").click()
        region.locator('[name="q"]').fill("approved")
        region.locator('[name="status"]').select_option("approved")
        region.locator('[type="submit"]').click()
        expect(region.locator(".manager-filtered-results, .empty-state")).to_be_visible(timeout=15000)
        assert "approved" in (page.locator("#managerPdfFallbackLink").get_attribute("href") or "")
        for width, height in ((320, 700), (390, 844), (844, 390), (1280, 900)):
            page.set_viewport_size({"width": width, "height": height})
            page.reload(wait_until="networkidle")
            page.locator('[data-page="finance"]:visible').first.click()
            expect(page.locator("#appContent")).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), width
            expect(page.locator(".report-filter-advanced summary")).to_be_visible()

        # A late receipts GET alone is not a close guard.  Pending selected photo
        # (X/backdrop/Escape, with a declined confirmation) and processing/upload
        # (hard guard) are the actual product invariants.
        fixture = seed_report(page, "Evidence GET terlambat")
        page.reload(wait_until="networkidle")
        page.locator('[data-page="finance"]:visible').first.click()
        row = page.locator("#managerReportsRegion .item-row").filter(has_text="Evidence GET terlambat")
        expect(row).to_be_visible(timeout=15000)
        receipt_gets: list = []
        def hold_initial_receipts(route):
            if route.request.method == "GET":
                receipt_gets.append(route)
                return
            route.continue_()
        page.route("**/receipts", hold_initial_receipts)
        row.locator('[data-action="report-detail"]').click()
        dialog = page.locator("#reportActivityDialog")
        expect(dialog).to_be_visible(timeout=10000)
        expect(dialog.locator(".receipt-workspace")).to_be_visible(timeout=10000)
        expect(dialog.locator(".receipt-count")).to_contain_text("Memuat")
        receipt = dialog.locator(".receipt-workspace")
        expect(receipt.locator(".receipt-upload")).to_be_disabled()
        assert receipt_gets, "initial receipt GET was not held"
        receipt_gets.pop(0).fulfill(status=200, content_type="application/json", body='{"items":[],"count":0,"maxCount":10}')
        page.unroute("**/receipts", hold_initial_receipts)
        receipt.locator("input.receipt-file").set_input_files({"name": "audit-tiny.png", "mimeType": "image/png", "buffer": tiny_png()})
        expect(receipt.locator(".receipt-preview")).to_be_visible(timeout=10000)
        page.once("dialog", lambda d: d.dismiss())
        dialog.locator('[data-action="close-dialog"]').click()
        expect(dialog).to_be_visible()
        page.once("dialog", lambda d: d.dismiss())
        dialog.evaluate("d => d.dispatchEvent(new MouseEvent('click', {bubbles:true, clientX:0, clientY:0}))")
        expect(dialog).to_be_visible()
        page.once("dialog", lambda d: d.dismiss())
        page.keyboard.press("Escape")
        expect(dialog).to_be_visible()
        page.once("dialog", lambda d: d.accept())
        dialog.locator('[data-action="close-dialog"]').click()
        expect(dialog).to_be_hidden()

        # Hold the post and the refresh GET after commit.  The picker must stay
        # disabled while upload is pending, then become navigable after both
        # responses resolve.
        page.locator('[data-page="finance"]:visible').first.click()
        row = page.locator("#managerReportsRegion .item-row").filter(has_text="Evidence GET terlambat")
        row.locator('[data-action="report-detail"]').click()
        dialog = page.locator("#reportActivityDialog")
        receipt = dialog.locator(".receipt-workspace")
        expect(receipt).to_be_visible(timeout=10000)
        receipt.locator("input.receipt-file").set_input_files({"name": "audit-tiny.png", "mimeType": "image/png", "buffer": tiny_png()})
        expect(receipt.locator(".receipt-upload")).to_be_enabled(timeout=10000)
        pending_posts: list = []
        pending_gets: list = []
        def hold_upload_and_reload(route):
            if route.request.method == "POST":
                pending_posts.append(route)
            else:
                pending_gets.append(route)
        page.route("**/receipts", hold_upload_and_reload)
        receipt.locator(".receipt-upload").click()
        expect(receipt.locator(".receipt-upload")).to_be_disabled()
        expect(receipt.locator("input.receipt-file")).to_be_disabled()
        assert pending_posts, "receipt POST was not held"
        pending_posts[0].fulfill(status=201, content_type="application/json", body='{"receipt":{"id":"audit-receipt"}}')
        for _ in range(100):
            if pending_gets:
                break
            page.wait_for_timeout(50)
        assert pending_gets, "receipt refresh GET was not held"
        pending_gets[0].fulfill(status=200, content_type="application/json", body='{"items":[],"count":0,"maxCount":10}')
        expect(receipt.locator(".receipt-upload")).to_be_disabled(timeout=10000)
        expect(receipt.locator("input.receipt-file")).to_be_enabled(timeout=10000)
        assert receipt.locator(".receipt-upload").get_attribute("aria-busy") == "false"
        page.unroute("**/receipts", hold_upload_and_reload)
        dialog.locator('[data-action="close-dialog"]').click()
        expect(dialog).to_be_hidden()

        # Top-up uses the same close policy while its commit request is pending.
        page.locator('[data-page="finance"]:visible').first.click()
        page.locator('[data-action="open-cash-topup"]').click()
        topup = page.locator("#cashTopupDialog")
        topup.locator("#cashTopupAmount").fill("1000")
        topup.locator("#cashTopupNote").fill("Fixture topup lokal")
        held_topup: list = []
        def hold_topup(route):
            held_topup.append(route)
        page.route("**/cash/topups", hold_topup)
        topup.locator("#cashTopupSubmit").click()
        expect(topup.locator("#cashTopupSubmit")).to_be_disabled()
        topup.locator('[data-action="close-dialog"]').first.click()
        expect(topup).to_be_visible()
        page.keyboard.press("Escape")
        expect(topup).to_be_visible()
        assert held_topup
        held_topup[0].fulfill(status=201, content_type="application/json", body='{"topup":{"id":"local-topup"}}')
        page.unroute("**/cash/topups", hold_topup)
        expect(topup).to_be_hidden(timeout=10000)

        # User and manager rosters must refresh status without a full page reload.
        email = "audit-user-" + uuid.uuid4().hex[:8] + "@local.test"
        created = api(page, "/api/users", "POST", {"name": "Audit User Refresh", "email": email, "position": "Fixture"})
        assert created["status"] == 201, created
        user_id = created["data"]["user"]["id"]
        temporary_password = "Audit-user-local-fixture-2026"
        reset = api(page, f"/api/users/{user_id}/password", "POST", {"credential": credential(temporary_password)})
        assert reset["status"] == 200, reset
        page.locator('[data-page="users"]:visible').first.click()
        manager_user_row = page.locator("tbody tr").filter(has_text=email)
        expect(manager_user_row).to_contain_text("Wajib ganti password")
        user_ctx = browser.new_context(viewport={"width": 390, "height": 844}, timezone_id="Asia/Jakarta")
        user_ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(BASE + "/") else r.abort())
        user_page = user_ctx.new_page()
        user_page.on("pageerror", lambda e: errors.append(str(e)))
        user_page.goto(BASE, wait_until="networkidle")
        login(user_page, email, temporary_password)
        rotate_first_login(user_page, temporary_password)
        page.bring_to_front()
        page.evaluate("() => requestManagerOverviewRefresh(true)")
        expect(manager_user_row).to_contain_text("Siap masuk", timeout=10000)
        user_page.bring_to_front()
        own = seed_report(user_page, "Laporan User target")
        petty = api(user_page, "/api/submissions", "POST", {"type":"petty_cash", "amountIdr":1250, "date":dt.datetime.now(dt.timezone.utc).date().isoformat(), "description":"Petty User terpisah", "note":"Fixture"}, {"Idempotency-Key":str(uuid.uuid4())})
        assert petty["status"] == 201, petty
        user_page.locator('[data-page="my-reports"]:visible').first.click()
        search = user_page.locator("#archiveSearch")
        search.fill("Laporan User target")
        expect(user_page.locator("#archiveResults .item-row")).to_have_count(1, timeout=10000)
        expect(search).to_be_focused()
        approved = api(page, f"/api/submissions/{own['id']}/approve", "POST", {})
        assert approved["status"] == 200, approved
        user_page.evaluate("() => requestUserOverviewRefresh()")
        expect(user_page.locator("#archiveResults .item-row")).to_contain_text("Disetujui", timeout=10000)
        expect(search).to_have_value("Laporan User target")
        expect(search).to_be_focused()
        search.fill("Disetujui")
        expect(user_page.locator("#archiveResults .item-row")).to_have_count(1, timeout=10000)
        expect(user_page.locator("#archiveResults .item-row")).to_contain_text("Laporan User target")
        search.fill("")
        expect(user_page.locator("#archiveResults .item-row")).to_have_count(2, timeout=10000)
        user_page.locator('[data-report-filter="petty_cash"]').click()
        expect(user_page.locator("#archiveResults .item-row")).to_have_count(1, timeout=10000)
        expect(user_page.locator("#archiveResults .item-row")).to_contain_text("Petty User terpisah")
        user_ctx.close()

        assert not errors, errors
        ctx.close(); browser.close()
    print("AUDIT_REGRESSIONS_E2E_PASS draft_type_preserved=1 polling_draft_preserved=1 server_status_alias=1 delayed_evidence_close_guard=1 topup_busy_guard=1 responsive_viewports=4 errors=0", flush=True)


if __name__ == "__main__":
    main()
