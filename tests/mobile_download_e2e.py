"""Local-only PDF download regression for Android WebView and Chrome emulation.

This deliberately uses Chromium UA/device emulation; it is not evidence from a
native Android device.
"""
from __future__ import annotations

import subprocess
import os
import uuid
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

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

        cases = (("webview", ANDROID_WEBVIEW_UA), ("chrome", playwright.devices["Pixel 7"]["user_agent"]))
        for label, user_agent in cases:
            context: BrowserContext = browser.new_context(
                viewport={"width": 390, "height": 844},
                is_mobile=True,
                has_touch=True,
                user_agent=user_agent,
                timezone_id="Asia/Jakarta",
            )
            context.set_default_timeout(10_000)
            context.route("**/*", lambda route: route.continue_()
                          if route.request.url.startswith(BASE + "/") else route.abort())
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(f"{label}: {error}"))
            page.goto(BASE, wait_until="networkidle", timeout=30_000)
            login(page, MANAGER, password)
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
    print("MOBILE_DOWNLOAD_E2E_PASS browsers=android-webview,android-chrome native_android_device=0 auth_server_401=1 browser_errors=0 screenshots=" + str(SCREENSHOTS), flush=True)


if __name__ == "__main__":
    main()
