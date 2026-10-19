from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import struct
import sys
import time
import uuid
import zlib
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

BASE = os.environ.get("PANGSUMA_LOCAL_URL", "http://localhost:8788").rstrip("/")
assert urlparse(BASE).scheme in ("http", "https") and urlparse(BASE).hostname in ("localhost", "127.0.0.1", "::1"), "local loopback URL required"
ORIGIN = BASE
ITER = 600_000
VERSION = "client-pbkdf2-hmac-v1"
MANAGER = "rahmat@pangsumafc.com"
SCREENSHOTS = Path(os.environ["PROFILE_REVIEW_DIR"])


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AssertionError("local test must not follow HTTP redirects")


def credential(password: str, salt: bytes | None = None):
    salt = salt or secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITER, 32)
    return {"version": VERSION, "iterations": ITER, "salt": base64.b64encode(salt).decode(),
            "derived": base64.b64encode(derived).decode(), "passwordLength": len(password)}


def http(path, body=None, *, method="POST", headers=None, cookie=None, origin=ORIGIN):
    h = {"Origin": origin, "Content-Type": "application/json", **(headers or {})}
    if cookie:
        h["Cookie"] = cookie
    req = Request(BASE + path, method=method, headers=h,
                  data=None if body is None else json.dumps(body).encode())
    try:
        with build_opener(NoRedirect).open(req, timeout=30) as r:
            raw = r.read()
            try:
                data = json.loads(raw or b"{}")
            except (TypeError, ValueError):
                data = {}
            return r.status, data, dict(r.headers)
    except HTTPError as e:
        try:
            data = json.loads(e.read() or b"{}")
        except Exception:
            data = {}
        return e.code, data, dict(e.headers)


def tiny_png() -> bytes:
    # A valid 1x1 RGBA PNG; deliberately tiny so the browser resize path is exercised.
    raw = b"\x00\xff\x00\x00\xff"
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def data_url_png() -> str:
    return "data:image/png;base64," + base64.b64encode(tiny_png()).decode()


def api(page: Page, path, method="GET", body=None, headers=None):
    # Normal writes use a freshly fetched version. Race tests supply an explicit old version.
    if method == "PUT" and path.endswith("/profile") and body is not None and "profileVersion" not in body:
        current = api(page, path)
        if current["status"] == 200:
            body = {**body, "profileVersion": current["data"]["user"]["profileVersion"]}
    return page.evaluate("""async ({path,method,body,headers}) => {
      const h={...(headers||{})}; const o={method,credentials:'same-origin',headers:h};
      if (body !== null) { h['Content-Type']='application/json'; o.body=JSON.stringify(body); }
      const r=await fetch(path,o); let d={}; try { d=await r.json(); } catch {}
      return {status:r.status,data:d,headers:Object.fromEntries(r.headers.entries())};
    }""", {"path": path, "method": method, "body": body, "headers": headers or {}})


def complete_history(page: Page, collection: str, key: str):
    rows, cursor = [], ""
    for _ in range(200):
        result = api(page, f"/api/history/{collection}" + (f"?cursor={cursor}" if cursor else ""))
        assert result["status"] == 200, result
        data = result["data"]
        rows.extend(data[key])
        if not data.get("hasMore"):
            return rows
        cursor = data["nextCursor"]
    raise AssertionError("history pagination exceeded synthetic fixture bound")

def login(page: Page, email: str, password: str):
    page.locator("#loginIdentifier").fill(email)
    page.locator("#loginPassword").fill(password)
    page.locator("#loginPassword").press("Enter")
    page.locator("#loginGate").wait_for(state="hidden", timeout=20_000)


def logout(page: Page):
    page.locator("#logoutButton").click()
    page.locator("body.logged-out").wait_for(timeout=10_000)


def rotate_first_login(page: Page, current: str) -> str:
    new = "Profile-mgr-rotated-" + secrets.token_urlsafe(12)
    page.locator("#currentPassword").fill(current)
    page.locator("#newPassword").fill(new)
    page.locator("#confirmPassword").fill(new)
    page.locator("#passwordForm button[type='submit']").click()
    page.locator("#passwordForm").wait_for(state="detached", timeout=20_000)
    return new


def login_user_and_rotate(page: Page, email: str, temporary: str) -> str:
    login(page, email, temporary)
    new = "Profile-user-rotated-" + secrets.token_urlsafe(12)
    page.locator("#currentPassword").fill(temporary)
    page.locator("#newPassword").fill(new)
    page.locator("#confirmPassword").fill(new)
    page.locator("#passwordForm button[type='submit']").click()
    page.locator("#passwordForm").wait_for(state="detached", timeout=20_000)
    return new


