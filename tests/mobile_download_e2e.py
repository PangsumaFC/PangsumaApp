"""Local-only PDF download regression for Android WebView and Chrome emulation.

This deliberately uses Chromium UA/device emulation; it is not evidence from a
native Android device.
"""
from __future__ import annotations

import subprocess
import os
import uuid
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright
from urllib.parse import parse_qs, urlparse

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

ANDROID_WEBVIEW_UA = (
    "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 "
    "Chrome/120.0.6099.144 Mobile Safari/537.36"
)


def assert_pdf(path: Path, expected_text: set[str]) -> None:
    raw = path.read_bytes()
    assert raw.startswith(b"%PDF-"), "download must be a PDF"
    completed = subprocess.run(["pdftotext", str(path), "-"], check=True, capture_output=True, text=True)
    text = completed.stdout
    for heading in ("RINGKASAN", "Buku Kas", "Lampiran Audit"):
        # Check actual rendered content, not only MIME or the file extension.
        assert heading in text, (heading, text[:1000])
    text = " ".join(text.split())
    for value in ("Rp500.000", "Rp125.000", "Rp375.000"):
        assert value in text, (value, text[:1500])
    for fixture in expected_text:
        assert fixture in text, (fixture, text[:1000])


def download_once(page: Page, path: Path, standalone: bool = False) -> None:
    page.locator('[data-page="finance"]:visible').first.click()
    page.locator('[data-action="download-pdf"]:visible').wait_for(timeout=10_000)
    fallback = page.locator('.pdf-fallback a[download]')
    assert fallback.count() == 1
    assert fallback.get_attribute('href') == '/api/export.pdf'
    if standalone:
        page.locator('[data-action="download-pdf"]:visible').click()
        expect(page.locator('#pwaPdfDownload')).to_have_attribute('href', __import__('re').compile('^blob:'))
    with page.expect_download(timeout=15_000) as pending:
        page.locator('#pwaPdfDownload' if standalone else '[data-action="download-pdf"]:visible').click()
    download = pending.value
    assert download.failure() is None
    download.save_as(path)


def webview_browser_fallback(page: Page, browser: Browser, password: str, label: str) -> None:
    page.locator('[data-page="finance"]:visible').first.click()
    region = page.locator('#managerReportsRegion')
    region.locator('[name="q"]').fill('PDF fixture petty cash')
    region.locator('[name="jenis"]').select_option('petty_cash')
    region.locator('[name="status"]').select_option('approved')
    region.locator('[type="submit"]').click()
    expect(region.locator('.manager-filtered-results .item-row')).to_have_count(1)
    exports: list[str] = []
    page.on('request', lambda request: exports.append(request.url) if '/api/export.pdf' in request.url else None)
    page.locator('[data-action="download-pdf"]:visible').click()
    dialog = page.locator('#pwaPdfApkDialog')
    expect(dialog).to_be_visible()
    expect(dialog.locator('#pwaPdfApkStatus')).to_have_text('Unduh PDF langsung memerlukan APK yang diperbarui.')
    expect(dialog.locator('.pwa-files-close')).to_have_count(1)
    assert dialog.locator('a').count() == 0
    assert page.evaluate('window.__csvBridgeCalls') == 0
    assert page.evaluate('window.__openCalls') == 0
    assert not exports, exports
    dialog.locator('.pwa-files-close').click()
    # The manager fallback remains visible as a message, but has no browser/direct link in the APK.
    assert page.locator('#managerPdfFallbackLink').count() == 0
    expect(page.locator('.pdf-apk-status')).to_have_text('Unduh PDF langsung memerlukan APK yang diperbarui.')
    assert page.locator('.pdf-fallback, a[href^="intent:"], #pwaPdfCopyBrowserLink, #pwaPdfBrowserLink').count() == 0
    assert page.evaluate('window.__clipboardCalls') == 0
    assert len(page.context.pages) == 1
    # Direct navigation to the legacy browser page is blocked by the confirmed bridge too.
    trapped = page.context.new_page()
    trapped.goto(f'{BASE}/pdf-browser.html?q=PDF+fixture+petty+cash&jenis=petty_cash&status=approved', wait_until='networkidle')
    expect(trapped.locator('#downloadPdf')).to_be_hidden()
    expect(trapped.locator('#checkSession')).to_be_hidden()
    expect(trapped.locator('#loginLink')).to_be_hidden()
    expect(trapped.locator('#browserInstructions')).to_be_hidden()
    expect(trapped.locator('#sessionStatus')).to_have_text('Unduh PDF langsung memerlukan APK yang diperbarui.')
    trapped.close()
    for width, height in ((320, 700), (390, 844), (844, 390), (1280, 900)):
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(SCREENSHOTS / f'{label}-apk-status.png'), full_page=True)
    print(f'WEBVIEW_APK_STATUS_PASS case={label} native_pdf_claim=0 csv_bridge_calls=0 apk_export_requests=0 popup_calls=0 clipboard_calls=0 legacy_browser_blocked=1', flush=True)


