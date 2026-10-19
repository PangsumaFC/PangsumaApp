from __future__ import annotations

import os
import re
import time
import uuid
import json
import hashlib
import subprocess
from datetime import date
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("PANGSUMA_LOCAL_URL", "http://localhost:8788")
MANAGER_EMAIL = "rahmat@pangsumafc.com"
TEST_USER_EMAIL = "qa.local@example.invalid"
SECOND_USER_EMAIL = "bagas@pangsumafc.com"


def local_vars() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in Path("tests/.dev.vars").read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def local_d1_rows(sql: str):
    state_dir = os.environ.get("PANGSUMA_LOCAL_STATE_DIR")
    if not state_dir:
        raise RuntimeError("Set PANGSUMA_LOCAL_STATE_DIR to the same isolated Wrangler --persist-to directory.")
    completed = subprocess.run(
        [
            "npx", "wrangler", "d1", "execute", "pangsuma-app-local-test",
            "--local", "--config", "tests/wrangler.local.toml",
            "--persist-to", state_dir, "--command", sql, "--json",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    decoded = json.loads(completed.stdout)
    results = decoded if isinstance(decoded, list) else [decoded]
    for item in results:
        if isinstance(item, dict) and isinstance(item.get("results"), list):
            return item["results"]
    return []


def api(page, path: str, method: str = "GET", body=None, headers=None):
    # The server never accepts raw passwords. Keep legacy tests readable while
    # deriving the current client PBKDF2 credential through the real endpoint.
    if path == "/api/login" and method == "POST" and isinstance(body, dict) and "password" in body:
        body = page.evaluate(
            """async ({email, password}) => {
              const parametersResponse = await fetch('/api/auth/password-parameters', {
                method: 'POST', credentials: 'same-origin',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({email})
              });
              const parameters = await parametersResponse.json();
              const credential = await window.PasswordCrypto.derive(password, parameters);
              return {email, credential};
            }""",
            {"email": body.get("email"), "password": body.get("password")},
        )
    return page.evaluate(
        """async ({path, method, body, headers}) => {
          const requestHeaders = {...(headers || {})};
          const options = {method, credentials: 'same-origin', headers: requestHeaders};
          if (body !== null) {
            requestHeaders['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
          }
          const response = await fetch(path, options);
          let data = {};
          try { data = await response.json(); } catch {}
          return {status: response.status, data};
        }""",
        {"path": path, "method": method, "body": body, "headers": headers or {}},
    )


def manager_credential(page, password: str):
    return page.evaluate(
        """async password => {
          const response = await fetch('/api/auth/password-parameters', {
            method: 'POST', credentials: 'same-origin',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({email: 'rahmat@pangsumafc.com'})
          });
          return window.PasswordCrypto.derive(password, await response.json());
        }""", password,
    )


def assert_no_horizontal_overflow(page, width: int, height: int = 820):
    page.set_viewport_size({"width": width, "height": height})
    page.wait_for_timeout(80)
    measurement = page.evaluate(
        """() => ({
          viewport: document.documentElement.clientWidth,
          page: document.documentElement.scrollWidth,
          body: document.body.scrollWidth
        })"""
    )
    assert measurement["page"] <= measurement["viewport"] + 1, (
        f"horizontal overflow at {width}px: {measurement}"
    )


def login(page, email: str, password: str):
    page.locator("#loginIdentifier").fill(email)
    page.locator("#loginPassword").fill(password)
    page.locator("#loginPassword").press("Enter")
    page.locator("#loginGate").wait_for(state="hidden", timeout=15_000)

def logout(page):
    page.locator("#logoutButton").click()
    page.locator("body.logged-out").wait_for(timeout=10_000)
    assert api(page, "/api/session")["status"] == 401, "logout must revoke the server session"
    assert page.locator("dialog[open]").count() == 0, "logout must close native dialogs"
    assert page.locator("#appContent").inner_text() == "", "logout must remove private app content"
    assert page.locator('input[type="password"]').evaluate_all("nodes => nodes.every(node => !node.value)")


def change_password(page, current: str, new: str):
    page.get_by_role("heading", name="Buat kata sandi baru").wait_for(timeout=10_000)
    assert api(page, "/api/overview")["status"] == 403
    page.locator("#currentPassword").fill(current)
    page.locator("#newPassword").fill(new)
    page.locator("#confirmPassword").fill(new)
    page.locator("#passwordForm button[type='submit']").click()
    page.locator("#passwordForm").wait_for(state="detached", timeout=15_000)


def create_user_password(page, row_name: str, password: str):
    row = page.locator("tbody tr").filter(has_text=row_name)
    assert row.count() == 1, f"expected one user row for {row_name}"
    row.locator('[data-action="reset-user-password"]').click()
    page.locator("#userPasswordDialog").wait_for(state="visible")
    page.locator("#temporaryPassword").fill(password)
    page.locator("#userPasswordSubmit").click()
    page.locator("#userPasswordDialog").wait_for(state="hidden", timeout=15_000)


def create_submission(page, *, kind: str, amount: int, description: str):
    key = str(uuid.uuid4())
    payload = {
        "type": kind,
        "amountIdr": amount,
        "date": date.today().isoformat(),
        "description": description,
        "note": "Fixture uji lokal, bukan data operasional.",
    }
    first = api(page, "/api/submissions", "POST", payload, {"Idempotency-Key": key})
    assert first["status"] == 201, first
    duplicate = api(page, "/api/submissions", "POST", payload, {"Idempotency-Key": key})
    assert duplicate["status"] == 200 and duplicate["data"].get("alreadyCreated") is True, duplicate
    assert duplicate["data"]["submission"]["id"] == first["data"]["submission"]["id"]
    changed_payload = {**payload, "amountIdr": amount + 1}
    conflict = api(page, "/api/submissions", "POST", changed_payload, {"Idempotency-Key": key})
    assert conflict["status"] == 409 and conflict["data"]["error"]["code"] == "idempotency_key_reused", conflict
    return first["data"]["submission"]["id"]


def fetch_all_history(page, endpoint: str, collection: str):
    items = []
    seen = set()
    cursor = None
    total = None
    while True:
        path = endpoint if cursor is None else f"{endpoint}?cursor={quote(cursor, safe='')}"
        result = api(page, path)
        assert result["status"] == 200, result
        batch = result["data"][collection]
        for item in batch:
            identity = item["id"]
            assert identity not in seen, f"duplicate cursor item {identity} from {endpoint}"
            seen.add(identity)
        items.extend(batch)
        total = int(result["data"]["total"])
        cursor = result["data"]["nextCursor"]
        if not cursor:
            break
    assert len(items) == total, f"incomplete cursor history from {endpoint}: {len(items)} of {total}"
    return items


def bulk_create_submissions(page, count: int, kind: str, prefix: str):
    return page.evaluate(
        """async ({count, kind, prefix, reportDate}) => {
          const ids = [];
          for (let index = 0; index < count; index += 1) {
            const suffix = String(index + 1).padStart(4, '0');
            const description = kind === 'finance_request' && index === 0
              ? '=uji formula proteksi CSV'
              : `${prefix} ${suffix}`;
            const response = await fetch('/api/submissions', {
              method: 'POST', credentials: 'same-origin',
              headers: {'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},
              body: JSON.stringify({type:kind,amountIdr:1,date:reportDate,description,note:''})
            });
            const body = await response.json();
            if (response.status !== 201) throw new Error(`bulk create failed ${index + 1}: ${response.status} ${body?.error?.code || ''}`);
            ids.push(body.submission.id);
          }
          return ids;
        }""",
        {"count": count, "kind": kind, "prefix": prefix, "reportDate": date.today().isoformat()},
    )


def visible_submission_ids(page):
    return page.locator('[data-action="report-detail"]:visible').evaluate_all(
        "nodes => nodes.map(node => node.getAttribute('data-id')).filter(Boolean)"
    )


def walk_bounded_submission_pages(page, expected_ids):
    """Traverse UI pages without assuming cumulative DOM state."""
    pages = []
    while True:
        current = visible_submission_ids(page)
        assert 0 < len(current) <= 100, f"bounded history page size invalid: {len(current)}"
        assert len(current) == len(set(current)), "duplicate IDs on one history page"
        pages.append(current)
        next_button = page.locator('[data-action="load-more-history"][data-collection="submissions"]:visible')
        if not next_button.count():
            break
        next_button.click()
        page.wait_for_timeout(150)
    flattened = [item for batch in pages for item in batch]
    assert flattened == expected_ids, ("UI page order must match backend keyset order", flattened[:8], expected_ids[:8], len(flattened), len(expected_ids))
    assert len(flattened) == len(set(flattened)) == len(expected_ids)
    return pages


def bulk_approve(page, ids):
    return page.evaluate(
        """async ids => {
          for (let index = 0; index < ids.length; index += 1) {
            const response = await fetch(`/api/submissions/${encodeURIComponent(ids[index])}/approve`, {
              method: 'POST', credentials: 'same-origin',
              headers: {'Content-Type':'application/json'}, body: '{}'
            });
            const body = await response.json();
            if (!response.ok) throw new Error(`bulk approval failed ${index + 1}: ${response.status} ${body?.error?.code || ''}`);
          }
          return ids.length;
        }""",
        ids,
    )


def main():
    secrets = local_vars()
    required = [
        "BOOTSTRAP_TOKEN",
        "LOCAL_MANAGER_PASSWORD",
        "LOCAL_USER_TEMP_PASSWORD",
        "LOCAL_USER_NEW_PASSWORD",
        "LOCAL_SECOND_TEMP_PASSWORD",
        "LOCAL_SECOND_NEW_PASSWORD",
    ]
    missing = [key for key in required if not secrets.get(key)]
    assert not missing, f"missing local-only variables: {', '.join(missing)}"

    browser_errors: list[str] = []
    page_errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path="/usr/bin/chromium",
            headless=True,
            args=["--no-sandbox"],
        )
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=1,
            is_mobile=True,
            has_touch=True,
            accept_downloads=True,
        )
        preview_page = context.new_page()
        preview_page.route("**/app.js*", lambda route: route.abort())
        preview_page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
        assert preview_page.locator("#pangsuma-preloader").is_visible()
        preview_style = preview_page.locator("#pangsuma-preloader").evaluate("node => { const style = getComputedStyle(node); return {opacity: style.opacity, background: style.backgroundColor, zIndex: style.zIndex, className: node.className}; }")
        assert preview_style == {"opacity": "1", "background": "rgb(10, 13, 20)", "zIndex": "9999", "className": "pangsuma-preloader"}, preview_style
        assert preview_page.locator(".pangsuma-loader-ring").evaluate("node => getComputedStyle(node).animationName") == "spinOuter"
        preview_page.screenshot(path="/tmp/pangsuma-preloader-mobile.png")
        preview_page.emulate_media(reduced_motion="reduce")
        assert preview_page.locator(".pangsuma-loader-ring").evaluate("node => getComputedStyle(node).animationName") == "none"
        preview_page.close()

        page = context.new_page()
        page.on("console", lambda message: browser_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        def delay_session(route):
            time.sleep(0.6)
            route.continue_()

        page.route("**/api/session", delay_session)
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30_000)
        assert page.locator("#pangsuma-preloader").is_visible(), "preloader should cover the initial session check"
        assert page.locator("body").get_attribute("aria-busy") == "true"
        assert page.locator(".pangsuma-loader-ring").evaluate("node => getComputedStyle(node).animationName") == "spinOuter"
        assert page.locator(".pangsuma-loader-emblem").evaluate("node => getComputedStyle(node).animationName") == "subtleFloat"
        page.wait_for_load_state("networkidle", timeout=30_000)
        page.locator("#pangsuma-preloader").wait_for(state="hidden", timeout=5_000)
        assert page.locator("#pangsuma-preloader").get_attribute("aria-hidden") == "true"
        assert page.locator("body").get_attribute("aria-busy") is None
        page.emulate_media(reduced_motion="reduce")
        assert page.locator(".pangsuma-loader-ring").evaluate("node => getComputedStyle(node).animationName") == "none"
        page.emulate_media(reduced_motion="no-preference")
        page.unroute("**/api/session", delay_session)
        print("- Owner-provided Pangsuma crest preloader, delayed-session timing, and reduced-motion behavior passed.")
        page.locator("#loginForm").wait_for()
        assert page.locator("#loginIdentifier:focus").count() == 1, "login should focus the ID field"
        page.keyboard.press("Tab")
        assert page.locator("#loginPassword:focus").count() == 1, "Tab should move to the password field"
        assert page.locator("#demoDisclosure").count() == 0, "production shell must not expose demo disclosure"
        assert api(page, "/api/health")["status"] == 200
        assert api(page, "/api/overview")["status"] == 401

        boot = page.evaluate(
            """async ({token, managerCredential}) => {
              const response = await fetch('/api/bootstrap', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
                body: JSON.stringify({managerCredential})
              });
              return {status: response.status, body: await response.json()};
            }""",
            {"token": secrets["BOOTSTRAP_TOKEN"], "managerCredential": manager_credential(page, secrets["LOCAL_MANAGER_PASSWORD"])},
        )
        assert boot["status"] == 201 and boot["body"]["seededUsers"] == 10, boot
        repeat_boot = page.evaluate(
            """async ({token, managerCredential}) => {
              const response = await fetch('/api/bootstrap', {
                method: 'POST', headers: {'Content-Type':'application/json','Authorization':`Bearer ${token}`},
                body: JSON.stringify({managerCredential})
              });
              return response.status;
            }""",
            {"token": secrets["BOOTSTRAP_TOKEN"], "managerCredential": manager_credential(page, secrets["LOCAL_MANAGER_PASSWORD"])},
        )
        assert repeat_boot == 409, f"bootstrap must be one-time, got {repeat_boot}"

        manager_password = secrets["LOCAL_MANAGER_PASSWORD"]
        manager_new_password = manager_password + "-rotated"
        login(page, MANAGER_EMAIL, manager_password)
        if page.get_by_role("heading", name="Buat kata sandi baru").count():
            change_password(page, manager_password, manager_new_password)
            manager_password = manager_new_password
        page.get_by_role("heading", name=re.compile("Selamat (pagi|siang|sore|malam), Rahmat")).wait_for()
        assert page.locator("#demoDisclosure").count() == 0
        assert page.get_by_text("Staff Demo 01").count() == 0
        assert_no_horizontal_overflow(page, 320)
        assert_no_horizontal_overflow(page, 390)
        page.wait_for_timeout(3300)
        page.screenshot(path="/tmp/pangsuma-manager-overview-mobile.png", full_page=True)

        page.locator("#mainContent").evaluate("el => { el.scrollTop = el.scrollHeight; }")
        overview_heading_box = page.get_by_role("heading", name=re.compile("Selamat (pagi|siang|sore|malam), Rahmat")).bounding_box()
        assert overview_heading_box and overview_heading_box["y"] < 0, f"test must scroll the main content: {overview_heading_box}"
        page.get_by_role("button", name="Laporan Finance", exact=True).click()
        page.get_by_role("heading", name="Finance", exact=True).wait_for()
        finance_heading_box = page.get_by_role("heading", name="Finance", exact=True).bounding_box()
        assert finance_heading_box and 0 <= finance_heading_box["y"] < 300, f"route change must reset scroll: {finance_heading_box}"

        page.get_by_role("button", name="Pengguna", exact=True).click()
        page.get_by_role("heading", name="Pengguna").wait_for()
        assert page.locator("tbody tr").count() == 10
        assert page.locator("tbody tr").filter(has_text="Rahmat Saputro").count() == 1
        assert page.get_by_text("Password belum diatur").count() == 9
        assert_no_horizontal_overflow(page, 320)
        assert_no_horizontal_overflow(page, 390)
        page.screenshot(path="/tmp/pangsuma-manager-users-mobile.png", full_page=True)

        bagas_row = page.locator("tbody tr").filter(has_text="Bagas Wijaya")
        bagas_row.locator('[data-action="reset-user-password"]').click()
        page.locator("#temporaryPassword").fill("FakeLocalPassword!2026")
        page.route(
            "**/api/users/*/password",
            lambda route: route.fulfill(
                status=401,
                content_type="application/json",
                body='{"error":{"code":"authentication_required","message":"Sesi berakhir."}}',
            ),
        )
        page.locator("#userPasswordSubmit").click()
        page.locator("body.logged-out").wait_for(timeout=10_000)
        assert page.locator("dialog[open]").count() == 0, "401 must close an open native dialog"
        assert page.locator("#loginIdentifier").evaluate("node => node === document.activeElement")
        assert page.locator("#temporaryPassword").input_value() == ""
        assert page.locator("#appContent").inner_text() == ""
        page.unroute("**/api/users/*/password")
        login(page, MANAGER_EMAIL, manager_password)

        page.route(
            "**/api/logout",
            lambda route: route.fulfill(
                status=503,
                content_type="application/json",
                body='{"error":{"code":"temporarily_unavailable","message":"Uji gangguan lokal."}}',
            ),
        )
        page.locator("#logoutButton").click()
        page.get_by_text("Keluar belum terkonfirmasi. Sesi Anda masih aktif; coba lagi.", exact=True).wait_for()
        assert "logged-out" not in page.locator("body").get_attribute("class")
        assert page.locator("#accountName").inner_text() == "Rahmat Saputro"
        assert api(page, "/api/session")["status"] == 200, "failed logout must not claim that the server session ended"
        page.unroute("**/api/logout")

        page.get_by_role("button", name="Pengguna", exact=True).click()
        page.get_by_role("button", name="Tambah pengguna").click()
        page.locator("#userName").fill("Penguji Lokal")
        page.locator("#userLoginId").fill(TEST_USER_EMAIL)
        page.locator("#userPosition").fill("QA")
        page.locator("#userForm button[type='submit']").click()
        page.locator("tbody tr").filter(has_text="Penguji Lokal").wait_for(timeout=15_000)
        create_user_password(page, "Penguji Lokal", secrets["LOCAL_USER_TEMP_PASSWORD"])
        create_user_password(page, "Bagas Wijaya", secrets["LOCAL_SECOND_TEMP_PASSWORD"])

        page.get_by_role("button", name="Laporan Finance", exact=True).click()
        page.get_by_role("heading", name="Finance", exact=True).wait_for()
        page.get_by_role("button", name="Tetapkan saldo awal").click()
        page.locator("#openingAmount").fill("500000")
        page.locator("#ownerConfirmed").check()
        page.locator("#openingBalanceSubmit").click()
        page.locator("#openingBalanceDialog").wait_for(state="hidden", timeout=15_000)
        assert api(page, "/api/overview")["data"]["cashBalanceIdr"] == 500000
        duplicate_opening = api(page, "/api/cash/opening-balance", "POST", {"amountIdr": 500000, "ownerConfirmed": True})
        assert duplicate_opening["status"] == 200 and duplicate_opening["data"].get("alreadyApplied") is True, duplicate_opening
        changed_opening = api(page, "/api/cash/opening-balance", "POST", {"amountIdr": 400000, "ownerConfirmed": True})
        assert changed_opening["status"] == 409, changed_opening

        logout(page)
        login(page, TEST_USER_EMAIL, secrets["LOCAL_USER_TEMP_PASSWORD"])
        change_password(page, secrets["LOCAL_USER_TEMP_PASSWORD"], secrets["LOCAL_USER_NEW_PASSWORD"])
        assert page.get_by_role("heading", name=re.compile("Selamat (pagi|siang|sore|malam), Penguji")).count() == 1
        page.locator('[data-page="new-report"]:visible').first.click()
        page.locator("#reportForm").wait_for(state="visible")
        page.locator('#reportForm [data-page="overview"]').click()
        page.locator("#reportForm").wait_for(state="detached")
        page.locator('[data-page="new-report"]:visible').first.click()
        page.locator("#reportType").select_option("petty_cash")
        page.locator("#reportAmount").fill("185000")
        page.locator("#reportDescription").fill("Transport kegiatan lapangan")
        page.locator("#reportForm button[type='submit']").click()
        page.get_by_text("Transport kegiatan lapangan", exact=True).wait_for(timeout=15_000)
        user_cash = api(page, "/api/submissions")["data"]["submissions"]
        cash_id = next(item["id"] for item in user_cash if item["description"] == "Transport kegiatan lapangan")

        finance_id = create_submission(page, kind="finance_request", amount=420000, description="Perlengkapan latihan")
        overspend_id = create_submission(page, kind="petty_cash", amount=350000, description="Perbaikan perlengkapan lokal")
        reject_id = create_submission(page, kind="finance_request", amount=50000, description="Materi administrasi lokal")
        assert api(page, f"/api/submissions/{cash_id}/approve", "POST", {})["status"] == 403
        assert api(page, "/api/users")["status"] == 403
        assert api(page, "/api/cash/opening-balance", "POST", {"amountIdr": 100000, "ownerConfirmed": True})["status"] == 403
        user_overview = api(page, "/api/overview")["data"]
        assert len(user_overview["submissions"]) == 4
        assert "cashBalanceIdr" not in user_overview, "user overview must not expose manager cash balance"
        assert_no_horizontal_overflow(page, 320)
        page.locator("#mainContent").evaluate("el => { el.scrollTop = 0; }")
        page.wait_for_timeout(3300)
        page.screenshot(path="/tmp/pangsuma-user-reports-mobile.png", full_page=True)

        logout(page)
        login(page, SECOND_USER_EMAIL, secrets["LOCAL_SECOND_TEMP_PASSWORD"])
        change_password(page, secrets["LOCAL_SECOND_TEMP_PASSWORD"], secrets["LOCAL_SECOND_NEW_PASSWORD"])
        second_user_rows = api(page, "/api/submissions")["data"]["submissions"]
        assert second_user_rows == [], f"user records leaked across accounts: {len(second_user_rows)}"
        page.get_by_text("Belum ada laporan", exact=True).wait_for()

        logout(page)
        login(page, MANAGER_EMAIL, manager_password)
        manager_data = api(page, "/api/overview")["data"]
        assert len(manager_data["submissions"]) == 4
        assert manager_data["cashBalanceIdr"] == 500000
        own_submission = api(page, "/api/submissions", "POST", {
            "type": "petty_cash", "amountIdr": 1000, "date": date.today().isoformat(),
            "description": "Manager self submission", "note": ""
        }, {"Idempotency-Key": str(uuid.uuid4())})
        assert own_submission["status"] == 201, own_submission
        own_id = own_submission["data"]["submission"]["id"]
        self_decision = api(page, f"/api/submissions/{own_id}/approve", "POST", {})
        assert self_decision["status"] == 403 and self_decision["data"]["error"]["code"] == "self_decision_not_allowed", self_decision

        page.get_by_role("button", name="Persetujuan", exact=True).click()
        cash_row = page.locator(".item-row").filter(has_text="Transport kegiatan lapangan")
        cash_row.get_by_role("button", name="Setujui & kurangi saldo").click()
        page.locator("#confirmDialog").wait_for(state="visible")
        page.locator("#confirmSubmit").click()
        page.get_by_text("Pengajuan disetujui dan debit tercatat di ledger.", exact=True).wait_for(timeout=15_000)
        known_submissions = api(page, "/api/submissions")["data"]["submissions"]
        approved_petty_amounts = {
            item["id"]: int(item["amountIdr"])
            for item in known_submissions
            if item["type"] == "petty_cash" and item["status"] == "approved"
        }
        assert cash_id in approved_petty_amounts, approved_petty_amounts
        expected_cash_balance = 500000 - sum(approved_petty_amounts.values())
        actual_cash_balance = api(page, "/api/overview")["data"]["cashBalanceIdr"]
        assert actual_cash_balance == expected_cash_balance, (actual_cash_balance, expected_cash_balance, approved_petty_amounts)
        duplicate_approval = api(page, f"/api/submissions/{cash_id}/approve", "POST", {})
        assert duplicate_approval["status"] == 200 and duplicate_approval["data"].get("alreadyApplied") is True, duplicate_approval
        assert api(page, "/api/overview")["data"]["cashBalanceIdr"] == expected_cash_balance

        finance_row = page.locator(".item-row").filter(has_text="Perlengkapan latihan")
        finance_row.get_by_role("button", name="Setujui request").click()
        page.locator("#confirmSubmit").click()
        page.get_by_text("Request disetujui dan masuk ke Finance.", exact=True).wait_for(timeout=15_000)
        assert api(page, "/api/overview")["data"]["cashBalanceIdr"] == expected_cash_balance

        insufficient = api(page, f"/api/submissions/{overspend_id}/approve", "POST", {})
        assert insufficient["status"] == 409 and insufficient["data"]["error"]["code"] == "insufficient_petty_cash", insufficient
        assert api(page, "/api/overview")["data"]["cashBalanceIdr"] == expected_cash_balance

        rejected_row = page.locator(".item-row").filter(has_text="Materi administrasi lokal")
        rejected_row.get_by_role("button", name="Tolak").click()
        page.locator("#rejectReason").fill("Tidak sesuai prioritas uji lokal.")
        page.locator("#rejectSubmit").click()
        page.get_by_text("Penolakan dan alasannya tersimpan pada riwayat.", exact=True).wait_for(timeout=15_000)

        page.get_by_role("button", name="Laporan Finance", exact=True).click()
        page.get_by_role("heading", name="Finance", exact=True).wait_for()
        assert page.get_by_text("Total request", exact=True).count() == 1
        pending_finance = page.locator(".item-row").filter(has_text="Perlengkapan latihan")
        assert pending_finance.get_by_text("Menunggu Finance", exact=True).count() == 1
        pending_finance.get_by_role("button", name="Tandai terkirim ke Finance").click()
        page.locator("#confirmSubmit").click()
        page.get_by_text("Status Request Finance diperbarui.", exact=True).wait_for(timeout=15_000)
        sent_finance = page.locator(".item-row").filter(has_text="Perlengkapan latihan")
        assert sent_finance.get_by_text("Terkirim", exact=True).count() == 1
        assert api(page, "/api/overview")["data"]["cashBalanceIdr"] == expected_cash_balance
        assert_no_horizontal_overflow(page, 320)
        page.locator("#mainContent").evaluate("el => { el.scrollTop = 0; }")
        page.wait_for_timeout(3300)
        page.screenshot(path="/tmp/pangsuma-finance-mobile.png", full_page=True)
        with page.expect_download() as download:
            page.get_by_role("button", name="Unduh laporan keuangan PDF").click()
        pdf_path = Path("/tmp/pangsuma-local-report.pdf")
        download.value.save_as(pdf_path)
        assert pdf_path.read_bytes().startswith(b"%PDF-")
        pdf_text = subprocess.run(["pdftotext", str(pdf_path), "-"], check=True, capture_output=True, text=True).stdout
        assert "RINGKASAN" in pdf_text and "Buku Kas" in pdf_text and "Lampiran Audit" in pdf_text
        assert "Perlengkapan latihan" in pdf_text and "Transport kegiatan lapangan" in pdf_text
        page.get_by_role("button", name="Pengguna", exact=True).click()
        local_user_row = page.locator("tbody tr").filter(has_text="Penguji Lokal")
        local_user_row.locator('[data-action="deactivate-user"]').click()
        page.locator("#confirmSubmit").click()
        page.get_by_text("Akses akun dinonaktifkan; riwayat tetap tersimpan.", exact=True).wait_for(timeout=15_000)
        disabled_row = page.locator("tbody tr").filter(has_text="Penguji Lokal")
        assert disabled_row.get_by_text("Akses nonaktif", exact=True).count() == 1
        all_history = api(page, "/api/overview")["data"]["submissions"]
        assert any(item["id"] == cash_id for item in all_history), "deactivation must not delete history"
        logout(page)
        locked_login = api(page, "/api/login", "POST", {"email": TEST_USER_EMAIL, "password": secrets["LOCAL_USER_NEW_PASSWORD"]})
        assert locked_login["status"] == 401

        # Final responsive checks run on real app routes at phone, tablet and desktop widths.
        login(page, MANAGER_EMAIL, manager_password)
        for destination, title in [
            ("Persetujuan", "Persetujuan"),
            ("Laporan Finance", "Finance"),
            ("Pengguna", "Pengguna"),
        ]:
            page.get_by_role("button", name=destination, exact=True).click()
            page.get_by_role("heading", name=title, exact=True).wait_for()
            for width in (320, 390, 768, 1024, 1440):
                assert_no_horizontal_overflow(page, width)
            assert_no_horizontal_overflow(page, 844, height=390)
        page.screenshot(path="/tmp/pangsuma-users-desktop.png", full_page=True)

        baseline_total = int(api(page, "/api/overview")["data"]["summary"]["total"])
        logout(page)
        login(page, SECOND_USER_EMAIL, secrets["LOCAL_SECOND_NEW_PASSWORD"])
        bulk_cash_ids = bulk_create_submissions(page, 99, "petty_cash", "Uji ledger lengkap")
        bulk_finance_ids = bulk_create_submissions(page, 505, "finance_request", "Uji arsip lengkap")
        expected_total = baseline_total + len(bulk_cash_ids) + len(bulk_finance_ids)

        logout(page)
        login(page, MANAGER_EMAIL, manager_password)
        assert bulk_approve(page, bulk_cash_ids) == len(bulk_cash_ids)
        manager_overview = api(page, "/api/overview")["data"]
        assert manager_overview["summary"]["total"] == expected_total
        approved_petty_amounts.update({item_id: 1 for item_id in bulk_cash_ids})
        expected_cash_balance = 500000 - sum(approved_petty_amounts.values())
        assert manager_overview["cashBalanceIdr"] == expected_cash_balance

        logout(page)
        login(page, SECOND_USER_EMAIL, secrets["LOCAL_SECOND_NEW_PASSWORD"])
        page.get_by_role("button", name="Laporan saya", exact=True).click()
        user_history = fetch_all_history(page, "/api/history/submissions", "submissions")
        intended_user_ids = [item["id"] for item in user_history]
        assert set(intended_user_ids) == set(bulk_cash_ids + bulk_finance_ids)
        user_pages = walk_bounded_submission_pages(page, intended_user_ids)
        assert len(user_pages) >= 2
        assert page.locator('[data-action="history-previous"][data-collection="submissions"]:visible').count() == 1
        page.locator('[data-action="history-previous"][data-collection="submissions"]:visible').click()
        page.wait_for_timeout(500)
        assert visible_submission_ids(page) == user_pages[-2], (visible_submission_ids(page), user_pages[-2])
        page.locator('[data-action="history-first"][data-collection="submissions"]:visible').click()
        page.wait_for_timeout(500)
        assert visible_submission_ids(page) == user_pages[0], (visible_submission_ids(page), user_pages[0])
        assert api(page, "/api/history/cash-ledger")["status"] == 403, "Users must not read Manager ledger history"

        logout(page)
        login(page, MANAGER_EMAIL, manager_password)
        manager_history = fetch_all_history(page, "/api/history/submissions", "submissions")
        assert len(manager_history) == expected_total
        assert any(item["id"] == cash_id for item in manager_history)
        ledger_history = fetch_all_history(page, "/api/history/cash-ledger", "cashLedger")
        audit_history = fetch_all_history(page, "/api/history/audit-events", "auditEvents")
        assert len(ledger_history) > 100, f"ledger fixture did not cross a page: {len(ledger_history)}"
        assert len(audit_history) > 100, f"audit fixture did not cross a page: {len(audit_history)}"

        page.get_by_role("button", name="Persetujuan", exact=True).click()
        assert 0 < len(visible_submission_ids(page)) <= 100
        manager_next = page.locator('[data-action="load-more-history"][data-collection="submissions"]:visible')
        assert manager_next.count() == 1
        manager_next.click()
        page.wait_for_timeout(300)
        assert 0 < len(visible_submission_ids(page)) <= 100
        manager_previous = page.locator('[data-action="history-previous"][data-collection="submissions"]:visible')
        assert manager_previous.count() == 1
        manager_previous.click()
        page.wait_for_timeout(300)
        assert 0 < len(visible_submission_ids(page)) <= 100
        audit_summary = page.locator(".audit-panel summary")
        audit_summary.click()
        audit_controls = page.locator('[data-action="load-more-history"][data-collection="auditEvents"]:visible')
        assert page.locator('[data-collection="auditEvents"] .audit-list:visible li').count() <= 100
        if audit_controls.count():
            audit_controls.click()
            assert page.locator('[data-collection="auditEvents"] .audit-list:visible li').count() <= 100

        page.get_by_role("button", name="Laporan Finance", exact=True).click()
        page.locator(".audit-panel summary").click()
        assert page.locator('[data-collection="cashLedger"] .audit-list:visible li').count() <= 100
        ledger_next = page.locator('[data-action="load-more-history"][data-collection="cashLedger"]:visible')
        if ledger_next.count():
            ledger_next.click()
            assert page.locator('[data-collection="cashLedger"] .audit-list:visible li').count() <= 100
        # Full history remains verified through the paginated APIs above; the UI export is PDF.
        with page.expect_download() as complete_download:
            page.get_by_role("button", name="Unduh laporan keuangan PDF").click()
        complete_pdf_path = Path("/tmp/pangsuma-complete-export.pdf")
        complete_download.value.save_as(complete_pdf_path)
        assert complete_pdf_path.read_bytes().startswith(b"%PDF-")
        complete_text = subprocess.run(["pdftotext", str(complete_pdf_path), "-"], check=True, capture_output=True, text=True).stdout
        assert "RINGKASAN" in complete_text and "Buku Kas" in complete_text and "Lampiran Audit" in complete_text
        assert "Perlengkapan latihan" in complete_text and "Transport kegiatan lapangan" in complete_text

        assert api(page, '/api/export.csv')['status'] == 404
        local_d1_rows("DELETE FROM login_attempts")
        digit_values = ",".join(f"({value})" for value in range(10))
        expired_fixture = f"""
          WITH digits(value) AS (VALUES {digit_values}),
          numbers(n) AS (
            SELECT a.value + 10*b.value + 100*c.value + 1000*d.value + 10000*e.value
            FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e
          )
          INSERT INTO login_attempts(rate_key, failure_count, window_started_ms, blocked_until_ms)
          SELECT printf('fixture-expired-%05d', n), 1, 0, 0 FROM numbers WHERE n < 20005
        """
        local_d1_rows(expired_fixture)
        expired_attempt = api(
            page,
            "/api/login",
            "POST",
            {"email": "expire-prune@example.invalid", "password": "invalid-local-password"},
            {"CF-Connecting-IP": "203.0.113.21"},
        )
        assert expired_attempt["status"] == 401
        expired_counts = local_d1_rows(
            "SELECT COUNT(*) AS total, SUM(CASE WHEN rate_key LIKE 'fixture-expired-%' THEN 1 ELSE 0 END) AS fixtures FROM login_attempts"
        )[0]
        assert expired_counts["total"] == 2 and (expired_counts["fixtures"] or 0) == 0, expired_counts

        local_d1_rows("DELETE FROM login_attempts")
        fixture_now = int(time.time() * 1000)
        protected_email = "protected-cap@example.invalid"
        protected_ip = "203.0.113.23"
        protected_account_key = hashlib.sha256(f"account\0{protected_email}".encode()).hexdigest()
        protected_ip_key = hashlib.sha256(f"ip\0{protected_ip}".encode()).hexdigest()
        active_fixture = f"""
          WITH digits(value) AS (VALUES {digit_values}),
          numbers(n) AS (
            SELECT a.value + 10*b.value + 100*c.value + 1000*d.value + 10000*e.value
            FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e
          )
          INSERT INTO login_attempts(rate_key, failure_count, window_started_ms, blocked_until_ms)
          SELECT printf('fixture-cap-%05d', n), 1, {fixture_now}, 0
          FROM numbers WHERE n < 20005
        """
        local_d1_rows(active_fixture)
        local_d1_rows(
            "INSERT INTO login_attempts(rate_key,failure_count,window_started_ms,blocked_until_ms) "
            f"VALUES ('{protected_account_key}',1,{fixture_now},{fixture_now + 3600000}), "
            f"('{protected_ip_key}',1,{fixture_now},{fixture_now + 3600000})"
        )
        cap_attempt = api(
            page,
            "/api/login",
            "POST",
            {"email": protected_email, "password": "invalid-local-password"},
            {"CF-Connecting-IP": protected_ip},
        )
        assert cap_attempt["status"] == 429, "pruning must preserve a protected account and IP bucket"
        cap_counts = local_d1_rows(
            "SELECT COUNT(*) AS total, SUM(CASE WHEN rate_key IN "
            f"('{protected_account_key}','{protected_ip_key}') AND blocked_until_ms > {fixture_now} THEN 1 ELSE 0 END) AS protected "
            "FROM login_attempts"
        )[0]
        assert cap_counts["total"] == 20000 and cap_counts["protected"] == 2, cap_counts

        account_email = "rate-limit-account@example.invalid"
        for index in range(8):
            failure = api(
                page,
                "/api/login",
                "POST",
                {"email": account_email, "password": "invalid-local-password"},
                {"CF-Connecting-IP": f"192.0.2.{index + 1}"},
            )
            assert failure["status"] == 401, failure
        account_block = api(
            page,
            "/api/login",
            "POST",
            {"email": account_email, "password": "invalid-local-password"},
            {"CF-Connecting-IP": "192.0.2.99"},
        )
        assert account_block["status"] == 429, "per-account bucket must apply across source IPs"

        shared_ip = "198.51.100.77"
        blocked_at = None
        for index in range(25):
            failure = api(
                page,
                "/api/login",
                "POST",
                {"email": f"rate-limit-ip-{index}@example.invalid", "password": "invalid-local-password"},
                {"CF-Connecting-IP": shared_ip},
            )
            if failure["status"] == 429:
                blocked_at = index + 1
                break
            assert failure["status"] == 401, failure
        assert blocked_at is not None and blocked_at <= 21, f"IP bucket did not limit distinct accounts: {blocked_at}"

        assert not page_errors, f"browser page errors: {page_errors}"
        # Console noise from Chromium and PWA lifecycle is diagnostic only; fail on uncaught JS errors above.
        browser.close()

    print("LOCAL E2E PASSED")
    print("- Bootstrap created 10 roster accounts; repeated bootstrap was blocked.")
    print("- Password reset, forced password change, manager/user roles, and per-user data isolation passed.")
    print("- Local-only opening balance, idempotent submission/approval, atomic petty-cash debit, and insufficient-balance guard passed.")
    print("- Fail-closed logout, expired-session dialog cleanup, per-account/IP throttling, and idempotency payload conflict checks passed.")
    print("- Cursor pagination returned complete submission, ledger, and audit histories; the paginated API histories included every record and the streamed Manager PDF included report sections.")
    print("- Finance approval, rejection reason, sent status, PDF export, audit persistence, and deactivation-with-history passed.")
    print("- Responsive overflow checks passed at 320, 390, 768, 1024, and 1440 CSS px, plus 844×390 landscape.")
    print("- Screenshots and PDF are local review artifacts under /tmp only; no production data or deployment was used.")


if __name__ == "__main__":
    main()
