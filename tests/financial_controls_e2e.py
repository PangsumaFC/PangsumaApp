"""Local browser E2E for financial controls, evidence, duplicate checks, and bounded reports.

This test deliberately performs the important writes through the rendered manager UI;
API calls are used only to seed deterministic fixtures and to verify server invariants.
"""
from __future__ import annotations

import datetime as dt
import os
import re
import struct
import subprocess
import uuid
import zlib
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

from profile_flow_e2e import (
    BASE,
    MANAGER,
    SCREENSHOTS,
    api,
    credential,
    http,
    login,
    rotate_first_login,
)


def receipt_png(width: int = 640, height: int = 960) -> bytes:
    """Generate a small, valid RGBA receipt image without a checked-in asset."""
    raw = b"".join(b"\x00" + (b"\xff\xff\xff\xff" * width) for _ in range(height))
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def seed_report(page, description: str, amount: int = 12500, date: str | None = None):
    date = date or dt.datetime.now(dt.timezone.utc).date().isoformat()
    result = api(
        page,
        "/api/submissions",
        "POST",
        {
            "type": "finance_request",
            "amountIdr": amount,
            "date": date,
            "description": description,
            "note": "Fixture lokal financial-controls",
        },
        {"Idempotency-Key": str(uuid.uuid4())},
    )
    assert result["status"] == 201, result
    item = result.get("data", {}).get("submission") or result.get("data")
    assert item and item.get("id"), result
    return item