def main() -> None:
    token = os.environ.get("BOOTSTRAP_TOKEN")
    temporary = os.environ.get("LOCAL_MANAGER_PASSWORD")
    assert token and len(token) >= 32, "runner must provide a local BOOTSTRAP_TOKEN"
    assert temporary and len(temporary) >= 12
    status, data, _ = http(
        "/api/bootstrap",
        {"managerCredential": credential(temporary)},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert status == 201, (status, data)

    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    expected = {
        "PDF fixture petty cash",
        "Mobile PDF fixture finance",
    }
    errors: list[str] = []
    with sync_playwright() as playwright:
        browser: Browser = playwright.chromium.launch(
            executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"]
        )
        seed_context = browser.new_context(viewport={"width": 390, "height": 844})
        seed_context.route("**/*", lambda route: route.continue_()
                           if route.request.url.startswith(BASE + "/") else route.abort())
        seed = seed_context.new_page()
        seed.goto(BASE, wait_until="networkidle", timeout=30_000)
        login(seed, MANAGER, temporary)
        password = rotate_first_login(seed, temporary)
        overview = api(seed, "/api/overview")
        assert overview["status"] == 200 and overview["data"]["user"]["role"] == "manager"
        opening = api(seed, "/api/cash/opening-balance", "POST", {
            "amountIdr": 500000, "ownerConfirmed": True,
        })
        assert opening["status"] == 201, opening
        for kind, amount, description in (
            ("petty_cash", 125000, "PDF fixture petty cash"),
            ("finance_request", 75000, "Mobile PDF fixture finance"),
        ):
            result = api(seed, "/api/submissions", "POST", {
                "type": kind, "amountIdr": amount, "date": "2026-10-18",
                "description": description,
            }, {"Idempotency-Key": str(uuid.uuid4())})
            assert result["status"] == 201, result
        seed_context.close()

        # A missing/invalid session must fail at the server, independently of UI state.
        unauthenticated = http("/api/export.pdf", method="GET")
        assert unauthenticated[0] == 401, unauthenticated
        assert unauthenticated[1].get("error", {}).get("code") == "authentication_required"

        chrome_ua = playwright.devices['Pixel 7']['user_agent']
        cases = (("webview", ANDROID_WEBVIEW_UA), ("masked-bridge", chrome_ua), ("chrome", chrome_ua), ("standalone", chrome_ua))
        for label, user_agent in cases:
            context: BrowserContext = browser.new_context(
                viewport={"width": 390, "height": 844},
                is_mobile=True,
                has_touch=True,
                user_agent=user_agent,
                timezone_id="Asia/Jakarta",
            )
            if label in ('webview', 'masked-bridge'):
                context.add_init_script('window.__csvBridgeCalls = 0; window.__openCalls = 0; window.__clipboardCalls = 0; window.open = function() { window.__openCalls++; }; window.PangsumaFileBridge = {saveCsv: function() { window.__csvBridgeCalls++; }}; Object.defineProperty(navigator, "clipboard", {configurable: true, get: () => ({writeText: () => { window.__clipboardCalls++; return Promise.resolve(); }})});')
            if label == 'standalone':
                context.add_init_script('const originalMatchMedia = window.matchMedia.bind(window); window.matchMedia = query => query === "(display-mode: standalone)" ? {matches: true, media: query, addEventListener() {}, removeEventListener() {}} : originalMatchMedia(query);')
            context.set_default_timeout(10_000)
            context.route("**/*", lambda route: route.continue_()
                          if route.request.url.startswith(BASE + "/") else route.abort())
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(f"{label}: {error}"))
            page.goto(BASE, wait_until="networkidle", timeout=30_000)
            login(page, MANAGER, password)
            if label in ('webview', 'masked-bridge'):
                webview_browser_fallback(page, browser, password, label)
                assert api(page, '/api/session')['status'] == 200
                context.close()
                continue
            destination = SCREENSHOTS / f"mobile-{label}-export.pdf"
            download_once(page, destination, label == 'standalone')
            assert_pdf(destination, expected)
            session = api(page, "/api/session")
            assert session["status"] == 200 and session["data"].get("user", {}).get("role") == "manager", session
            assert not page.locator("#loginGate").is_visible()
            if label == 'standalone':
                page.locator('#pwaPdfDialog .pwa-files-close').click()
            page.locator('.pdf-fallback summary').click()
            with page.expect_download(timeout=15_000) as direct_pending:
                page.locator('.pdf-fallback a[download]').click()
            direct = direct_pending.value
            assert direct.failure() is None
            direct_path = SCREENSHOTS / f"mobile-{label}-direct-export.pdf"
            direct.save_as(direct_path)
            assert_pdf(direct_path, expected)
            region = page.locator('#managerReportsRegion')
            region.locator('[name="q"]').fill('PDF fixture petty cash')
            region.locator('[name="jenis"]').select_option('petty_cash')
            region.locator('[type="submit"]').click()
            expect(region.locator('.manager-filtered-results .item-row')).to_have_count(1)
            if label == 'standalone':
                page.locator('[data-action="download-pdf"]:visible').click()
                expect(page.locator('#pwaPdfDownload')).to_have_attribute('href', __import__('re').compile('^blob:'))
            with page.expect_download(timeout=15_000) as filtered_pending:
                page.locator('#pwaPdfDownload' if label == 'standalone' else '[data-action="download-pdf"]:visible').click()
            filtered_path = SCREENSHOTS / f'mobile-{label}-filtered.pdf'
            filtered_pending.value.save_as(filtered_path)
            filtered_text = subprocess.run(['pdftotext', str(filtered_path), '-'], check=True, capture_output=True, text=True).stdout
            assert 'PDF fixture petty cash' in ' '.join(filtered_text.split())
            assert 'Mobile PDF fixture finance' not in ' '.join(filtered_text.split())
            print(f"MOBILE_PDF_DOWNLOAD_PASS ua={label} saved=1 direct_saved=1 magic=1 headings=1 content=1 session_preserved=1", flush=True)
            context.close()

        assert not errors, errors
        browser.close()
    print("MOBILE_DOWNLOAD_E2E_PASS browsers=android-webview,masked-csv-bridge,android-chrome,standalone native_android_device=0 apk_status_only=1 auth_server_401=1 browser_errors=0 screenshots=" + str(SCREENSHOTS), flush=True)


if __name__ == "__main__":
    main()
