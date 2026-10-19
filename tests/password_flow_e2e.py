from __future__ import annotations

import base64, hashlib, json, os, secrets, sys, time
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright

BASE = os.environ.get("PANGSUMA_LOCAL_URL", "http://localhost:8788").rstrip("/")
ORIGIN = BASE
ITER = 600_000
VERSION = "client-pbkdf2-hmac-v1"
MANAGER = "rahmat@pangsumafc.com"


def credential(password: str, salt: bytes | None = None):
    salt = salt or secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITER, 32)
    return {"version": VERSION, "iterations": ITER, "salt": base64.b64encode(salt).decode(),
            "derived": base64.b64encode(derived).decode(), "passwordLength": len(password)}


def http(path, body=None, headers=None, origin=ORIGIN):
    h = {"Origin": origin, "Content-Type": "application/json", **(headers or {})}
    req = Request(BASE + path, method="POST", headers=h,
                  data=None if body is None else json.dumps(body).encode())
    try:
        with urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except HTTPError as e:
        try: data = json.loads(e.read() or b"{}")
        except Exception: data = {}
        return e.code, data


def main():
    token = os.environ.get("BOOTSTRAP_TOKEN")
    manager_pw = os.environ.get("LOCAL_MANAGER_PASSWORD") or secrets.token_urlsafe(18)
    assert token and len(token) >= 32, "runner must provide a local >=32-byte BOOTSTRAP_TOKEN"
    assert len(manager_pw) >= 12
    # Bootstrap is deliberately the only direct HTTP setup request; all subsequent
    # authentication and resets are exercised through the rendered application.
    status, data = http("/api/bootstrap", {"managerCredential": credential(manager_pw)},
                        {"Authorization": f"Bearer {token}"})
    assert status == 201, (status, data)
    assert data.get("userCount", data.get("seededUsers")) == 10, data
    bad_origin_status, _ = http("/api/auth/password-parameters", {"email": MANAGER}, origin="https://evil.invalid")
    assert bad_origin_status in (403, 404), bad_origin_status

    passwords = {"manager": manager_pw}
    browser_errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/chromium", headless=True,
                                    args=["--no-sandbox"])
        context = browser.new_context()
        page = context.new_page()
        page.on("pageerror", lambda e: browser_errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle", timeout=30_000)

        def api(path, method="GET", body=None, headers=None):
            return page.evaluate("""async ({path,method,body,headers}) => {
              const h = {...(headers||{})}; const o={method,credentials:'same-origin',headers:h};
              if (body !== null) { h['Content-Type']='application/json'; o.body=JSON.stringify(body); }
              const r=await fetch(path,o); let d={}; try {d=await r.json()} catch{}; return {status:r.status,data:d};
            }""", {"path": path, "method": method, "body": body, "headers": headers or {}})

        def login(email, password):
            page.locator("#loginIdentifier").fill(email)
            page.locator("#loginPassword").fill(password)
            page.locator("#loginPassword").press("Enter")
            page.locator("#loginGate").wait_for(state="hidden", timeout=20_000)

        def logout():
            page.locator("#logoutButton").click()
            page.locator("body.logged-out").wait_for(timeout=10_000)
            assert api("/api/session")["status"] == 401

        def derive_for(email, pw):
            params = api("/api/auth/password-parameters", "POST", {"email": email})
            assert params["status"] == 200 and params["data"]["version"] == VERSION
            raw_salt = base64.b64decode(params["data"]["salt"])
            return credential(pw, raw_salt)

        # Manager bootstrap forces a browser-visible mandatory change before access.
        login(MANAGER, manager_pw)
        assert api("/api/overview")["status"] == 403
        manager_new = "Mgr-rotated-local-" + secrets.token_urlsafe(12)
        page.locator("#currentPassword").fill(manager_pw)
        page.locator("#newPassword").fill(manager_new)
        page.locator("#confirmPassword").fill(manager_new)
        page.locator("#passwordForm button[type='submit']").click()
        page.locator("#passwordForm").wait_for(state="detached", timeout=20_000)
        passwords["manager"] = manager_new
        assert api("/api/overview")["status"] == 200
        overview = api("/api/overview")["data"]
        assert overview.get("cashBalanceIdr", 0) == 0
        manager_params = api("/api/auth/password-parameters", "POST", {"email": MANAGER})["data"]
        manager_salt = base64.b64decode(manager_params["salt"])
        wrong_current = api("/api/account/password", "POST", {
            "currentCredential": credential("wrong-current-local"),
            "newCredential": credential("would-not-be-used-local"),
            "newCurrentDerived": base64.b64encode(hashlib.pbkdf2_hmac("sha256", b"would-not-be-used-local", manager_salt, ITER, 32)).decode(),
        })
        assert wrong_current["status"] == 401, wrong_current
        unchanged_new = credential(passwords["manager"], secrets.token_bytes(16))
        unchanged_new_current = base64.b64encode(hashlib.pbkdf2_hmac("sha256", passwords["manager"].encode(), manager_salt, ITER, 32)).decode()
        unchanged = api("/api/account/password", "POST", {
            "currentCredential": credential(passwords["manager"], manager_salt),
            "newCredential": unchanged_new,
            "newCurrentDerived": unchanged_new_current,
        })
        assert unchanged["status"] == 400, unchanged
        malformed_rotation = api("/api/account/password", "POST", {
            "currentCredential": credential(passwords["manager"], manager_salt),
            "newCredential": credential("another-new-local"), "newCurrentDerived": "not-base64-proof",
        })
        assert malformed_rotation["status"] == 400, malformed_rotation
        # Overview is a bounded dashboard snapshot, not the complete account list.
        all_users = []
        user_page = 1
        while True:
            account_page = api(f"/api/users?page={user_page}&limit=5")
            assert account_page["status"] == 200, account_page
            all_users.extend(account_page["data"]["users"])
            if not account_page["data"].get("hasMore"):
                break
            user_page += 1
            assert user_page <= 20, "unexpected unbounded account pagination"
        assert len({u["id"] for u in all_users}) == len(all_users)
        users = [u for u in all_users if u.get("role") == "user" and u.get("active", u.get("is_active", 1))]
        assert len(users) == 9, users
        assert sum(1 for u in users if (u.get("position") or "").upper() == "COO") == 1
        page.locator("[data-page='users']").first.click()
        page.locator("tbody tr").first.wait_for(timeout=10_000)

        # API negative coverage: malformed proof, unknown-account shape, wrong proof, and rate limit.
        unknown = api("/api/auth/password-parameters", "POST", {"email": "unknown@example.invalid"})
        known_params = api("/api/auth/password-parameters", "POST", {"email": MANAGER})
        assert unknown["status"] == known_params["status"] == 200
        assert set(unknown["data"]) == set(known_params["data"]) == {"version", "iterations", "salt"}
        malformed = api("/api/auth/login", "POST", {"email": MANAGER, "credential": {"version": VERSION}})
        assert malformed["status"] in (400, 401)
        wrong = credential("wrong-local-password")
        failures = [api("/api/auth/login", "POST", {"email": "rate-limit@example.invalid", "credential": wrong})["status"] for _ in range(9)]
        assert any(s == 429 for s in failures), failures
        # A manager session remains usable if the account throttle is keyed correctly;
        # if the implementation blocks it, explicitly fail with evidence rather than hide it.
        session_check = api("/api/session")
        assert session_check["status"] == 200, session_check

        # Manager resets every seeded user through the real form, then each user logs in,
        # is denied overview until rotation, rotates via the real form, and logs out.
        for index, user in enumerate(users):
            email, uid = user["email"], user["id"]
            temp = f"Temp-{index:02d}-local-{secrets.token_urlsafe(10)}"
            new = f"New-{index:02d}-local-{secrets.token_urlsafe(10)}"
            passwords[email] = (temp, new)
            page.locator("[data-action='reset-user-password']").filter(has=page.locator("xpath=..")) if False else None
            page.locator("#usersSearch").fill(email)
            row = page.locator("tbody tr").filter(has_text=user["name"])
            row.wait_for(state="visible", timeout=10_000)
            assert row.count() == 1, email
            row.locator("[data-action='reset-user-password']").click()
            page.locator("#userPasswordDialog").wait_for(state="visible")
            page.locator("#temporaryPassword").fill(temp)
            page.locator("#userPasswordSubmit").click()
            page.locator("#userPasswordDialog").wait_for(state="hidden", timeout=20_000)

            logout()
            login(email, temp)
            assert api("/api/overview")["status"] == 403
            page.locator("#currentPassword").fill(temp)
            page.locator("#newPassword").fill(new)
            page.locator("#confirmPassword").fill(new)
            page.locator("#passwordForm button[type='submit']").click()
            page.locator("#passwordForm").wait_for(state="detached", timeout=20_000)
            assert api("/api/overview")["status"] == 200
            assert api("/api/users")["status"] in (403, 404)
            logout()
            login(email, new)
            assert api("/api/overview")["status"] == 200
            logout()
            login(MANAGER, passwords["manager"])
            page.locator("[data-page='users']").first.click()
            page.locator("tbody tr").first.wait_for(timeout=10_000)

        # Reset invalidates an existing user session and cannot be performed by a user.
        target = users[0]
        temp, new = passwords[target["email"]]
        logout()
        login(target["email"], new)
        stale = page.context.cookies()
        logout()
        login(MANAGER, passwords["manager"])
        page.locator("[data-page='users']").first.click()
        page.locator("tbody tr").first.wait_for(timeout=10_000)
        newer = "Reset-again-local-" + secrets.token_urlsafe(12)
        page.locator("#usersSearch").fill(target["email"])
        row = page.locator("tbody tr").filter(has_text=target["name"])
        row.wait_for(state="visible", timeout=10_000)
        row.locator("[data-action='reset-user-password']").click()
        page.locator("#userPasswordDialog").wait_for(state="visible")
        page.locator("#temporaryPassword").fill(newer)
        page.locator("#userPasswordSubmit").click(); page.locator("#userPasswordDialog").wait_for(state="hidden", timeout=20_000)
        # The prior cookie jar was deliberately captured; server-side deletion is checked via a second context.
        old = browser.new_context(); old.add_cookies(stale); oldp = old.new_page(); oldp.goto(BASE, wait_until="networkidle")
        assert oldp.evaluate("fetch('/api/session').then(r=>r.status)") == 401
        old.close(); logout()

        # User cannot reset manager or access manager-only routes; no submissions/cash changed.
        login(target["email"], newer)
        assert api(f"/api/users/{users[-1]['id']}/password", "POST", {"credential": credential(newer)})["status"] in (401, 403)
        assert api("/api/export.csv")["status"] == 404
        assert api("/api/overview")["data"].get("cashBalanceIdr", 0) == 0
        assert api("/api/submissions")["data"].get("total", 0) == 0
        logout()
        browser.close()
    assert not browser_errors, browser_errors
    print("PASSWORD_FLOW_PASS bootstrap=1 manager_rotation=1 users_reset_and_rotated=9 overview403=1 invalidation=1 authorization=1 cash=0 submissions=0")


if __name__ == "__main__":
    main()