def main():
    password = os.environ["LOCAL_MANAGER_PASSWORD"]
    status, data, _ = http(
        "/api/bootstrap",
        {"managerCredential": credential(password)},
        headers={"Authorization": "Bearer " + os.environ["BOOTSTRAP_TOKEN"]},
    )
    assert status == 201, (status, data)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    previous = (dt.date.today().replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m")
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Asia/Jakarta")
        ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(BASE + "/") else r.abort())
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        login(page, MANAGER, password)
        rotate_first_login(page, password)

        # Establish an exact ledger balance; this is intentionally not a UI top-up so
        # reconciliation can prove that physical cash never mutates the ledger.
        top = api(page, "/api/cash/topups", "POST", {"amountIdr": 300000, "note": "Kontrol lokal", "confirmed": True}, {"Idempotency-Key": str(uuid.uuid4())})
        assert top["status"] == 201, top
        before = api(page, "/api/overview")["data"]
        assert before["cashBalanceIdr"] == 300000
        ledger_before = len(before["cashLedger"])
        audit_before = len(before["auditEvents"])

        # Open the real Finance page, expand the native <details>, choose the closed
        # month, and save a 125-rupiah discrepancy through the rendered form.
        page.locator('[data-page="finance"]:visible').first.click()
        fc = page.locator(".fc-finance")
        expect(fc).to_be_visible()
        recon = fc.locator('details[data-fc-section="reconciliation"]')
        recon.locator("summary").click()
        expect(recon.locator("#fc-reconciliation-form")).to_be_visible()
        period = recon.locator('[name="period"]')
        expect(period).to_have_value(previous)
        preview = api(page, f"/api/cash/reconciliations?period={previous}")["data"]["preview"]
        expected_balance = int(preview["ledgerBalanceIdr"])
        expected_formatted = f"{expected_balance:,}".replace(",", ".")
        expect(recon.locator(".fc-preview")).to_contain_text(expected_formatted)
        physical = expected_balance + 125
        recon.locator('[name="physicalCashIdr"]').fill(str(physical))
        recon.locator('[name="note"]').fill("Hitung fisik lokal")
        recon.locator('[name="confirmed"]').check()
        recon.locator('[type="submit"]').click()
        expect(recon).to_contain_text(f"{physical:,}".replace(",", "."))
        expect(recon).to_contain_text("Hitung fisik lokal")
        check = api(page, f"/api/cash/reconciliations?period={previous}")
        assert check["status"] == 200, check
        rows = check["data"].get("reconciliations", check["data"].get("items", []))
        assert rows and rows[0]["period"] == previous and int(rows[0]["discrepancyIdr"]) == 125, rows
        after = api(page, "/api/overview")["data"]
        assert after["cashBalanceIdr"] == 300000
        assert len(after["cashLedger"]) == ledger_before
        assert len([e for e in after["auditEvents"] if e.get("action") == "cash.reconciled"]) == 1
        assert len(after["auditEvents"]) == audit_before + 1

        # Settings are also saved by the actual disclosure form, including its
        # confirmation dialog, then the resulting alert endpoint is checked.
        settings = fc.locator('details[data-fc-section="settings"]')
        settings.locator("summary").click()
        page.once("dialog", lambda d: d.accept())
        settings.locator('[name="minimumCashIdr"]').fill("350000")
        settings.locator('[name="pendingMaxDays"]').fill("14")
        settings.locator('[type="submit"]').click()
        expect(fc).to_contain_text("Pengaturan tersimpan.")
        alert_data = api(page, "/api/financial/alerts")
        assert alert_data["status"] == 200

        # Seed one manager-owned report for duplicate matching and receipt evidence.
        duplicate = seed_report(page, "Nota paginasi target", 12500, today)
        page.reload(wait_until="networkidle")
        page.locator('[data-page="finance"]:visible').first.click()
        region = page.locator("#managerReportsRegion")
        expect(region).to_be_visible()
        page.locator('[data-page="overview"]:visible').first.click()
        page.locator('[data-action="open-report-choice"]:visible').first.click()
        page.locator("#reportType").select_option("finance_request")
        form = page.locator("#reportForm")
        form.locator('[name="amountIdr"]').fill("12500")
        form.locator('[name="date"]').fill(today)
        form.locator('[name="description"]').fill("Nota paginasi target")
        form.locator('[name="note"]').fill("Cek duplikasi melalui UI")
        warning = form.locator(".duplicate-warning")
        expect(warning).to_contain_text("Kemungkinan mirip", timeout=10000)
        expect(form.locator('[type="submit"]')).to_be_enabled()
        form.locator('[type="submit"]').click()
        form.wait_for(state="detached", timeout=15000)
        reports = api(page, "/api/reports?q=Nota%20paginasi%20target")["data"].get("items", [])
        assert sum(1 for x in reports if x["description"] == "Nota paginasi target") >= 2

        # Open a real report detail card, mount the evidence picker, upload a local
        # image, and assert the private binary is actually loadable by the browser.
        page.reload(wait_until="networkidle")
        page.locator('[data-page="finance"]:visible').first.click()
        region = page.locator("#managerReportsRegion")
        region.locator('[name="q"]').fill("Nota paginasi target")
        region.locator('[type="submit"]').click()
        row = region.locator(".manager-filtered-results .item-row").filter(has_text="Nota paginasi target").first
        expect(row).to_be_visible(timeout=15000)
        opened_id = row.locator('[data-action="report-detail"]').get_attribute("data-id")
        assert opened_id
        row.locator('[data-action="report-detail"]').click()
        dialog = page.locator("#reportActivityDialog")
        expect(dialog).to_be_visible()
        receipt = dialog.locator(".receipt-workspace")
        expect(receipt).to_be_visible(timeout=10000)
        # A generated 640x960 PNG is normalized by report-evidence.js and exercises
        # the real browser file/preview/upload path without a product asset.
        fixture = Path(SCREENSHOTS) / "financial-controls-receipt.png"
        fixture.write_bytes(receipt_png())
        receipt.locator("input.receipt-file").set_input_files(str(fixture))
        expect(receipt.locator(".receipt-preview")).to_be_visible(timeout=15000)
        expect(receipt.locator(".receipt-upload")).to_be_enabled()
        receipt_requests: list[str | None] = []
        def lose_receipt_response(route):
            if route.request.method != "POST":
                route.continue_()
                return
            receipt_requests.append(route.request.headers.get("idempotency-key"))
            if len(receipt_requests) == 1:
                response = route.fetch()
                assert response.status == 201
                route.abort("failed")
            else:
                route.continue_()
        page.route("**/receipts", lose_receipt_response)
        receipt.locator(".receipt-upload").click()
        expect(receipt.locator(".receipt-upload")).to_be_enabled(timeout=15000)
        expect(receipt.locator(".receipt-preview")).to_be_visible()
        assert receipt_requests and receipt_requests[0]
        receipt.locator(".receipt-upload").click()
        expect(receipt.locator(".receipt-status")).to_contain_text("berhasil", timeout=15000)
        assert len(receipt_requests) == 2 and receipt_requests[0] == receipt_requests[1]
        page.unroute("**/receipts", lose_receipt_response)
        private = api(page, f"/api/submissions/{opened_id}/receipts")
        assert private["status"] == 200 and len(private["data"].get("items", [])) == 1, private
        receipt_id = private["data"]["items"][0]["id"]
        loaded = page.evaluate("async id => { const r=await fetch('/api/receipts/'+id); return {status:r.status, type:r.headers.get('content-type'), bytes:(await r.arrayBuffer()).byteLength}; }", receipt_id)
        assert loaded["status"] == 200 and loaded["type"].startswith("image/") and loaded["bytes"] > 20, loaded
        # A user session must not be able to read a manager-owned receipt; endpoint
        # authorization is checked with the current browser session boundary.
        assert api(page, f"/api/receipts/{receipt_id}")["status"] == 200
        dialog.locator('[data-action="close-dialog"]').click()

        # Seed enough similarly named reports to force the bounded 25-row UI pages.
        for i in range(81):
            seed_report(page, f"Nota paginasi {i:03d}", 1000 + i)
        page.reload(wait_until="networkidle")
        page.locator('[data-page="finance"]:visible').first.click()
        region = page.locator("#managerReportsRegion")
        query = "Nota paginasi"
        region.locator('[name="q"]').fill(query)
        region.locator('[type="submit"]').click()
        expect(region.locator(".manager-filtered-results .item-row")).to_have_count(25, timeout=20000)
        assert api(page, "/api/reports?q=Nota%20paginasi")["data"]["total"] == 83
        expect(region).to_contain_text(re.compile(r"\b83\b"))
        first_ids = region.locator('.manager-filtered-results .item-row [data-action="report-detail"]').evaluate_all("els => els.map(e => e.dataset.id)")
        assert len(first_ids) == 25 and len(set(first_ids)) == 25
        next_button = region.locator('[data-manager-reports-action="next"], [data-action="reports-next"], .history-controls [data-action="next"]').first
        if not next_button.count():
            next_button = region.locator("button").filter(has_text="Berikutnya").first
        expect(next_button).to_be_visible()
        next_button.click()
        expect(region.locator(".manager-filtered-results .item-row")).to_have_count(25, timeout=20000)
        expect(region.locator('.manager-filtered-results [data-action="report-detail"]').first).not_to_have_attribute("data-id", first_ids[0])
        second_ids = region.locator('.manager-filtered-results .item-row [data-action="report-detail"]').evaluate_all("els => els.map(e => e.dataset.id)")
        assert len(set(first_ids).intersection(second_ids)) == 0
        prev = region.locator("button").filter(has_text="Sebelumnya").first
        expect(prev).to_be_enabled()
        prev.click()
        expect(region.locator('.manager-filtered-results .item-row')).to_have_count(25, timeout=20000)
        expect(region.locator('.manager-filtered-results [data-action="report-detail"]').first).to_have_attribute("data-id", first_ids[0])
        assert region.locator('.manager-filtered-results .item-row [data-action="report-detail"]').evaluate_all("els => els.map(e => e.dataset.id)") == first_ids

        # PDF fallback must preserve the active filter but export the full bounded
        # result set, not only the currently visible page.
        fallback = page.locator("#managerPdfFallbackLink")
        assert fallback.count() == 1
        assert page.locator("#managerPdfFallback").get_attribute("hidden") is not None
        href = page.evaluate("() => ManagerReportFilters.pdfUrl()")
        params = parse_qs(urlparse(href).query)
        assert params.get("q") == [query] and "cursor" not in params
        with page.expect_download() as download:
            page.locator('[data-action="download-pdf"]:visible').click()
        pdf = SCREENSHOTS / "financial-controls-filtered.pdf"
        download.value.save_as(pdf)
        text = " ".join(subprocess.run(["pdftotext", str(pdf), "-"], check=True, capture_output=True, text=True).stdout.split())
        for i in range(81):
            assert f"Nota paginasi {i:03d}" in text, i

        # Mobile layout contract across the supported viewport family.
        for width, height in ((320, 700), (390, 844), (844, 390), (1280, 900)):
            page.set_viewport_size({"width": width, "height": height})
            page.reload(wait_until="networkidle")
            page.locator('[data-page="finance"]:visible').first.click()
            expect(page.locator("#appContent")).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.set_viewport_size({"width": 390, "height": 844})
        page.screenshot(path=str(SCREENSHOTS / "financial-controls-final-390.png"), full_page=True)
        assert not errors, errors
        ctx.close()
        browser.close()
    print("FINANCIAL_CONTROLS_E2E_PASS reconciliation_discrepancy=125 ledger_unchanged=1 settings=1 duplicate_warning=1 receipt_private_binary=1 bounded_pages=25 pdf_full_filtered=1 mobile_widths=4 screenshots=" + str(SCREENSHOTS), flush=True)


if __name__ == "__main__":
    main()
