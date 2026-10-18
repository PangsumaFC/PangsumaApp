"""Focused real-browser checks for manager audit edge contracts."""
from __future__ import annotations

import datetime as dt
import json
import os
import uuid

from playwright.sync_api import expect, sync_playwright

from profile_flow_e2e import BASE, MANAGER, SCREENSHOTS, api, credential, http, login, rotate_first_login, tiny_png


def seed_report(page, description: str):
    result = api(page, "/api/submissions", "POST", {
        "type": "finance_request", "amountIdr": 1250,
        "date": dt.datetime.now(dt.timezone.utc).date().isoformat(),
        "description": description, "note": "Fixture audit edge",
    }, {"Idempotency-Key": str(uuid.uuid4())})
    assert result["status"] == 201, result
    return result["data"].get("submission") or result["data"]


def main():
    password = os.environ["LOCAL_MANAGER_PASSWORD"]
    status, data, _ = http("/api/bootstrap", {"managerCredential": credential(password)},
                           headers={"Authorization": "Bearer " + os.environ["BOOTSTRAP_TOKEN"]})
    assert status == 201, (status, data)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, timezone_id="Asia/Jakarta", accept_downloads=True)
        ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(BASE + "/") else r.abort())
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        login(page, MANAGER, password)
        rotate_first_login(page, password)

        page.locator('[data-page="finance"]:visible').first.click()
        expect(page.locator("#managerReportsRegion")).to_be_visible()
        # Finance renders the two labelled groups for an authenticated manager.
        expect(page.locator("#financeReportsTitle")).to_have_text("Laporan")
        expect(page.locator("#financeCashTitle")).to_have_text("Pengelolaan kas")

        # Search is a real control: computed touch target, visible keyboard focus,
        # and no horizontal overflow in portrait, landscape, and desktop widths.
        search = page.locator('#managerReportFiltersForm [name="q"]')
        for width, height in ((320, 700), (390, 844), (844, 390), (1280, 900)):
            page.set_viewport_size({"width": width, "height": height})
            page.reload(wait_until="networkidle")
            page.locator('[data-page="finance"]:visible').first.click()
            search = page.locator('#managerReportFiltersForm [name="q"]')
            expect(search).to_be_visible()
            expect(search).to_have_css("min-height", "44px")
            expect(search).to_have_css("border-radius", "10px")
            search.focus()
            expect(search).to_be_focused()
            expect(search).to_have_css("outline-style", "solid")
            expect(search).to_have_css("outline-width", "3px")
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), width

        # Filter state is reflected in the actual export API URL, not a button href.
        advanced = page.locator("details.report-filter-advanced")
        advanced.locator("summary").click()
        search.fill("approved")
        page.locator('#managerReportFiltersForm [name="status"]').select_option("approved")
        page.locator('#managerReportFiltersForm [type="submit"]').click()
        expect(page.locator("#managerReportsRegion .manager-report-filters")).to_have_attribute("aria-busy", "false", timeout=15000)
        pdf_url = page.evaluate("() => ManagerReportFilters.pdfUrl()")
        assert pdf_url.startswith("/api/export.pdf?") and "q=approved" in pdf_url and "status=approved" in pdf_url, pdf_url

        # The primary export fails once: fallback becomes visible. A valid PDF
        # through the fallback must produce a captured browser download and hide it.
        fallback = page.locator("#managerPdfFallback")
        expect(fallback).to_be_hidden()
        page.route("**/api/export.pdf**", lambda r: r.fulfill(status=500, content_type="application/json", body=json.dumps({"error": {"code": "forced_failure"}})))
        page.locator('[data-action="download-pdf"]').click()
        expect(fallback).to_be_visible(timeout=10000)
        page.unroute("**/api/export.pdf**")
        page.route("**/api/export.pdf**", lambda r: r.fulfill(status=200, content_type="application/pdf", headers={"Content-Disposition": 'attachment; filename="audit.pdf"'}, body="%PDF-1.4\n%%EOF"))
        with page.expect_download(timeout=10000) as download_info:
            page.locator("#managerPdfFallbackLink").click()
        download = download_info.value
        assert download.suggested_filename == "audit.pdf"
        expect(fallback).to_be_hidden(timeout=10000)
        page.unroute("**/api/export.pdf**")

        # Initial receipt GET fails (503), retry is actionable, and a prepared
        # photo survives a failed refresh GET after a successful POST.
        report = seed_report(page, "Audit edge receipt retry")
        page.reload(wait_until="networkidle")
        page.locator('[data-page="finance"]:visible').first.click()
        row = page.locator("#managerReportsRegion .item-row").filter(has_text="Audit edge receipt retry")
        expect(row).to_be_visible(timeout=15000)
        receipt_get_count = 0
        def receipt_route(route):
            nonlocal receipt_get_count
            if route.request.method == "GET":
                receipt_get_count += 1
                if receipt_get_count == 1:
                    route.fulfill(status=503, content_type="application/json", body='{"error":{"code":"temporary"}}')
                else:
                    route.fulfill(status=200, content_type="application/json", body='{"items":[],"count":0,"maxCount":10}')
            else:
                route.continue_()
        page.route("**/receipts", receipt_route)
        row.locator('[data-action="report-detail"]').click()
        dialog = page.locator("#reportActivityDialog")
        receipt = dialog.locator(".receipt-workspace")
        expect(receipt).to_be_visible(timeout=10000)
        expect(receipt.locator(".receipt-retry")).to_be_visible(timeout=10000)
        receipt.locator("input.receipt-file").set_input_files({"name": "audit.png", "mimeType": "image/png", "buffer": tiny_png()})
        expect(receipt.locator(".receipt-preview")).to_be_visible(timeout=10000)
        preview = receipt.locator(".receipt-preview").get_attribute("src")
        expect(receipt.locator(".receipt-retry")).to_be_visible()
        receipt.locator(".receipt-retry").click()
        expect(receipt.locator(".receipt-count")).to_contain_text("0/10", timeout=10000)
        expect(receipt.locator(".receipt-retry")).to_have_count(0)
        expect(receipt.locator(".receipt-preview")).to_have_attribute("src", preview)
        assert receipt.locator("input.receipt-file").evaluate("el => el.files[0].name") == "audit.png"
        refresh_gets = 0
        def post_then_failed_refresh(route):
            nonlocal refresh_gets
            if route.request.method == "POST":
                route.fulfill(status=201, content_type="application/json", body='{"receipt":{"id":"edge-receipt"}}')
            else:
                refresh_gets += 1
                if refresh_gets == 1:
                    route.fulfill(status=503, content_type="application/json", body='{"error":{"code":"temporary"}}')
                else:
                    route.fulfill(status=200, content_type="application/json", body='{"items":[],"count":0,"maxCount":10}')
        page.unroute("**/receipts", receipt_route)
        page.route("**/receipts", post_then_failed_refresh)
        receipt.locator(".receipt-upload").click()
        expect(receipt.locator("input.receipt-file")).to_be_enabled(timeout=10000)
        expect(receipt.locator(".receipt-retry")).to_be_visible(timeout=10000)
        expect(receipt.locator(".receipt-status")).to_contain_text("berhasil diunggah")
        expect(receipt.locator(".receipt-preview")).to_be_hidden()
        receipt.locator(".receipt-retry").click()
        expect(receipt.locator(".receipt-retry")).to_have_count(0)
        assert refresh_gets == 2
        page.unroute("**/receipts", post_then_failed_refresh)
        assert not errors, errors
        ctx.close(); browser.close()
    print("AUDIT_EDGE_E2E_PASS manager_login=1 groups=2 responsive_viewports=4 pdf_fallback_retry=1 pdf_download=1 receipt_get_retry=1 receipt_refresh_retry=1 errors=0", flush=True)


if __name__ == "__main__":
    main()
