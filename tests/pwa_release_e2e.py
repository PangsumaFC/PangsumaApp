"""Local PWA release E2E: manager users layout and native receipt evidence.

Chromium is used as a physical-browser simulation only; this test does not claim
Android hardware or an installed PWA.  The important writes are seeded through
the local API, while navigation, file selection, preview, upload, and dialog
reopen are exercised through the rendered UI.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

from financial_controls_e2e import receipt_png, seed_report
from profile_flow_e2e import BASE, MANAGER, SCREENSHOTS, api, credential, http, login, rotate_first_login


def choose_receipt(page: Page, raw: bytes) -> None:
    """Use the actual native chooser event, with a PNG lacking an extension."""
    picker = page.locator(".receipt-file")
    assert picker.count() == 1
    with page.expect_file_chooser(timeout=10_000) as pending:
        page.locator(".receipt-file-label").click()
    pending.value.set_files({"name": "receipt-without-extension", "mimeType": "", "buffer": raw})


def open_report_detail(page: Page, description: str) -> tuple[Page, str]:
    page.locator('[data-page="finance"]:visible').first.click()
    region = page.locator("#managerReportsRegion")
    expect(region).to_be_visible(timeout=15_000)
    region.locator('[name="q"]').fill(description)
    region.locator('[type="submit"]').click()
    row = region.locator(".manager-filtered-results .item-row").filter(has_text=description).first
    expect(row).to_be_visible(timeout=15_000)
    report_id = row.locator('[data-action="report-detail"]').get_attribute("data-id")
    assert report_id
    row.locator('[data-action="report-detail"]').click()
    dialog = page.locator("#reportActivityDialog")
    expect(dialog).to_be_visible(timeout=15_000)
    expect(dialog.locator(".receipt-workspace")).to_be_visible(timeout=15_000)
    return page, report_id


def assert_users_layout(page: Page, width: int) -> None:
    page.set_viewport_size({"width": width, "height": 900 if width >= 768 else 844})
    page.reload(wait_until="networkidle", timeout=30_000)
    header_button = page.locator('[data-page="users"]:visible').first
    expect(header_button).to_be_visible(timeout=10_000)
    header_button.click()
    table = page.locator(".table-wrap:has(.user-actions) table").first
    expect(table).to_be_visible(timeout=15_000)
    metrics = page.evaluate(
        """() => {
          const table = document.querySelector('.table-wrap:has(.user-actions) table');
          const wrap = table?.closest('.table-wrap');
          const buttons = [...document.querySelectorAll('.user-actions button')].map(el => {
            const r = el.getBoundingClientRect();
            return {w:r.width, h:r.height};
          });
          const cell = document.querySelector('.user-actions')?.closest('td');
          const cr = cell?.getBoundingClientRect();
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            tableRight: table?.getBoundingClientRect().right,
            viewport: window.innerWidth,
            wrapRight: wrap?.getBoundingClientRect().right,
            cellWidth: cr?.width,
            parentWidth: (() => { const p=cell?.parentElement; if(!p)return null; const s=getComputedStyle(p); return p.getBoundingClientRect().width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth); })(),
            buttons
          };
        }"""
    )
    assert metrics["overflow"] <= 0, (width, metrics)
    assert metrics["tableRight"] <= metrics["viewport"] + 1, (width, metrics)
    assert metrics["wrapRight"] <= metrics["viewport"] + 1, (width, metrics)
    assert metrics["buttons"], (width, metrics)
    assert all(item["w"] >= 44 and item["h"] >= 44 for item in metrics["buttons"]), (width, metrics)
    if width <= 390:
        # On card-sized mobile layouts, action controls must fill their parent cell.
        assert metrics["cellWidth"] is not None and metrics["parentWidth"] is not None
        assert metrics["cellWidth"] >= metrics["parentWidth"] - 2, (width, metrics)
    page.screenshot(path=str(SCREENSHOTS / f"users-{width}.png"), full_page=True)


def main() -> None:
    token = os.environ.get("BOOTSTRAP_TOKEN")
    password = os.environ.get("LOCAL_MANAGER_PASSWORD")
    assert token and len(token) >= 32, "runner must provide BOOTSTRAP_TOKEN"
    assert password and len(password) >= 12, "runner must provide LOCAL_MANAGER_PASSWORD"
    status, body, _ = http(
        "/api/bootstrap",
        {"managerCredential": credential(password)},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert status == 201 and body.get("userCount", body.get("seededUsers")) == 10, (status, body)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    description = "PWA release receipt chooser fixture " + uuid.uuid4().hex[:10]
    browser_errors: list[str] = []
    console_violations: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Asia/Jakarta")
        context.set_default_timeout(15_000)
        context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(BASE + "/") else route.abort())
        page = context.new_page()
        page.on("pageerror", lambda exc: browser_errors.append(str(exc)))
        page.on("console", lambda msg: console_violations.append(msg.text) if msg.type == "error" and any(term in msg.text.lower() for term in ("content security policy", "csp violation")) else None)
        page.goto(BASE, wait_until="networkidle", timeout=30_000)
        login(page, MANAGER, password)
        password = rotate_first_login(page, password)

        # The users menu must be reached through the header button, not by a URL shortcut.
        for width in (320, 390, 768, 1280):
            assert_users_layout(page, width)
        page.set_viewport_size({"width": 1280, "height": 900})

        fixture = seed_report(page, description, amount=12500)
        report_id = fixture["id"]
        open_report_detail(page, description)
        receipt = page.locator(".receipt-workspace")
        raw = receipt_png(1, 1)
        choose_receipt(page, raw)
        preview = receipt.locator(".receipt-preview")
        expect(preview).to_be_visible(timeout=15_000)
        page.wait_for_function("el => el.complete && el.naturalWidth > 0", arg=preview.element_handle())
        assert page.evaluate("el => ({naturalWidth: el.naturalWidth, src: el.src})", preview.element_handle())["naturalWidth"] > 0
        assert preview.get_attribute("src").startswith("blob:")
        expect(receipt.locator(".receipt-upload")).to_be_enabled(timeout=15_000)

        # Browser picker cancellation is simulated at the file input boundary; the prepared photo must survive.
        receipt.locator(".receipt-file").dispatch_event("cancel")
        expect(preview).to_be_visible()
        expect(receipt.locator(".receipt-upload")).to_be_enabled()
        prepared_name = receipt.locator(".receipt-file-name").text_content()
        assert prepared_name == "receipt-without-extension"

        with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/submissions/{report_id}/receipts"), timeout=20_000) as pending:
            receipt.locator(".receipt-upload").click()
        assert pending.value.status == 201
        expect(receipt.locator(".receipt-status")).to_contain_text("berhasil", timeout=15_000)
        expect(receipt.locator(".receipt-list img")).to_have_count(1, timeout=15_000)
        page.locator('#reportActivityDialog [data-action="close-dialog"]').click()
        page.locator("#reportActivityDialog").wait_for(state="detached", timeout=10_000)

        # Reopen the same report detail through the rendered action and verify persisted evidence.
        open_report_detail(page, description)
        reopened = page.locator(".receipt-workspace")
        expect(reopened.locator(".receipt-list img")).to_have_count(1, timeout=15_000)
        private = api(page, f"/api/submissions/{report_id}/receipts")
        assert private["status"] == 200 and len(private["data"].get("items", [])) == 1, private
        assert not browser_errors, browser_errors
        assert not console_violations, console_violations
        page.locator('#reportActivityDialog [data-action="close-dialog"]').click()
        context.close()
        browser.close()
    print("PWA_RELEASE_E2E_PASS users_viewports=4 screenshots=users-320,390,768,1280 overflow=0 touch_buttons_min44=1 native_file_chooser=1 generic_png_signature=1 cancel_preserved=1 receipt_post=201 reopen_persisted=1 android_device=0 installed_pwa=0", flush=True)


if __name__ == "__main__":
    main()