def set_file(page: Page, selector: str, name: str, data: bytes, mime: str):
    assert page.locator(selector).count() == 1
    with page.expect_file_chooser() as chooser:
        page.locator("#profilePhoto").click()
    chooser.value.set_files({"name": name, "mimeType": mime, "buffer": data})


def visible_dialog(page: Page):
    dialog = page.locator("#userProfileDialog")
    dialog.wait_for(state="visible", timeout=10_000)
    expect(dialog.locator("#profileSubmit")).to_be_enabled(timeout=10_000)
    return dialog


def main():
    token = os.environ.get("BOOTSTRAP_TOKEN")
    manager_pw = os.environ.get("LOCAL_MANAGER_PASSWORD") or secrets.token_urlsafe(18)
    assert token and len(token) >= 32, "runner must provide a local >=32-byte BOOTSTRAP_TOKEN"
    assert len(manager_pw) >= 12
    status, data, _ = http("/api/bootstrap", {"managerCredential": credential(manager_pw)}, headers={"Authorization": f"Bearer {token}"})
    assert status == 201 and data.get("userCount", data.get("seededUsers")) == 10, (status, data)

    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    browser_errors: list[str] = []
    with sync_playwright() as p:
        browser: Browser = p.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        manager_ctx: BrowserContext = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Asia/Jakarta")
        manager_ctx.route("**/*", lambda route: route.continue_() if route.request.url.startswith(BASE + "/") else route.abort())
        manager = manager_ctx.new_page()
        manager.on("pageerror", lambda e: browser_errors.append("manager: " + str(e)))
        manager.goto(BASE, wait_until="networkidle", timeout=30_000)
        login(manager, MANAGER, manager_pw)
        assert api(manager, "/api/overview")["status"] == 403
        manager_pw = rotate_first_login(manager, manager_pw)
        overview = api(manager, "/api/overview")
        assert overview["status"] == 200 and overview["data"].get("cashBalanceIdr", 0) == 0
        financial_before = {key: overview["data"][key] for key in ("cashBalanceIdr", "submissions", "cashLedger", "summary")}
        users = [u for u in overview["data"].get("users", []) if u.get("role") == "user" and u.get("active", u.get("is_active", 1))]
        assert len(users) >= 2, users
        target, second = users[0], users[1]
        manager_before = api(manager, "/api/profile")
        assert manager_before["status"] == 200
        manager_id = manager_before["data"]["user"]["id"]
        manager_quote = "Manager <own> & \"quote\" 'safe'."
        audit_before_success = len(api(manager, "/api/overview")["data"]["auditEvents"])
        manager_update = api(manager, f"/api/users/{manager_id}/profile", "PUT", {
            "nickname": "Manager Profile Alias", "dashboardPosition": "Manager Lead", "quote": manager_quote,
            "photoDataUrl": data_url_png()
        })
        assert manager_update["status"] == 200 and manager_update["data"]["user"]["photoUrl"]
        audit_after_success = api(manager, "/api/overview")["data"]["auditEvents"]
        assert len(audit_after_success) == audit_before_success + 1
        assert any(event["action"] == "user.profile_updated" and event["entity_id"] == manager_id for event in audit_after_success)
        manager_after = api(manager, "/api/profile")
        assert manager_after["status"] == 200
        assert manager_after["data"]["user"]["name"] == manager_before["data"]["user"]["name"]
        assert manager_after["data"]["user"]["position"] == manager_before["data"]["user"]["position"]
        assert manager_after["data"]["user"]["nickname"] == "Manager Profile Alias"
        assert api(manager, f"/api/users/{manager_id}/photo")["status"] == 200
        manager.evaluate("refreshProfile()")
        expect(manager.locator('.welcome-card h1')).to_contain_text('Manager Profile Alias')
        expect(manager.locator('.welcome-role')).to_have_text('Manager Lead')
        expect(manager.locator('.welcome-quote')).to_have_text(manager_quote)
        manager.screenshot(path=str(SCREENSHOTS / 'manager-dashboard-profile.png'), full_page=True)
        print('PROFILE_PHASE manager_profile_saved=1 successful_audit=1', flush=True)

        # The manager uses the actual roster UI to issue a temporary password; the target
        # then performs the mandatory browser-visible password rotation.
        manager.locator("[data-page='users']").first.click()
        manager.locator("tbody tr").first.wait_for(timeout=10_000)
        temporary = "Profile-target-temp-" + secrets.token_urlsafe(10)
        row = manager.locator("tbody tr").filter(has_text=target["name"])
        assert row.count() == 1
        row.locator("[data-action='reset-user-password']").click()
        manager.locator("#userPasswordDialog").wait_for(state="visible")
        manager.locator("#temporaryPassword").fill(temporary)
        manager.locator("#userPasswordSubmit").click()
        manager.locator("#userPasswordDialog").wait_for(state="hidden", timeout=20_000)
        target_pw = temporary

        user_ctx = browser.new_context(viewport={"width": 390, "height": 844}, timezone_id="America/Los_Angeles")
        user_ctx.route("**/*", lambda route: route.continue_() if route.request.url.startswith(BASE + "/") else route.abort())
        user = user_ctx.new_page()
        user.on("pageerror", lambda e: browser_errors.append("user: " + str(e)))
        user.goto(BASE, wait_until="networkidle", timeout=30_000)
        target_pw = login_user_and_rotate(user, target["email"], target_pw)
        profile = api(user, "/api/profile")
        assert profile["status"] == 200
        assert {"nickname", "dashboardPosition", "quote", "photoUrl", "profileVersion"}.issubset(profile["data"].get("user", {})), profile
        assert profile["data"]["user"]["name"] == target["name"]
        assert profile["data"]["user"]["position"] == target["position"]
        assert profile["data"]["user"]["role"] == "user"
        assert api(user, "/api/users")["status"] in (401, 403, 404)

        user_overview = api(user, "/api/overview")
        assert user_overview["status"] == 200
        for private_key in ("cashBalanceIdr", "cashLedger", "auditEvents", "users"):
            assert private_key not in user_overview["data"], private_key
        assert set(user_overview["data"]["history"]) == {"submissions"}
        assert not user.locator("[data-page='cash-info'], [data-page='approvals'], [data-page='finance']").count()
        assert not user.locator(".balance-panel, .cash-note, [data-panel='cash-ledger']").count()
        for path in ("/api/history/cash-ledger", "/api/history/audit-events", "/api/export.pdf"):
            assert api(user, path)["status"] == 403, path
        assert api(user, "/api/export.csv")["status"] == 404
        # Invalid empty payloads test authorization before any possible cash write.
        assert api(user, "/api/cash/opening-balance", "POST", {})["status"] == 403
        for action in ("approve", "reject", "send"):
            path = f"/api/submissions/{uuid.uuid4()}/{action}"
            assert api(user, path, "POST", {})["status"] == 403, path
        assert api(manager, "/api/history/cash-ledger")["status"] == 200

        # A real local-only report makes the immutability check non-empty.
        fixture_report = api(user, "/api/submissions", "POST", {
            "type": "petty_cash", "amountIdr": 125000, "date": "2026-10-17",
            "description": "Local profile regression fixture", "note": "Must remain unchanged"
        }, {"Idempotency-Key": str(uuid.uuid4())})
        assert fixture_report["status"] == 201, fixture_report
        for path in ("/api/overview", "/api/submissions", "/api/history/submissions"):
            own = api(user, path)
            assert own["status"] == 200
            assert own["data"]["submissions"]
            assert all(item["createdBy"] == target["id"] for item in own["data"]["submissions"])
            assert any(item["type"] == "petty_cash" and item["status"] == "pending" for item in own["data"]["submissions"])
            assert "cashBalanceIdr" not in own["data"] and "cashLedger" not in own["data"]
        print('CASH_ACCESS_API_PASS user_balance_absent=1 user_ledger_403=1 user_audit_403=1 user_export_403=1 user_cash_writes_403=1 own_petty_cash_submit=201 own_status=200 manager_ledger=200', flush=True)
        report_overview = api(manager, "/api/overview")["data"]
        assert report_overview["submissions"] and report_overview["cashBalanceIdr"] == 0
        financial_before = {key: report_overview[key] for key in ("cashBalanceIdr", "submissions", "cashLedger", "summary")}
        history_before = {"submissions": complete_history(manager, "submissions", "submissions"), "audit": complete_history(manager, "audit-events", "auditEvents"), "ledger": complete_history(manager, "cash-ledger", "cashLedger")}

        # Manager profile form: fills current values, saves text plus photo, and persists.
        logout(user)
        manager.locator("[data-page='users']").first.click()
        manager.locator("tbody tr").first.wait_for(timeout=10_000)
        target_row = manager.locator("tbody tr").filter(has_text=target["name"])
        assert target_row.locator("[data-action='edit-user-profile']").count() == 1
        target_row.locator("[data-action='edit-user-profile']").click()
        dialog = visible_dialog(manager)
        expect(dialog.locator("#profileNickname")).to_be_visible()
        expect(dialog.locator("#profilePosition")).to_be_visible()
        expect(dialog.locator("#profileQuote")).to_be_visible()
        assert dialog.locator("#profilePhoto").count() == 1
        expect(dialog.locator("#profilePhoto")).to_be_visible()
        assert dialog.locator("#profilePhoto").get_attribute("type") == "file"
        assert dialog.locator("#profileNickname").input_value() == ""
        nickname, position, quote = "Profile Alias", "Profile Lead", "Keep <ledger> & \"clear\" 'now'."
        dialog.locator("#profileNickname").fill(nickname)
        dialog.locator("#profilePosition").fill(position)
        dialog.locator("#profileQuote").fill(quote)
        set_file(manager, "#profilePhoto", "avatar.png", tiny_png(), "image/png")
        expect(dialog.locator("#profilePhotoStatus")).to_contain_text("Foto siap", timeout=10_000)
        expect(dialog.locator("#profileSubmit")).to_be_enabled()
        expect(dialog.locator("#profilePreview")).to_be_visible()
        dialog.locator("#profileSubmit").click()
        dialog.wait_for(state="hidden", timeout=20_000)
        saved = api(manager, f"/api/users/{target['id']}/profile")
        assert saved["status"] == 200 and saved["data"]["user"]["photoUrl"]
        assert api(manager, f"/api/users/{target['id']}/photo")["status"] == 200
        # Reopen from the manager roster to prove persistence without assuming an
        # undocumented manager-only profile GET route.
        target_row.locator("[data-action='edit-user-profile']").click()
        dialog = visible_dialog(manager)
        assert dialog.locator("#profileNickname").input_value() == nickname
        assert dialog.locator("#profilePosition").input_value() == position
        assert dialog.locator("#profileQuote").input_value() == quote
        dialog.locator("[data-action='close-dialog']").first.click()
        dialog.wait_for(state="hidden")
        assert api(manager, "/api/overview")["data"].get("cashBalanceIdr", 0) == 0
        manager.screenshot(path=str(SCREENSHOTS / "manager-profile-saved.png"), full_page=True)

        # User dashboard must sync after reload and explicit refreshProfile without a full render.
        user.goto(BASE, wait_until="networkidle", timeout=30_000)
        login(user, target["email"], target_pw)
        user.locator(".welcome-card").wait_for(timeout=10_000)
        assert nickname in user.locator(".welcome-card h1").inner_text()
        assert user.locator(".welcome-role").inner_text() == position
        assert user.locator(".welcome-quote").inner_text() == quote
        assert "<ledger>" not in user.locator(".welcome-quote").evaluate("el => el.innerHTML")
        assert user.locator(".welcome-card img").count() == 1
        assert user.locator(".welcome-card img").evaluate("img => img.complete && img.naturalWidth > 0")
        before_form = user.locator("body").inner_text()
        assert user.evaluate("typeof window.refreshProfile") == "function"
        user.locator("[data-page='new-report']:visible").first.click()
        user.locator("#reportType").select_option("petty_cash")
        user.locator("#reportDescription").fill("Draft survives profile refresh")
        before_refresh = user.locator("body").inner_text()
        user.evaluate("window.refreshProfile()")
        user.wait_for_timeout(500)
        assert before_form != before_refresh
        assert user.locator("body").inner_text() == before_refresh
        assert user.locator("#reportDescription").input_value() == "Draft survives profile refresh"
        user.locator("#mobileNav [data-page='overview']").click()
        user.locator(".welcome-card").wait_for(timeout=10_000)
        user.screenshot(path=str(SCREENSHOTS / "user-dashboard-synced.png"), full_page=True)
        print('PROFILE_PHASE user_login_gallery_sync=1 draft_preserved=1', flush=True)

        # Live update: change the logged-in target from another authenticated context and
        # prove the 30-second active polling path updates without rebuilding a draft form.
        manager2 = manager_ctx.new_page()
        manager2.on("pageerror", lambda e: browser_errors.append("manager2: " + str(e)))
        manager2.goto(BASE, wait_until="networkidle", timeout=30_000)
        manager2.locator("[data-page='users']:visible").first.click()
        manager2.locator("tbody tr").first.wait_for(timeout=10_000)
        target_live_row = manager2.locator("tbody tr").filter(has_text=target["name"])
        target_live_row.locator("[data-action='edit-user-profile']").click()
        live_dialog = visible_dialog(manager2)
        live_dialog.locator("#profileNickname").fill("Live Alias")
        live_dialog.locator("#profilePosition").fill("Live Role")
        live_dialog.locator("#profileQuote").fill("Live quote")
        live_dialog.locator("#profileSubmit").click()
        live_dialog.wait_for(state="hidden", timeout=20_000)
        user.bring_to_front()
        user.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(user.locator(".welcome-role")).to_have_text("Live Role", timeout=32_000)
        expect(user.locator(".welcome-quote")).to_have_text("Live quote")
        # A second update uses only the interval, not an explicit focus/refresh call.
        polled = api(manager2, f"/api/users/{target['id']}/profile", "PUT", {
            "nickname": "Live Alias", "dashboardPosition": "Polled Role", "quote": "Polled quote"
        })
        assert polled['status'] == 200
        expect(user.locator('.welcome-role')).to_have_text('Polled Role', timeout=35_000)

        # A stale roster must not populate the editor, and a stale open editor cannot win.
        target_row.locator("[data-action='edit-user-profile']").click()
        stale_dialog = visible_dialog(manager)
        assert stale_dialog.locator("#profilePosition").input_value() == "Polled Role"
        stale_dialog.locator("#profileNickname").fill("Stale manager draft")
        snapshot = api(manager2, f"/api/users/{target['id']}/profile")["data"]["user"]
        latest = api(manager2, f"/api/users/{target['id']}/profile", "PUT", {
            "nickname": "Newer manager value", "dashboardPosition": "Polled Role", "quote": "Polled quote",
            "profileVersion": snapshot["profileVersion"]
        })
        assert latest["status"] == 200, latest
        audit_before_conflict = api(manager2, "/api/overview")["data"]["auditEvents"]
        stale_dialog.locator("#profileSubmit").click()
        expect(stale_dialog.locator("#profileError")).to_contain_text("Manager lain")
        expect(stale_dialog.locator("#profileSubmit")).to_be_disabled()
        assert stale_dialog.locator("#profileNickname").input_value() == "Stale manager draft"
        conflict_current = api(manager2, f"/api/users/{target['id']}/profile")["data"]["user"]
        assert conflict_current["nickname"] == "Newer manager value"
        assert conflict_current["profileVersion"] == snapshot["profileVersion"] + 1
        assert api(manager2, "/api/overview")["data"]["auditEvents"] == audit_before_conflict
        direct_conflict = api(manager2, f"/api/users/{target['id']}/profile", "PUT", {
            "nickname": "Direct stale", "dashboardPosition": "Wrong", "quote": "Wrong", "photoDataUrl": None,
            "profileVersion": snapshot["profileVersion"]
        })
        assert direct_conflict["status"] == 409 and direct_conflict["data"]["error"]["code"] == "profile_conflict", direct_conflict
        assert api(manager2, f"/api/users/{target['id']}/profile")["data"]["user"] == conflict_current
        manager.screenshot(path=str(SCREENSHOTS / "manager-profile-conflict.png"), full_page=True)
        manager.once("dialog", lambda prompt: prompt.accept())
        stale_dialog.locator("[data-action='close-dialog']").first.click()
        target_row.locator("[data-action='edit-user-profile']").click()
        reopened = visible_dialog(manager)
        assert reopened.locator("#profileNickname").input_value() == "Newer manager value"
        reopened.press("Escape")
        reopened.wait_for(state="hidden")
        print('PROFILE_PHASE stale_roster_refresh=1 stale_save_409=1 draft_preserved=1 conflict_no_audit=1', flush=True)

        # Concurrent contexts: manager edits another user's profile while user remains usable.
        initial = {"nickname": "", "dashboardPosition": "", "quote": "", "profileVersion": 0}
        initial_write = api(manager2, f"/api/users/{second['id']}/profile", "PUT", initial)
        assert initial_write["status"] == 200, initial_write
        duplicate_initial = api(manager2, f"/api/users/{second['id']}/profile", "PUT", initial)
        assert duplicate_initial["status"] == 409, duplicate_initial
        webp_photo = api(manager2, f"/api/users/{second['id']}/profile", "PUT", {
            "nickname": "", "dashboardPosition": "", "quote": "",
            "photoDataUrl": "data:image/webp;base64,UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA="
        })
        assert webp_photo["status"] == 200, webp_photo
        # Failed loads cannot leave an editable stale roster form behind.
        profile_path = f"**/api/users/{second['id']}/profile"
        manager2.route(profile_path, lambda route: route.abort())
        manager2.locator("tbody tr").filter(has_text=second["name"]).locator("[data-action='edit-user-profile']").click()
        failed_dialog = manager2.locator("#userProfileDialog")
        expect(failed_dialog.locator("#profileError")).to_be_visible()
        expect(failed_dialog.locator("#profileSubmit")).to_be_disabled()
        expect(failed_dialog.locator("#profileNickname")).to_be_disabled()
        failed_dialog.press("Escape")
        manager2.unroute(profile_path)
        second_row = manager2.locator("tbody tr").filter(has_text=second["name"])
        second_row.locator("[data-action='edit-user-profile']").click()
        dialog2 = visible_dialog(manager2)
        dialog2.locator("#profileNickname").fill("Second Alias")
        dialog2.locator("#profilePosition").fill("Second Role")
        dialog2.locator("#profileQuote").fill("Second quote")
        set_file(manager2, "#profilePhoto", "second.png", tiny_png(), "image/png")
        expect(dialog2.locator("#profilePhotoStatus")).to_contain_text("Foto siap", timeout=10_000)
        expect(dialog2.locator("#profileSubmit")).to_be_enabled()
        dialog2.locator("#profileSubmit").click(); dialog2.wait_for(state="hidden", timeout=20_000)
        assert api(user, "/api/session")["status"] == 200
        assert api(manager2, f"/api/profile")["status"] == 200

        # Cancel is a no-op, remove is explicit, and invalid values are rejected.
        second_row.locator("[data-action='edit-user-profile']").click(); dialog2 = visible_dialog(manager2)
        dialog2.locator("#profileNickname").fill("Should Not Save")
        cancel = dialog2.locator("[data-action='close-dialog']").first
        assert cancel.count() == 1, "profile dialog needs a cancel/close selector"
        manager2.once("dialog", lambda prompt: prompt.accept())
        cancel.click(); dialog2.wait_for(state="hidden")
        second_row.locator("[data-action='edit-user-profile']").click(); dialog2 = visible_dialog(manager2)
        assert dialog2.locator("#profileNickname").input_value() == "Second Alias"
        dialog2.locator("[data-action='close-dialog']").first.click(); dialog2.wait_for(state="hidden")
        bad = api(manager2, f"/api/users/{second['id']}/profile", "PUT", {"nickname": "x" * 41, "dashboardPosition": "ok", "quote": "ok"})
        assert bad["status"] in (400, 422), bad
        spoof = api(manager2, f"/api/users/{second['id']}/profile", "PUT", {"nickname": "ok", "dashboardPosition": "ok", "quote": "ok", "role": "manager", "name": "Spoof", "position": "Spoof"})
        assert spoof["status"] == 400, spoof
        roster_after_spoof = api(manager2, "/api/overview")["data"].get("users", [])
        second_roster = next(u for u in roster_after_spoof if u.get("id") == second["id"])
        assert second_roster.get("role") == "user" and second_roster.get("name") == second["name"] and second_roster.get("position") == second["position"]
        nulls = api(manager2, f"/api/users/{second['id']}/profile", "PUT", {"nickname": "Second Alias", "dashboardPosition": "Second Role", "quote": "Second quote", "photoDataUrl": None})
        assert nulls["status"] in (200, 204), nulls
        # Restore a real photo so the visible remove affordance has something to remove.
        restored = api(manager2, f"/api/users/{second['id']}/profile", "PUT", {"nickname": "Second Alias", "dashboardPosition": "Second Role", "quote": "Second quote", "photoDataUrl": data_url_png()})
        assert restored["status"] == 200, restored
        second_row.locator("[data-action='edit-user-profile']").click(); dialog2 = visible_dialog(manager2)
        assert dialog2.locator("[data-action='remove-profile-photo']").count() == 1
        dialog2.locator("[data-action='remove-profile-photo']").click()
        dialog2.locator("#profileSubmit").click(); dialog2.wait_for(state="hidden", timeout=20_000)

        # Server-side validation and authorization, including CSRF Origin rejection and photo isolation.
        manager_cookie = "".join(f"{c['name']}={c['value']}; " for c in manager_ctx.cookies())
        target_cookie = "".join(f"{c['name']}={c['value']}; " for c in user_ctx.cookies())
        missing_version = http(f"/api/users/{second['id']}/profile", {"nickname": "No version", "dashboardPosition": "", "quote": ""}, method="PUT", cookie=manager_cookie)
        assert missing_version[0] == 400 and missing_version[1]['error']['code'] == 'profile_version_required', missing_version
        assert http(f"/api/users/{second['id']}/profile", {"nickname": "evil"}, method="PUT", origin="https://evil.invalid", cookie=manager_cookie)[0] == 403
        denied = http(f"/api/users/{target['id']}/profile", {"nickname": "denied"}, method="PUT", cookie=target_cookie)
        assert denied[0] in (401, 403)
        own_body = {"nickname": "Denied user", "dashboardPosition": "Denied role", "quote": "Denied quote", "photoDataUrl": None}
        own_put = api(user, "/api/profile", "PUT", own_body)
        assert own_put["status"] == 403, own_put
        own_target_put = api(user, f"/api/users/{target['id']}/profile", "PUT", own_body)
        assert own_target_put["status"] == 403, own_target_put
        assert http('/api/profile', method='GET')[0] == 401
        manager_photo = http(f"/api/users/{target['id']}/photo", method="GET", cookie=manager_cookie)
        assert manager_photo[0] == 200 and manager_photo[2].get("Content-Type", "").startswith("image/"), manager_photo
        own_photo = http(f"/api/users/{target['id']}/photo", method="GET", cookie=target_cookie)
        assert own_photo[0] == 200 and own_photo[2].get("Content-Type", "").startswith("image/"), own_photo
        # Remove the target's saved photo through the visible UI affordance and verify
        # the target photo route no longer serves bytes.
        manager2.locator("[data-page='users']:visible").first.click()
        manager2.locator("tbody tr").first.wait_for(timeout=10_000)
        target_remove_row = manager2.locator("tbody tr").filter(has_text=target["name"])
        target_remove_row.locator("[data-action='edit-user-profile']").click()
        remove_dialog = visible_dialog(manager2)
        remove_dialog.locator("[data-action='remove-profile-photo']").click()
        remove_dialog.locator("#profileSubmit").click()
        remove_dialog.wait_for(state="hidden", timeout=20_000)
        removed_target = api(manager2, f"/api/users/{target['id']}/profile")
        assert removed_target["status"] == 200 and not removed_target["data"]["user"]["photoUrl"]
        assert http(f"/api/users/{target['id']}/photo", method="GET", cookie=manager_cookie)[0] == 404
        cross_photo = http(f"/api/users/{second['id']}/photo", method="GET", cookie=target_cookie)
        assert cross_photo[0] in (401, 403, 404), cross_photo
        fake_jpeg_20 = bytes([0xff,0xd8,0xff,0xc0,0,8,8,0,1,0,1,1,0xff,0xda,0,2,0,0,0xff,0xd9])
        fake_webp_30 = bytearray(30)
        fake_webp_30[:4] = b'RIFF'; struct.pack_into('<I', fake_webp_30, 4, 22)
        fake_webp_30[8:12] = b'WEBP'; fake_webp_30[12:16] = b'VP8 '
        struct.pack_into('<I', fake_webp_30, 16, 10)
        fake_webp_30[20:26] = bytes([0x30,0,0,0x9d,1,0x2a])
        struct.pack_into('<HH', fake_webp_30, 26, 1, 1)
        fake_webp_36 = bytearray(fake_webp_30 + bytes(6))
        struct.pack_into('<I', fake_webp_36, 4, 28); struct.pack_into('<I', fake_webp_36, 16, 16)
        invalids = [
            ("image.svg", b"<svg xmlns='http://www.w3.org/2000/svg'></svg>", "image/svg+xml"),
            ("spoof.jpg", b"not-a-real-jpeg", "image/jpeg"),
            ("header-only.jpg", fake_jpeg_20, "image/jpeg"),
            ("header-only.webp", bytes(fake_webp_30), "image/webp"),
            ("padded-fake.webp", bytes(fake_webp_36), "image/webp"),
            ("huge.png", b"\x89PNG" + b"x" * (10 * 1024 * 1024 + 1), "image/png"),
        ]
        for filename, raw, mime in invalids:
            invalid_data_url = "data:" + mime + ";base64," + base64.b64encode(raw).decode()
            rejected = api(manager2, f"/api/users/{second['id']}/profile", "PUT", {"nickname": "ok", "dashboardPosition": "ok", "quote": "ok", "photoDataUrl": invalid_data_url})
            assert rejected["status"] in (400, 413, 415, 422), (filename, rejected)
            print(f'PROFILE_IMAGE_API_REJECT filename={filename} status={rejected["status"]}', flush=True)
        unchanged = api(manager2, '/api/overview')['data']
        for key, value in financial_before.items():
            assert unchanged[key] == value, key
        print('PROFILE_IMAGE_API_PASS rejected=6 financial_unchanged=1 nonempty_report_unchanged=1', flush=True)

        for filename, raw, mime in invalids:
            print(f'PROFILE_IMAGE_BROWSER_CHECK filename={filename}', flush=True)
            manager2.locator("[data-page='users']:visible").first.click(); manager2.locator("tbody tr").first.wait_for(timeout=10_000)
            second_row = manager2.locator("tbody tr").filter(has_text=second["name"])
            second_row.locator("[data-action='edit-user-profile']").click(); d = visible_dialog(manager2)
            set_file(manager2, "#profilePhoto", filename, raw, mime)
            expect(d.locator("#profileError")).to_be_visible(timeout=10_000)
            d.locator("[data-action='close-dialog']").first.click()
            d.wait_for(state="hidden")

        # Responsive dialog/dashboard checks at all required widths, with no horizontal overflow.
        for width in (320, 390, 768, 1280):
            manager2.set_viewport_size({"width": width, "height": 900})
            manager2.locator("[data-page='users']:visible").first.click()
            try:
                manager2.locator("tbody tr").first.wait_for(timeout=10_000)
            except Exception:
                manager2.screenshot(path=str(SCREENSHOTS / f"profile-viewport-error-{width}.png"), full_page=True)
                print("PROFILE_VIEWPORT_DIAGNOSTIC", width, manager2.locator("#appContent").inner_text(), browser_errors, flush=True)
                raise
            manager2.locator("tbody tr").filter(has_text=second["name"]).locator("[data-action='edit-user-profile']").click(); d = visible_dialog(manager2)
            assert manager2.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            d.screenshot(path=str(SCREENSHOTS / f"profile-dialog-{width}.png"))
            submit = d.locator('#profileSubmit')
            submit.scroll_into_view_if_needed()
            submit.click(trial=True)
            assert submit.bounding_box()['height'] >= 44
            d.press('Tab')
            assert manager2.evaluate("document.activeElement.closest('#userProfileDialog') !== null")
            d.press('Escape'); d.wait_for(state="hidden")
        user.set_viewport_size({"width": 320, "height": 844})
        user.goto(BASE, wait_until="networkidle", timeout=30_000)
        user.locator(".welcome-card").wait_for(timeout=10_000)
        assert user.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        user.screenshot(path=str(SCREENSHOTS / "user-dashboard-320.png"), full_page=True)

        # Clearing optional profile text is supported without changing official roster fields.
        cleared = api(manager2, f"/api/users/{second['id']}/profile", 'PUT', {
            'nickname': '', 'dashboardPosition': '', 'quote': '', 'photoDataUrl': None
        })
        assert cleared['status'] == 200, cleared
        assert cleared['data']['user']['nickname'] == '' and cleared['data']['user']['quote'] == ''
        assert cleared['data']['user']['dashboardPosition'] == second['position']
        final_overview = api(manager2, '/api/overview')['data']
        for key, value in financial_before.items():
            assert final_overview[key] == value, key
        history_after = {"submissions": complete_history(manager2, "submissions", "submissions"), "audit": complete_history(manager2, "audit-events", "auditEvents"), "ledger": complete_history(manager2, "cash-ledger", "cashLedger")}
        # Compare complete financial histories and retain every prior audit row.
        assert manager2.evaluate("async () => (await fetch('/api/export.csv')).status") == 404
        assert history_after['submissions'] == history_before['submissions']
        assert history_after['ledger'] == history_before['ledger']
        before_audit_ids = {row['id'] for row in history_before['audit']}
        after_audit_ids = {row['id'] for row in history_after['audit']}
        assert before_audit_ids <= after_audit_ids
        prior_audit = {row['id']: row for row in history_before['audit']}
        final_audit = {row['id']: row for row in history_after['audit']}
        assert all(final_audit[id] == row for id, row in prior_audit.items())
        assert any(row['action'] == 'user.profile_updated' for row in final_audit.values())
        for original in overview['data']['users']:
            final_user = next(u for u in final_overview['users'] if u['id'] == original['id'])
            for key in ('id', 'name', 'email', 'position', 'role', 'active'):
                assert final_user[key] == original[key], (original['id'], key)
        user_ctx.close(); manager_ctx.close(); browser.close()
    assert not browser_errors, browser_errors
    print("PROFILE_FLOW_PASS bootstrap=1 manager_rotation=1 manager_target_profile=1 user_sync=1 concurrent_contexts=1 fresh_editor=1 conflict_409=1 conflict_no_audit=1 initial_conflict=1 missing_version=1 load_error=1 validation=1 csrf=1 auth=1 photo_isolation=1 financial_unchanged=1 nonempty_report_unchanged=1 financial_history_unchanged=1 audit_history_preserved=1 roster_unchanged=1 responsive=320,390,768,1280 screenshots=" + str(SCREENSHOTS))


if __name__ == "__main__":
    main()
