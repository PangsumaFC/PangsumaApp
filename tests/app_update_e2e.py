from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright

from profile_flow_e2e import MANAGER, credential, login, rotate_first_login

BASE = os.environ.get("PANGSUMA_LOCAL_URL", "http://localhost:8788").rstrip("/")
SCREENSHOTS = Path(os.environ.get("PROFILE_REVIEW_DIR", "/tmp"))


def bootstrap(password: str):
    token = os.environ["BOOTSTRAP_TOKEN"]
    request = Request(BASE + "/api/bootstrap", method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json", "Origin": BASE,
    }, data=json.dumps({"managerCredential": credential(password)}).encode())
    try:
        with urlopen(request, timeout=30) as response:
            assert response.status == 201
    except HTTPError as error:
        body = error.read().decode()
        raise AssertionError(f"bootstrap failed: {error.code} {body}") from error


def main():
    password = os.environ.get("LOCAL_MANAGER_PASSWORD") or "App-update-local-" + secrets.token_urlsafe(12)
    bootstrap(password)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Asia/Jakarta")
        page = context.new_page()
        current = json.loads((Path(__file__).resolve().parents[1] / "site/version.json").read_text())["build"]
        parts = current.split(".")
        newer = ".".join(parts[:-1] + [str(int(parts[-1]) + 1)])
        build = {"value": newer}
        page.route("**/version.json*", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"build": build["value"]})))
        page.goto(BASE, wait_until="networkidle", timeout=30_000)
        login(page, MANAGER, password)
        password = rotate_first_login(page, password)
        page.evaluate("checkForAppUpdate()")
        expect(page.locator("#appUpdateBanner")).to_be_visible(timeout=10_000)
        expect(page.locator("#appUpdateVersion")).to_contain_text(newer)

        page.locator("[data-action='open-report-choice']:visible").first.click()
        page.locator("#reportType").select_option("petty_cash")
        page.locator("#reportForm").wait_for(timeout=10_000)
        page.locator("#reportForm [name='description']").fill("Draf jangan hilang")
        page.evaluate("checkForAppUpdate()")
        expect(page.locator("#reportForm [name='description']")).to_have_value("Draf jangan hilang")

        page.locator("#reportForm button[type=submit]").evaluate("button => button.setAttribute('aria-busy', 'true')")
        page.locator("#appUpdateReload").click()
        expect(page.locator("#reportForm [name='description']")).to_have_value("Draf jangan hilang")
        page.locator("#reportForm button[type=submit]").evaluate("button => button.removeAttribute('aria-busy')")
        page.evaluate("window.confirm = () => false")
        page.locator("#appUpdateReload").click()
        expect(page.locator("#reportForm [name='description']")).to_have_value("Draf jangan hilang")

        page.evaluate("window.confirm = () => true")
        build["value"] = current
        page.locator("#appUpdateReload").click()
        page.wait_for_load_state("networkidle", timeout=20_000)
        page.wait_for_timeout(500)
        expect(page.locator("#appUpdateBanner")).to_be_hidden()
        page.screenshot(path=str(SCREENSHOTS / "app-update-manager.png"), full_page=True)
        print("APP_UPDATE_E2E_PASS banner=1 draft_preserved=1 busy_blocked=1 cancel_preserved=1 reload_confirmed=1", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
