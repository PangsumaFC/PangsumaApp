from __future__ import annotations

import json
import os
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from profile_flow_e2e import BASE, MANAGER, credential, http, login, rotate_first_login


SCREENSHOTS = Path(os.environ.get("PROFILE_REVIEW_DIR", "/tmp"))


def delayed(route, seconds: float):
    time.sleep(seconds)
    route.continue_()


def main():
    password = os.environ.get("LOCAL_MANAGER_PASSWORD") or "Navigation-loader-local"
    status, data, _ = http('/api/bootstrap', {'managerCredential': credential(password)}, headers={'Authorization': 'Bearer ' + os.environ['BOOTSTRAP_TOKEN']})
    assert status == 201, (status, data)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()
        page.route("**/api/session", lambda route: delayed(route, 0.6))
        page.goto(BASE, wait_until="domcontentloaded", timeout=30_000)
        expect(page.locator("#pangsuma-preloader")).to_be_visible()
        page.screenshot(path=str(SCREENSHOTS / "navigation-loader-session.png"))
        page.wait_for_load_state("networkidle", timeout=30_000)
        expect(page.locator("#pangsuma-preloader")).to_be_hidden(timeout=5_000)
        page.unroute("**/api/session")
        login(page, MANAGER, password)
        password = rotate_first_login(page, password)

        held = []
        page.route('**/api/overview', lambda route: held.append(route))
        page.evaluate("void fetch('/api/overview')")
        page.wait_for_timeout(30)
        assert held, 'a real overview request must remain pending during navigation'
        result = page.evaluate("""() => {
          const started = performance.now();
          document.querySelector('[data-page="approvals"]').click();
          return { elapsedMs: performance.now() - started,
                   heading: document.querySelector('#appContent h1')?.textContent,
                   loaderHidden: document.querySelector('#pangsuma-preloader').hidden };
        }""")
        assert result['heading'] == 'Persetujuan', result
        assert result['elapsedMs'] < 200, result
        assert result['loaderHidden'], result
        for route in held:
            route.continue_()
        print(f"NAVIGATION_LOADER_E2E_PASS menu_ms={result['elapsedMs']:.1f} pending_overview=1 repeated_full_loader=0", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
