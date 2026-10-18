"""Strict local PWA regression checks (Chromium display-mode simulation only).

This test does not claim Android or an installed/native PWA.  It exercises the
actual browser handlers, API filters, attachment response, and responsive DOM.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, expect, sync_playwright

from profile_flow_e2e import BASE, MANAGER, api, credential, http, login, rotate_first_login, tiny_png

ARTIFACTS = Path(os.environ.get("PROFILE_REVIEW_DIR", "/workspace/PangsumaApp-artifacts/pwa-20261018"))


def chooser_upload(page: Page, name: str, raw: bytes, mime: str = "") -> None:
    with page.expect_file_chooser(timeout=5_000) as pending:
        page.locator("label[for='profilePhoto']:visible").click()
    pending.value.set_files({"name": name, "mimeType": mime, "buffer": raw})


def open_profile(page: Page):
    page.locator(".welcome-avatar-button:visible").click()
    dialog = page.locator("#userProfileDialog")
    dialog.wait_for(state="visible", timeout=10_000)
    return dialog


def assert_pdf_text(path: Path) -> str:
    raw = path.read_bytes()
    assert raw.startswith(b"%PDF-"), raw[:20]
    text = subprocess.run(["pdftotext", str(path), "-"], check=True, capture_output=True, text=True).stdout
    assert "LAPORAN KEUANGAN" in text and "RINGKASAN" in text, text[:500]
    assert "Finance disetujui" in text or "Finance" in text, text[:500]
    return text


def assert_touch_targets(page: Page) -> None:
    result = page.evaluate("""() => [...document.querySelectorAll(
      '#userProfileDialog button, #userProfileDialog [role=button], #userProfileDialog input')].map(el => ({
        text: (el.innerText || el.getAttribute('aria-label') || el.id || '').trim(),
        rect: (() => { const r = el.getBoundingClientRect(); return {w:r.width,h:r.height}; })()
      })).filter(x => x.rect.w && x.rect.h)""")
    assert result, "profile controls were not rendered"
    for item in result:
        assert item["rect"]["w"] >= 44 and item["rect"]["h"] >= 44, item


def main() -> None:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    password = os.environ["LOCAL_MANAGER_PASSWORD"]
    token = os.environ["BOOTSTRAP_TOKEN"]
    status, body, _ = http("/api/bootstrap", {"managerCredential": credential(password)},
                           headers={"Authorization": f"Bearer {token}"})
    assert status == 201, (status, body)
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Asia/Jakarta")
        context.set_default_timeout(10_000)
        context.add_init_script("""(() => {
          const original = window.matchMedia.bind(window); window.__pwaStandaloneSimulation = true;
          window.__pwaObjectUrls = 0; const create = URL.createObjectURL.bind(URL);
          URL.createObjectURL = (...args) => { window.__pwaObjectUrls++; return create(...args); };
          window.matchMedia = query => (query === '(display-mode: standalone)' || query === '(display-mode: fullscreen)')
            ? {matches:true, media:query, onchange:null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){return false;}}
            : original(query);
        })();""")
        context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(BASE + "/") else route.abort())
        page = context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        current_build = json.loads((Path(__file__).resolve().parents[1] / "site/version.json").read_text())["build"]
        next_build = ".".join(current_build.split(".")[:-1] + [str(int(current_build.split(".")[-1]) + 1)])
        build = {"value": current_build}
        page.route("**/version.json*", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"build": build["value"]})))
        page.goto(BASE, wait_until="networkidle", timeout=30_000)
        login(page, MANAGER, password)
        password = rotate_first_login(page, password)
        assert page.evaluate("window.__pwaStandaloneSimulation") is True

        sw = page.evaluate("""async () => { const r=await navigator.serviceWorker.getRegistration(); const names=await caches.keys();
          const apiCached=(await Promise.all(names.map(async n => !!(await (await caches.open(n)).match('/api/session'))))).some(Boolean);
          return {registered:!!r,apiCached}; }""")
        assert sw == {"registered": True, "apiCached": False}, sw
        # Playwright routing cannot observe requests intercepted by a controlling SW.
        # Verify registration above, then unregister/reload so the attachment itself is observable.
        page.evaluate("""async () => { await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r => r.unregister())); }""")
        page.reload(wait_until="networkidle", timeout=30_000)
        assert page.locator("body:not(.logged-out)").count() == 1

        # Seed exactly two manager finance requests; only the first matches the applied q filter.
        fixtures = [("PWA regression included", "pwa-included"), ("Excluded separate fixture", "pwa-excluded")]
        for description, key in fixtures:
            created = api(page, "/api/submissions", "POST", {
                "type": "finance_request", "amountIdr": 125000, "date": "2026-10-18", "description": description,
            }, {"Idempotency-Key": str(uuid.uuid5(uuid.NAMESPACE_URL, key))})
            assert created["status"] == 201, created
        print("PWA_FINANCE_FIXTURES_PASS count=2 type=finance_request descriptions=1_included_1_excluded", flush=True)

        dialog = open_profile(page)
        chooser_upload(page, "avatar-generic", tiny_png(), "application/octet-stream")
        expect(dialog.locator("#profilePhotoStatus")).to_contain_text("Foto siap")
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith("/profile")) as pending:
            dialog.locator("#profileSubmit").click()
        assert pending.value.status == 200
        dialog.wait_for(state="hidden")
        assert api(page, "/api/profile")["data"]["user"]["photoUrl"]
        print("PWA_PROFILE_UPLOAD_PASS chooser=1 generic_mime=1 signature=png save=200", flush=True)

        dialog = open_profile(page)
        dialog.locator("#profileNickname").fill("PWA draft alias")
        chooser_upload(page, "draft-no-extension", tiny_png())
        expect(dialog.locator("#profilePhotoStatus")).to_contain_text("Foto siap")
        # This is the web handler's explicit cancel event, not Android OS picker evidence.
        dialog.locator("#profilePhoto").dispatch_event("cancel")
        expect(dialog.locator("#profileNickname")).to_have_value("PWA draft alias")
        expect(dialog.locator("#profilePhotoStatus")).to_contain_text("Perubahan foto sebelumnya tetap tersedia")
        print("PWA_PROFILE_CANCEL_PASS dispatched_cancel=1 photo_draft_preserved=1 nickname_preserved=1", flush=True)
        dialog.locator("[data-action='close-dialog']").first.click(); dialog.wait_for(state="hidden")

        # Responsive checks use fresh screenshots after all final CSS is loaded.
        for width, height, name in [(320, 700, "pwa-mobile-320.png"), (390, 844, "pwa-mobile-390.png"), (844, 390, "pwa-landscape-844x390.png")]:
            page.set_viewport_size({"width": width, "height": height})
            dialog = open_profile(page)
            metrics = page.evaluate("""() => { const d=document.querySelector('#userProfileDialog'), r=d.getBoundingClientRect();
              return {overflow: Math.max(0, document.documentElement.scrollWidth-innerWidth), dialogRight:r.right, viewport:innerWidth}; }""")
            assert metrics["overflow"] == 0 and metrics["dialogRight"] <= metrics["viewport"] + 1, metrics
            assert_touch_targets(page)
            page.screenshot(path=str(ARTIFACTS / name), full_page=True)
            dialog.locator("[data-action='close-dialog']").first.click(); dialog.wait_for(state="hidden")
        page.set_viewport_size({"width": 390, "height": 420})
        dialog = open_profile(page)
        inp = dialog.locator("#profileNickname")
        inp.focus(); inp.fill("keyboard reachable")
        assert page.evaluate("""() => { const e=document.activeElement, r=e.getBoundingClientRect(); return {id:e.id, reachable:r.bottom <= innerHeight + 1, scrollY}; }""")["id"] == "profileNickname"
        page.screenshot(path=str(ARTIFACTS / "pwa-keyboard-390x420.png"), full_page=True)
        dialog.locator("[data-action='close-dialog']").first.click(); dialog.wait_for(state="hidden")
        print("PWA_RESPONSIVE_PASS screenshots=320,390,844x390,keyboard390x420 dialog_overflow_x=0 touch_targets_min=44 active_input=profileNickname", flush=True)

        # Apply the real report form selectors and verify the click follows exactly that query.
        download_context = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Asia/Jakarta", service_workers="block")
        download_context.add_cookies(context.cookies())
        download_context.add_init_script("""(() => { const original=window.matchMedia.bind(window); window.__pwaStandaloneSimulation=true; window.__pwaObjectUrls=0; const create=URL.createObjectURL.bind(URL); URL.createObjectURL=(...a)=>{window.__pwaObjectUrls++;return create(...a)}; window.matchMedia=q=>(q==='(display-mode: standalone)'||q==='(display-mode: fullscreen)')?{matches:true,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return false}}:original(q); })();""")
        download_context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(BASE + "/") else route.abort())
        download_context.add_init_script("""Object.defineProperty(navigator, 'canShare', {value: value => !!value.files?.length}); Object.defineProperty(navigator, 'share', {value: value => { window.__sharedPdf = {name:value.files[0].name,type:value.files[0].type,size:value.files[0].size}; return Promise.resolve(); }});""")
        page = download_context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route("**/version.json*", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"build": build["value"]})))
        page.goto(BASE, wait_until="networkidle", timeout=30_000)
        assert page.locator("body:not(.logged-out)").count() == 1
        page.set_viewport_size({"width": 1280, "height": 900})
        page.locator('[data-page="finance"]:visible').first.click()
        form = page.locator("#managerReportFiltersForm")
        form.wait_for(state="visible")
        form.locator('.report-filter-advanced summary').click()
        form.locator("input[name='q']").fill("PWA regression included")
        form.locator("select[name='jenis']").select_option("finance_request")
        form.locator("select[name='status']").select_option("approved")
        form.locator("button[type='submit']").click()
        expect(page.locator(".manager-filtered-results")).to_contain_text("PWA regression included")
        expect(page.locator(".manager-filtered-results")).not_to_contain_text("Excluded separate fixture")
        expected = {"q": ["PWA regression included"], "jenis": ["finance_request"], "status": ["approved"]}
        export_urls: list[str] = []
        def delayed_attachment(route):
            export_urls.append(route.request.url)
            response = route.fetch()
            time.sleep(5.2)
            route.fulfill(response=response)
        def dispatch(route):
            if "/version.json" in route.request.url:
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"build": build["value"]}))
            elif "/api/export.pdf" not in route.request.url:
                route.continue_()
            else:
                delayed_attachment(route)
        page.route("**/*", dispatch)
        output = ARTIFACTS / "pwa-standalone-filtered.pdf"
        started = time.monotonic()
        page.locator('[data-action="download-pdf"]:visible').click()
        expect(page.locator("#pwaPdfDialog")).to_be_visible()
        expect(page.locator("#pwaPdfDownload")).to_have_attribute("href", re.compile("^blob:"), timeout=20_000)
        assert time.monotonic() - started >= 5.0
        assert export_urls, "no authenticated fetch observed"
        assert parse_qs(urlparse(export_urls[-1]).query) == expected, export_urls
        assert page.evaluate("window.__sharedPdf || null") is None, "must not share without a fresh gesture"
        page.locator("#pwaPdfShare").click()
        shared = page.evaluate("window.__sharedPdf")
        assert shared["type"] == "application/pdf" and shared["size"] > 0 and shared["name"].endswith(".pdf"), shared
        with page.expect_download(timeout=10_000) as download:
            page.locator("#pwaPdfDownload").click()
        dl = download.value; assert dl.failure() is None; dl.save_as(output)
        text = assert_pdf_text(output)
        assert "PWA regression included" in text and "Excluded separate fixture" not in text, text
        assert page.evaluate("window.__pwaObjectUrls") >= 1
        page.screenshot(path=str(ARTIFACTS / "pwa-pdf-ready-dialog.png"), full_page=True)
        page.locator("#pwaPdfDialog .pwa-files-close").click()
        expect(page.locator("#pwaPdfDialog")).to_have_count(0)
        assert api(page, "/api/session")["status"] == 200
        print("PWA_STANDALONE_PDF_PASS simulated_display_mode=1 delayed_fetch_ms=5200 ready_dialog=1 query_exact=1 included=1 excluded=0 actual_blob_download=1 simulated_native_share=1 session_active=1", flush=True)

        build["value"] = next_build
        page.evaluate("checkForAppUpdate()")
        page.wait_for_function("() => document.querySelector('#appUpdateBanner')?.hidden === false")
        expect(page.locator("#appUpdateBanner")).to_be_visible(timeout=10_000)
        expect(page.locator("#appUpdateVersion")).to_contain_text(next_build)
        page.locator("#logoutButton").click(); page.locator("body.logged-out").wait_for(timeout=10_000)
        expect(page.locator("#loginGate")).to_be_visible()
        assert page.locator("#appUpdateBanner").is_visible()
        page.screenshot(path=str(ARTIFACTS / "pwa-update-login-banner.png"), full_page=True)
        print("PWA_UPDATE_BANNER_PASS manager=1 logged_out=1 newer_build=1", flush=True)
        assert not errors, errors
        download_context.close(); context.close(); browser.close()
    print("PWA_STANDALONE_E2E_PASS browser_chromium=1 standalone_simulation=1 service_worker=1 api_not_cached=1 fixtures=2 strict_filters=1 delayed_fetch_gt5s=1 cancel_event=1 responsive_screenshots=1 update_manager=1 update_logged_out=1 limitations=native_android_device=0_installed_pwa=0_user_login_e2e=0 screenshots=" + str(ARTIFACTS), flush=True)


if __name__ == "__main__":
    main()
