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


def download_once(page: Page, path: Path) -> None:
    page.locator('[data-page="finance"]:visible').first.click()
    page.locator('[data-action="download-pdf"]:visible').wait_for(timeout=10_000)
    fallback = page.locator('.pdf-fallback a[download]')
    assert fallback.count() == 1
    assert fallback.get_attribute('href') == '/api/export.pdf'
    with page.expect_download(timeout=15_000) as pending:
        page.locator('[data-action="download-pdf"]:visible').click()
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
    dialog = page.locator('#pwaPdfBrowserDialog')
    expect(dialog).to_be_visible()
    expect(dialog.locator('#pwaPdfBrowserStatus')).to_contain_text('belum didukung')
    handoff = dialog.locator('#pwaPdfBrowserLink').input_value()
    parsed = urlparse(handoff)
    filters = parse_qs(parsed.query)
    assert parsed.netloc == urlparse(BASE).netloc and parsed.path == '/pdf-browser.html'
    assert filters == {'q': ['PDF fixture petty cash'], 'jenis': ['petty_cash'], 'status': ['approved']}, filters
    intent = dialog.locator('#pwaPdfOpenChrome').get_attribute('href') or ''
    assert intent.startswith('intent://') and 'package=com.android.chrome' in intent
    assert 'api/export.pdf' not in intent and 'blob:' not in intent
    dialog.locator('#pwaPdfCopyBrowserLink').click()
    expect(dialog.locator('#pwaPdfBrowserStatus')).to_contain_text('secara manual')
    assert dialog.locator('#pwaPdfBrowserLink').evaluate('(el) => el.selectionEnd - el.selectionStart === el.value.length')
    for width, height in ((320, 700), (390, 844), (844, 390), (1280, 900)):
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        box = dialog.bounding_box()
        assert box and box['x'] >= 0 and box['x'] + box['width'] <= width + 1
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(SCREENSHOTS / f'{label}-browser-fallback.png'), full_page=True)
    dialog.locator('.pwa-files-close').click()
    page.locator('.pdf-fallback summary').click()
    page.locator('#managerPdfFallbackLink').click()
    expect(page.locator('#pwaPdfBrowserDialog')).to_be_visible()
    assert not exports, exports
    assert page.evaluate('window.__csvBridgeCalls') == 0
    page.locator('#pwaPdfBrowserDialog .pwa-files-close').click()
    # Even if a native host keeps the fallback page inside its WebView, it must
    # not advertise direct PDF saving there.
    trapped = page.context.new_page()
    trapped.goto(handoff, wait_until='networkidle')
    expect(trapped.locator('#sessionStatus')).to_contain_text('masih di APK')
    expect(trapped.locator('#downloadPdf')).to_be_hidden()
    trapped.close()

    # A genuinely separate browser starts without the APK cookies. Login is a
    # normal browser action; no credential/session token is carried in the link.
    external = browser.new_context(viewport={'width': 390, 'height': 844}, timezone_id='Asia/Jakarta')
    external.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE + '/') else route.abort())
    handoff_page = external.new_page()
    handoff_page.goto(handoff, wait_until='networkidle')
    expect(handoff_page.locator('#sessionStatus')).to_contain_text('Belum login')
    expect(handoff_page.locator('#downloadPdf')).to_be_hidden()
    login_page = external.new_page()
    login_page.goto(BASE, wait_until='networkidle')
    login(login_page, MANAGER, password)
    login_page.close()
    handoff_page.bring_to_front()
    handoff_page.locator('#checkSession').click()
    export_link = handoff_page.locator('#downloadPdf')
    expect(export_link).to_be_visible()
    target = urlparse(export_link.get_attribute('href') or '')
    assert target.path == '/api/export.pdf' and parse_qs(target.query) == filters
    with handoff_page.expect_download(timeout=15_000) as pending:
        export_link.click()
    destination = SCREENSHOTS / f'{label}-external-filtered.pdf'
    pending.value.save_as(destination)
    assert_pdf(destination, {'PDF fixture petty cash'})
    content = subprocess.run(['pdftotext', str(destination), '-'], check=True, capture_output=True, text=True).stdout
    assert 'Mobile PDF fixture finance' not in content
    for width, height in ((320, 700), (390, 844), (844, 390), (1280, 900)):
        handoff_page.set_viewport_size({'width': width, 'height': height})
        assert handoff_page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    handoff_page.set_viewport_size({'width': 390, 'height': 844})
    handoff_page.screenshot(path=str(SCREENSHOTS / f'{label}-external-browser-final.png'), full_page=True)
    external.close()
    print(f'WEBVIEW_BROWSER_FALLBACK_PASS case={label} native_pdf_claim=0 csv_bridge_calls=0 apk_export_requests=0 separate_login=1 strict_filters=1 pdf_content=1 widths=4 native_android=0', flush=True)


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
        cases = (("webview", ANDROID_WEBVIEW_UA), ("masked-bridge", chrome_ua), ("chrome", chrome_ua))
        for label, user_agent in cases:
            context: BrowserContext = browser.new_context(
                viewport={"width": 390, "height": 844},
                is_mobile=True,
                has_touch=True,
                user_agent=user_agent,
                timezone_id="Asia/Jakarta",
            )
            if label != 'chrome':
                context.add_init_script('window.__csvBridgeCalls = 0; window.PangsumaFileBridge = {saveCsv: function() { window.__csvBridgeCalls++; }}; Object.defineProperty(navigator, "clipboard", {configurable: true, get: () => undefined});')
            context.set_default_timeout(10_000)
            context.route("**/*", lambda route: route.continue_()
                          if route.request.url.startswith(BASE + "/") else route.abort())
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(f"{label}: {error}"))
            page.goto(BASE, wait_until="networkidle", timeout=30_000)
            login(page, MANAGER, password)
            if label != 'chrome':
                webview_browser_fallback(page, browser, password, label)
                assert api(page, '/api/session')['status'] == 200
                context.close()
                continue
            destination = SCREENSHOTS / f"mobile-{label}-export.pdf"
            download_once(page, destination)
            assert_pdf(destination, expected)
            session = api(page, "/api/session")
            assert session["status"] == 200 and session["data"].get("user", {}).get("role") == "manager", session
            assert not page.locator("#loginGate").is_visible()
            page.locator('.pdf-fallback summary').click()
            with page.expect_download(timeout=15_000) as direct_pending:
                page.locator('.pdf-fallback a[download]').click()
            direct = direct_pending.value
            assert direct.failure() is None
            direct_path = SCREENSHOTS / f"mobile-{label}-direct-export.pdf"
            direct.save_as(direct_path)
            assert_pdf(direct_path, expected)
            print(f"MOBILE_PDF_DOWNLOAD_PASS ua={label} saved=1 direct_saved=1 magic=1 headings=1 content=1 session_preserved=1", flush=True)
            context.close()

        assert not errors, errors
        browser.close()
    print("MOBILE_DOWNLOAD_E2E_PASS browsers=android-webview,masked-csv-bridge,android-chrome native_android_device=0 external_browser_fallback=1 auth_server_401=1 browser_errors=0 screenshots=" + str(SCREENSHOTS), flush=True)


if __name__ == "__main__":
    main()
