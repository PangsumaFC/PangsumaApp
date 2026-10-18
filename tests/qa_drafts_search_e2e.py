"""Local browser regression fixture for draft recovery, profile dismissals, and account search.

Usage: python3 tests/qa_drafts_search_e2e.py
The suite starts tests/qa_fixture_server.py in-process, aborts every browser
request outside that loopback origin, and never logs in to or writes production.
Exactly 30 named scenarios are registered below; a scenario may exercise both
roles where that is the invariant under test.
"""
from __future__ import annotations

import json
import os
import sys
import base64
import struct
import zlib
from pathlib import Path
from typing import Callable

from playwright.sync_api import Browser, BrowserContext, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qa_fixture_server import serve_in_thread  # noqa: E402

SCENARIOS = [
    "finance draft restores type and fields for user",
    "finance draft restores type and fields for manager",
    "two typed drafts stay separate across type switch",
    "draft survives navigation and is idempotent on rerender",
    "draft survives reload",
    "pristine profile closes without confirmation",
    "dirty nickname Escape preserves fields",
    "dirty position backdrop preserves fields",
    "dirty quote close-button preserves fields",
    "dirty photo dismiss preserves photo draft",
    "accepting profile discard closes and clears changes",
    "account draft survives users navigation",
    "account draft survives reload",
    "account draft survives rerender",
    "explicit account cancel confirmation keeps draft",
    "explicit account cancel confirmation discards draft",
    "name search reaches records beyond first page",
    "login search reaches records beyond first page",
    "search query is retained on pagination",
    "search loading state is exposed",
    "search server error is visible and recoverable",
    "no-result search has one empty state and no duplicate rows",
    "debounce suppresses intermediate account requests",
    "stale account response cannot replace newest query",
    "account search has no duplicate UI after rerender",
    "responsive account search at 320px",
    "responsive account search at 390px",
    "responsive account search at 768px",
    "responsive account search at 1280px",
    "browser network is loopback-only and fixture writes are rejected",
]
EXPECTED = 30


def ok(condition, message=""):
    assert condition, message or "condition is false"


def visible(page: Page, selector: str):
    return page.locator(selector).filter(visible=True).first


def wait_app(page: Page):
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(150)


def goto_page(page: Page, name: str):
    page.evaluate("name => navigateToPage(name)", name)
    page.wait_for_timeout(180)


def open_users(page: Page):
    goto_page(page, "users")
    page.wait_for_timeout(250)


def account_search(page: Page):
    locator = page.locator("#usersSearch")
    if locator.count() == 0:
        locator = page.locator('#appContent input[type="search"]')
    ok(locator.count() > 0, "account search input missing")
    return locator.first


def rows(page: Page):
    return page.locator("#appContent tbody tr:visible")


def report_draft(page: Page, kind: str, description: str, amount: str):
    goto_page(page, "new-report")
    page.locator("#reportType").select_option(kind)
    page.locator("#reportDescription").fill(description)
    page.locator("#reportAmount").fill(amount)


def profile_dialog(page: Page):
    # A prior dirty-dismissal scenario intentionally leaves the dialog open;
    # accept that discard before opening the next independent scenario.
    existing = page.locator("#userProfileDialog[open]")
    if existing.count():
        page.once("dialog", lambda d: d.accept())
        page.keyboard.press("Escape")
        page.wait_for_timeout(80)
    goto_page(page, "users")
    button = page.locator('[data-action="edit-user-profile"]:visible').first
    ok(button.count() > 0, "profile edit trigger missing")
    button.click(); page.wait_for_timeout(180)
    dialog = page.locator("#userProfileDialog")
    ok(dialog.is_visible(), "profile dialog did not open")
    return dialog


def discard_confirm(page: Page, accept: bool):
    page.once("dialog", lambda d: (ok(d.type == "confirm"), d.accept() if accept else d.dismiss()))


