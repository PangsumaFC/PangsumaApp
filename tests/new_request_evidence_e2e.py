"""Local/mock Playwright coverage for new-request evidence and idempotency.

This suite never contacts production: the reusable loopback fixture serves the site,
and Playwright routes every API write to an in-memory mock.  It is intentionally
runnable as a plain script as well as under pytest.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright, expect

from qa_fixture_server import serve_in_thread

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = Path("/workspace/pangsuma-new-evidence-qa")
EVIDENCE_ASSET = os.environ.get("PANGSUMA_QA_EVIDENCE_ASSET")
# A valid 1x1 PNG; synthetic and contains no real user data.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _json(route, value: Any, status: int = 200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(value))


def run_combo(role: str, kind: str, browser, index: int):
    server, _ = serve_in_thread(host="127.0.0.1", port=0)
    base = f"http://127.0.0.1:{server.server_port}"
    writes: list[dict[str, Any]] = []
    receipts: dict[str, dict[str, Any]] = {}
    submission_counter = 0
    fail_receipt_once = True
    lose_upload_once = True
    lose_submission_once = True

    def route_handler(route):
        nonlocal submission_counter, fail_receipt_once, lose_upload_once, lose_submission_once
        req = route.request
        url = req.url
        # The page may load only this loopback origin. Any other request is blocked.
        if not url.startswith(base + "/"):
            route.abort()
            return
        # Optional downloaded public asset: execution and every API write still
        # stay on loopback/mocks, including when checking a deployed release.
        if EVIDENCE_ASSET and url.split("?", 1)[0].endswith("/report-evidence.js"):
            route.fulfill(content_type="application/javascript", body=Path(EVIDENCE_ASSET).read_text())
            return
        if req.method == "POST" and url.endswith("/api/submissions/duplicate-check"):
            _json(route, {"matches": []})
            return
        if req.method == "POST" and url.endswith("/api/submissions"):
            body = req.post_data_json or {}
            key = req.headers.get("idempotency-key", "")
            writes.append({"kind": "submission", "key": key, "body": body})
            # Simulate a committed write whose response is lost. The next request
            # with the same key receives the normal idempotent replay.
            existing = next((x for x in writes[:-1] if x["kind"] == "submission" and x["key"] == key), None)
            if existing:
                _json(route, {"alreadyCreated": True, "submission": existing["submission"]})
                return
            submission_counter += 1
            submission = {"id": f"mock-submission-{index}-{submission_counter}", "createdBy": f"qa-{role}", **body}
            writes[-1]["submission"] = submission
            if lose_submission_once:
                lose_submission_once = False
                # Backend commit is represented by the in-memory row; client sees
                # a transport failure and must replay the same key and payload.
                route.abort("failed")
            else:
                _json(route, {"submission": submission}, 201)
            return
        if req.method == "POST" and "/api/submissions/" in url and url.endswith("/receipts"):
            body = req.post_data_json or {}
            key = req.headers.get("idempotency-key", "")
            submission_id = url.split("/api/submissions/", 1)[1].split("/receipts", 1)[0]
            writes.append({"kind": "receipt", "key": key, "body": body, "submission": submission_id})
            prior = next((x for x in writes[:-1] if x["kind"] == "receipt" and x["key"] == key and not x.get("failed")), None)
            if prior:
                _json(route, {"receipt": {"id": "mock-receipt-1", **prior["body"]}}, 201)
                receipts[submission_id] = {"id": "mock-receipt-1", "filename": prior["body"].get("filename"), "sizeBytes": 10, "url": "/api/receipts/mock-receipt-1"}
                return
            if fail_receipt_once:
                fail_receipt_once = False
                writes[-1]["failed"] = True
                _json(route, {"error": {"code": "mock_receipt_failure", "message": "Simulasi receipt gagal"}}, 503)
                return
            if lose_upload_once:
                lose_upload_once = False
                receipts[submission_id] = {"id": "mock-receipt-lost", "filename": body.get("filename"), "sizeBytes": 10, "url": "/api/receipts/mock-receipt-lost"}
                route.abort("failed")
                return
            receipts[submission_id] = {"id": "mock-receipt-1", "filename": body.get("filename"), "sizeBytes": 10, "url": "/api/receipts/mock-receipt-1"}
            _json(route, {"receipt": receipts[submission_id]}, 201)
            return
        if req.method == "GET" and "/api/submissions/" in url and url.endswith("/receipts"):
            submission_id = url.split("/api/submissions/", 1)[1].split("/receipts", 1)[0]
            item = receipts.get(submission_id)
            _json(route, {"items": [item] if item else [], "count": 1 if item else 0, "maxCount": 10, "canUpload": True})
            return
        route.continue_()

    context = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Asia/Jakarta")
    page = context.new_page()
    page.route("**/*", route_handler)
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        page.goto(f"{base}/{'user' if role == 'user' else 'manager'}", wait_until="networkidle")
        page.wait_for_timeout(300)
        page.evaluate("navigateToPage('new-report')")
        form = page.locator("#reportForm")
        expect(form).to_be_visible()
        page.locator("#reportType").select_option(kind)
        page.locator("#reportAmount").fill("125000")
        page.locator("#reportDescription").fill(f"QA {role} {kind} evidence")
        page.locator("#reportNote").fill("Synthetic local evidence")
        page.locator("#reportDate").fill("2026-10-19")
        evidence = page.locator(".new-request-evidence")
        file_input = evidence.locator("input[type=file]")
        file_input.set_input_files({"name": "synthetic-receipt.png", "mimeType": "image/png", "buffer": PNG})
        expect(evidence.locator(".receipt-preview")).to_be_visible(timeout=5000)
        # Draft survives navigation and reload, scoped by owner and type.
        assert not evidence.locator(".receipt-consent input").count()
        page.evaluate("navigateToPage('overview')")
        page.evaluate("navigateToPage('new-report')")
        expect(page.locator(".new-request-evidence .receipt-preview")).to_be_visible()
        expect(page.locator("#reportType")).to_have_value(kind)
        page.reload(wait_until="networkidle")
        page.evaluate("navigateToPage('new-report')")
        expect(page.locator(".new-request-evidence .receipt-preview")).to_be_visible()
        assert not page.locator(".receipt-consent input").count()

        # First submit commits the report but loses its response. Retry must use
        # exactly one idempotency key and identical payload, then receipt fails.
        page.locator("#reportForm button[type=submit]").click()
        expect(page.locator("#reportForm")).to_be_visible(timeout=5000)
        expect(page.locator("body")).to_contain_text("Pengiriman belum terkonfirmasi")
        page.wait_for_timeout(250)
        submission_writes = [w for w in writes if w["kind"] == "submission"]
        assert len(submission_writes) == 1
        page.locator("#reportForm button[type=submit]").click()
        page.wait_for_timeout(250)
        expect(page.locator("body")).to_contain_text("Pengajuan sudah tersimpan")
        expect(page.locator(".new-request-evidence .receipt-status")).to_have_text("Simulasi receipt gagal")
        submission_writes = [w for w in writes if w["kind"] == "submission"]
        assert len(submission_writes) == 2
        assert submission_writes[0]["key"] == submission_writes[1]["key"]
        assert submission_writes[0]["body"] == submission_writes[1]["body"]
        assert len([w for w in writes if w["kind"] == "receipt"]) == 1, writes

        # Retry after receipt failure: the dedicated upload retry must skip a
        # second submission POST, preserve upload key and payload, and retain
        # the browser's specific offline error after renderDraft() runs in
        # finally.  The next retry then replays the identical upload.
        page.locator(".new-request-evidence .receipt-retry").click()
        page.wait_for_timeout(250)
        expect(page.locator(".new-request-evidence .receipt-status")).to_contain_text("Failed to fetch")
        assert not page.locator(".new-request-evidence .receipt-status").inner_text().startswith("Pengajuan tersimpan")
        assert len([w for w in writes if w["kind"] == "submission"]) == 2
        page.locator(".new-request-evidence .receipt-retry").click()
        page.wait_for_timeout(250)
        expect(page.locator("body")).to_contain_text("Laporan")
        receipt_writes = [w for w in writes if w["kind"] == "receipt"]
        assert len(receipt_writes) == 3, receipt_writes
        assert len({w["key"] for w in receipt_writes}) == 1
        assert len({w["submission"] for w in receipt_writes}) == 1
        assert receipt_writes[0]["body"] == receipt_writes[1]["body"] == receipt_writes[2]["body"]
        assert len([w for w in writes if w["kind"] == "submission"]) == 2

        # SVG is rejected before any new network write.
        page.evaluate("navigateToPage('new-report')")
        svg_before = len(writes)
        page.locator(".new-request-evidence input[type=file]").set_input_files({"name": "bad.svg", "mimeType": "image/svg+xml", "buffer": b"<svg/>"})
        expect(page.locator(".new-request-evidence .receipt-status")).to_contain_text("SVG tidak didukung")
        assert len(writes) == svg_before
        page.screenshot(path=str(SCREENSHOTS / f"{role}-{kind}-1280.png"), full_page=True)
        assert not errors, errors
    finally:
        context.close()
        server.shutdown()


def main():
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        try:
            for index, (role, kind) in enumerate(((r, t) for r in ("user", "manager") for t in ("petty_cash", "finance_request")), 1):
                run_combo(role, kind, browser, index)
        finally:
            browser.close()
    print(f"NEW_REQUEST_EVIDENCE_E2E_PASS combos=4 screenshots={SCREENSHOTS}")


if __name__ == "__main__":
    main()