def new_context(browser: Browser, base: str, role="manager", width=390, height=844):
    context = browser.new_context(viewport={"width": width, "height": height}, timezone_id="Asia/Jakarta", service_workers="block")
    seen, page_errors = [], []
    context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base + "/") else (seen.append(route.request.url), route.abort()))
    page = context.new_page(); page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(base + "/" + role, wait_until="networkidle")
    page._qa_page_errors = page_errors
    return context, page, seen

def make_png(path):
    # Small valid RGBA PNG, generated with stdlib only.
    raw = b"\x00" + bytes([40, 120, 220, 255])
    def chunk(kind, data): return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def main() -> int:
    server, _thread = serve_in_thread()
    base = f"http://127.0.0.1:{server.server_port}"
    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("CHROMIUM", "/usr/bin/chromium"), headless=True, args=["--no-sandbox"])
        contexts: list[BrowserContext] = []
        try:
            def run(name: str, fn: Callable[[], None]):
                try:
                    fn(); ok(not getattr(manager, "_qa_page_errors", []), "browser pageerror: " + str(manager._qa_page_errors)); ok(not getattr(user, "_qa_page_errors", []), "browser pageerror: " + str(user._qa_page_errors)); results.append({"name": name, "status": "PASS"}); print("PASS", name, flush=True)
                except Exception as exc:
                    results.append({"name": name, "status": "FAIL", "error": str(exc)[:500]}); print("FAIL", name, str(exc)[:500], flush=True)

            cu, user, _ = new_context(browser, base, "user"); contexts.append(cu)
            cm, manager, _ = new_context(browser, base, "manager"); contexts.append(cm)
            run(SCENARIOS[0], lambda: (report_draft(user, "finance_request", "USER FINANCE", "12345"), user.reload(wait_until="networkidle"), goto_page(user, "new-report"), ok(user.locator("#reportType").input_value() == "finance_request"), ok(user.locator("#reportDescription").input_value() == "USER FINANCE"), ok(user.locator("#reportAmount").input_value() == "12345")))
            run(SCENARIOS[1], lambda: (report_draft(manager, "finance_request", "MANAGER FINANCE", "54321"), manager.reload(wait_until="networkidle"), goto_page(manager, "new-report"), ok(manager.locator("#reportType").input_value() == "finance_request"), ok(manager.locator("#reportDescription").input_value() == "MANAGER FINANCE"), ok(manager.locator("#reportAmount").input_value() == "54321")))
            run(SCENARIOS[2], lambda: (report_draft(user, "finance_request", "FINANCE ONLY", "11"), user.locator("#reportType").select_option("petty_cash"), user.locator("#reportDescription").fill("PETTY ONLY"), user.locator("#reportType").select_option("finance_request"), ok(user.locator("#reportDescription").input_value() == "FINANCE ONLY"), ok(user.locator("#reportAmount").input_value() == "11")))
            run(SCENARIOS[3], lambda: (user.evaluate("persistReportDraft(); renderApp()"), user.wait_for_timeout(120), ok(user.locator("#reportDescription").input_value() == "FINANCE ONLY"), user.evaluate("renderApp()"), user.wait_for_timeout(120), ok(user.locator("#reportDescription").input_value() == "FINANCE ONLY")))
            run(SCENARIOS[4], lambda: (user.reload(wait_until="networkidle"), goto_page(user, "new-report"), ok(user.locator("#reportDescription").input_value() == "FINANCE ONLY")))

            pristine = profile_dialog(manager)
            run(SCENARIOS[5], lambda: (pristine.locator('[data-action="close-dialog"]').first.click(), manager.wait_for_timeout(80), ok(not pristine.is_visible())))
            dirty_escape = profile_dialog(manager); dirty_escape.locator("#profileNickname").fill("UNSAVED NICK")
            run(SCENARIOS[6], lambda: (discard_confirm(manager, False), manager.keyboard.press("Escape"), manager.wait_for_timeout(80), ok(dirty_escape.is_visible()), ok(dirty_escape.locator("#profileNickname").input_value() == "UNSAVED NICK")))
            dirty_position = profile_dialog(manager); dirty_position.locator("#profilePosition").fill("UNSAVED POSITION")
            run(SCENARIOS[7], lambda: (discard_confirm(manager, False), manager.mouse.click(2, 2), manager.wait_for_timeout(80), ok(dirty_position.is_visible()), ok(dirty_position.locator("#profilePosition").input_value() == "UNSAVED POSITION")))
            dirty_quote = profile_dialog(manager); dirty_quote.locator("#profileQuote").fill("UNSAVED QUOTE")
            run(SCENARIOS[8], lambda: (discard_confirm(manager, False), dirty_quote.locator('[data-action="close-dialog"]').first.click(), manager.wait_for_timeout(80), ok(dirty_quote.is_visible()), ok(dirty_quote.locator("#profileQuote").input_value() == "UNSAVED QUOTE")))
            dirty_photo = profile_dialog(manager)
            run(SCENARIOS[9], lambda: (dirty_photo.locator("#profileNickname").fill("PHOTO DRAFT"), discard_confirm(manager, False), manager.keyboard.press("Escape"), ok(dirty_photo.is_visible()), ok(dirty_photo.locator("#profileNickname").input_value() == "PHOTO DRAFT")))
            run(SCENARIOS[10], lambda: (discard_confirm(manager, True), manager.keyboard.press("Escape"), manager.wait_for_timeout(100), ok(not dirty_photo.is_visible())))

            open_users(manager); add = manager.locator('[data-action="open-add-user"]:visible').first; add.click(); manager.locator("#userName").fill("DRAFT ACCOUNT"); manager.locator("#userLoginId").fill("draft@loopback.invalid")
            run(SCENARIOS[11], lambda: (goto_page(manager, "overview"), goto_page(manager, "users"), add.click(), ok(manager.locator("#userName").input_value() == "DRAFT ACCOUNT")))
            run(SCENARIOS[12], lambda: (manager.reload(wait_until="networkidle"), goto_page(manager, "users"), add.click(), ok(manager.locator("#userName").input_value() == "DRAFT ACCOUNT")))
            run(SCENARIOS[13], lambda: (manager.evaluate("renderApp()"), manager.wait_for_timeout(100), ok(manager.locator("#userName").input_value() == "DRAFT ACCOUNT")))
            run(SCENARIOS[14], lambda: (discard_confirm(manager, False), manager.locator('[data-action="cancel-add-user"]:visible').click(), manager.wait_for_timeout(80), ok(manager.locator("#userName").input_value() == "DRAFT ACCOUNT")))
            run(SCENARIOS[15], lambda: (discard_confirm(manager, True), manager.locator('[data-action="cancel-add-user"]:visible').click(), manager.wait_for_timeout(80), ok(manager.locator("#userName").count() == 0 or not manager.locator("#userName").is_visible())) )

            open_users(manager)
            run(SCENARIOS[16], lambda: (account_search(manager).fill("Gamma Coach"), manager.wait_for_timeout(500), ok(rows(manager).count() == 1), ok("Gamma Coach" in rows(manager).inner_text())))
            run(SCENARIOS[17], lambda: (account_search(manager).fill("keeper.beta@loopback.invalid"), manager.wait_for_timeout(500), ok(rows(manager).count() == 1), ok("Beta Keeper" in rows(manager).inner_text())))
            def pagination():
                requests = []
                manager.on("request", lambda r: requests.append(r.url) if "/api/users?" in r.url else None)
                account_search(manager).fill("page-match"); manager.wait_for_timeout(500); ok(rows(manager).count() == 2); ok("Page Match 001" in " ".join(rows(manager).all_inner_texts()))
                before = len(requests)
                manager.locator('[data-action="load-more-users"]:visible').click(); manager.wait_for_timeout(300)
                page_two = requests[before:]
                ok(len(page_two) == 1, page_two); ok("page=2" in page_two[0] and "q=page-match" in page_two[0])
                ok(rows(manager).count() == 2); ok("Page Match 003" in " ".join(rows(manager).all_inner_texts())); ok(account_search(manager).input_value() == "page-match")
            run(SCENARIOS[18], pagination)
            def loading():
                account_search(manager).fill("alpha"); manager.wait_for_timeout(340)
                ok(manager.locator('#appContent').get_by_text("Memuat daftar akun…", exact=True).count() == 1)
                manager.wait_for_timeout(600); ok("Alpha Striker" in rows(manager).inner_text())
            run(SCENARIOS[19], loading)
            def error_recovery():
                account_search(manager).fill("qa-error"); manager.wait_for_timeout(650)
                alert = manager.locator('.users-search-panel [role="alert"]'); ok(alert.count() == 1); ok(alert.locator('[data-action="retry-users"]').count() == 1); ok(alert.inner_text().strip())
                account_search(manager).fill("Beta"); manager.wait_for_timeout(500); ok("Beta Keeper" in " ".join(rows(manager).all_inner_texts()))
            run(SCENARIOS[20], error_recovery)
            run(SCENARIOS[21], lambda: (account_search(manager).fill("no-such-account"), manager.wait_for_timeout(500), ok(rows(manager).count() == 0), ok(manager.locator("#appContent").inner_text().lower().count("tidak ada hasil") == 1)))
            def debounce():
                requests=[]; manager.on("request", lambda r: requests.append(r.url) if "/api/users?" in r.url else None)
                account_search(manager).fill("a"); account_search(manager).fill("al"); account_search(manager).fill("alp"); manager.wait_for_timeout(700)
                matched=[u for u in requests if "q=alp" in u]; ok(len(matched) == 1, requests); ok(not any("q=a&" in u or "q=al&" in u for u in requests))
            run(SCENARIOS[22], debounce)
            def stale():
                account_search(manager).fill("alpha"); manager.wait_for_timeout(340); account_search(manager).fill("Beta"); manager.wait_for_timeout(800)
                ok("Beta Keeper" in rows(manager).inner_text()); ok("Alpha Striker" not in rows(manager).inner_text()); ok(account_search(manager).input_value() == "Beta")
            run(SCENARIOS[23], stale)
            run(SCENARIOS[24], lambda: (manager.evaluate("renderApp()"), manager.wait_for_timeout(100), ok(manager.locator("#usersSearch").count() == 1), ok(manager.locator("#usersSearch").input_value() == "Beta")))

            for width, name in [(320, SCENARIOS[25]), (390, SCENARIOS[26]), (768, SCENARIOS[27]), (1280, SCENARIOS[28])]:
                def layout(width=width):
                    manager.set_viewport_size({"width": width, "height": 844}); open_users(manager); search = account_search(manager); search.fill("Alpha"); manager.wait_for_timeout(450); ok(manager.locator("#appContent").bounding_box()["width"] <= width); ok(manager.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
                run(name, layout)

            def loopback_only():
                # New page requests outside fixture must have been aborted.
                cm2, p2, blocked = new_context(browser, base, "manager"); contexts.append(cm2)
                statuses = p2.evaluate("Promise.all([fetch('/api/profile', {method:'POST', headers:{'Idempotency-Key':'qa-a'}, body:'synthetic'}).then(r=>r.status), fetch('/api/profile', {method:'POST', headers:{'Idempotency-Key':'qa-b'}, body:'synthetic'}).then(r=>r.status)])")
                ok(statuses == [503, 503], statuses)
                p2.evaluate("fetch('https://outside.invalid/qa-external').catch(() => 'aborted')")
                p2.wait_for_timeout(100)
                ok(any("outside.invalid" in url for url in blocked), f"external request was not aborted: {blocked}")
                ok(not getattr(p2, "_qa_page_errors", []), "browser pageerror: " + str(p2._qa_page_errors))
            run(SCENARIOS[29], loopback_only)
        finally:
            for context in contexts:
                context.close()
            browser.close(); server.shutdown(); server.server_close()
    print("RESULTS_JSON=" + json.dumps(results, ensure_ascii=False))
    print(f"TOTAL {len(results)} PASS {sum(r['status']=='PASS' for r in results)} FAIL {sum(r['status']=='FAIL' for r in results)} EXPECTED {EXPECTED}")
    return 0 if len(results) == EXPECTED and all(r["status"] == "PASS" for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
