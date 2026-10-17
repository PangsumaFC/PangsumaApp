from __future__ import annotations

import json
from playwright.sync_api import sync_playwright

from e2e_local import api, local_d1_rows, local_vars
from webauthn_e2e import (
    BASE_URL,
    MANAGER_EMAIL,
    add_virtual_authenticator,
    begin_assertion,
    change_authenticator_data,
    change_client_data,
    change_signature,
    wait_for_login_controls,
)

MANAGER_ID = "00000000-0000-4000-8000-000000000002"


def begin_registration(page, options):
    credential = page.evaluate(
        """async options => {
          const b = value => { const n=value.replace(/-/g,'+').replace(/_/g,'/');
            return Uint8Array.from(atob(n+'='.repeat((4-n.length%4)%4)), c=>c.charCodeAt(0)).buffer; };
          const e = value => { const a=new Uint8Array(value); let s='';
            for(let i=0;i<a.length;i+=0x8000)s+=String.fromCharCode(...a.subarray(i,i+0x8000));
            return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/g,''); };
          const key={...options.publicKey,challenge:b(options.publicKey.challenge)};
          key.user={...key.user,id:b(key.user.id)};
          if(key.excludeCredentials) key.excludeCredentials=key.excludeCredentials.map(x=>({...x,id:b(x.id)}));
          const r=await navigator.credentials.create({publicKey:key});
          return {id:r.id,rawId:e(r.rawId),type:r.type,response:{clientDataJSON:e(r.response.clientDataJSON),attestationObject:e(r.response.attestationObject)}};
        }""",
        options["data"],
    )
    return {"challengeId": options["data"]["challengeId"], "credential": credential}


def recovery_options(page, secret):
    return api(page, "/api/passkeys/manager-recovery/options", "POST", {"secret": secret})


def recovery_verify(page, secret, body):
    return api(page, "/api/passkeys/manager-recovery/verify", "POST", {"secret": secret, **body})


def count(sql):
    rows = local_d1_rows(sql)
    return int(rows[0]["count"]) if rows else 0


def main():
    secrets = local_vars()
    required = ["BOOTSTRAP_TOKEN", "LOCAL_MANAGER_PASSWORD", "MANAGER_ENROLLMENT_SECRET"]
    missing = [key for key in required if not secrets.get(key)]
    assert not missing, f"missing local-only variables: {', '.join(missing)}"
    diagnostics = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        cdp, authenticator = add_virtual_authenticator(context, page)
        page.on("pageerror", lambda error: diagnostics.append({"browserError": str(error)}))
        page.goto(BASE_URL, wait_until="networkidle")
        wait_for_login_controls(page)

        boot = api(page, "/api/bootstrap", "POST", {"managerPassword": secrets["LOCAL_MANAGER_PASSWORD"]},
                   {"Authorization": "Bearer " + secrets["BOOTSTRAP_TOKEN"]})
        assert boot["status"] in (201, 409), boot

        # Deferred invitation/second-key UI is absent while signed out.
        deferred = "#passkeyInviteDialog, #invitationForm, #managerRegistrationForm, [data-action='issue-passkey-invitation'], [data-action='register-manager-backup']"
        assert page.locator(deferred).count() == 0
        assert api(page, "/api/session")["status"] == 401

        # All deferred routes are 404, including malformed bodies, with no DB side effects.
        before = (count("SELECT COUNT(*) AS count FROM passkey_invitations"),
                  count("SELECT COUNT(*) AS count FROM passkey_credentials"),
                  count("SELECT COUNT(*) AS count FROM audit_events"))
        rejected = [
            "/api/passkeys/invitations",
            "/api/passkeys/invitation/options",
            "/api/passkeys/invitation/verify",
            "/api/passkeys/manager-registration/options",
            "/api/passkeys/manager-registration/verify",
        ]
        for path in rejected:
            result = api(page, path, "POST", {})
            assert result["status"] == 404, (path, result)
        after = (count("SELECT COUNT(*) AS count FROM passkey_invitations"),
                 count("SELECT COUNT(*) AS count FROM passkey_credentials"),
                 count("SELECT COUNT(*) AS count FROM audit_events"))
        assert after == before, (before, after)

        secret = secrets["MANAGER_ENROLLMENT_SECRET"]
        wrong_before = count("SELECT COUNT(*) AS count FROM passkey_manager_recovery")
        assert recovery_options(page, "wrong-secret-" + "x" * 40)["status"] == 401
        assert count("SELECT COUNT(*) AS count FROM passkey_manager_recovery") == wrong_before

        # A consumed grant stays closed even with no credential, and identity must stay pinned.
        local_d1_rows(f"INSERT INTO passkey_manager_recovery (user_id, secret_hash, created_at_ms, expires_at_ms, consumed_at_ms) VALUES ('{MANAGER_ID}', '{'0' * 64}', 0, 1, 1)")
        assert recovery_options(page, secret)["status"] == 401
        assert local_d1_rows(f"SELECT consumed_at_ms FROM passkey_manager_recovery WHERE user_id='{MANAGER_ID}'")[0]["consumed_at_ms"] == 1
        local_d1_rows(f"DELETE FROM passkey_manager_recovery WHERE user_id='{MANAGER_ID}'")
        for field, value, restore in [("is_active", "0", "1"), ("role", "'user'", "'manager'"), ("email", "'wrong@example.invalid'", "'rahmat@pangsumafc.com'")]:
            local_d1_rows(f"UPDATE users SET {field}={value} WHERE id='{MANAGER_ID}'")
            assert recovery_options(page, secret)["status"] == 401, field
            assert count("SELECT COUNT(*) AS count FROM passkey_manager_recovery") == 0
            local_d1_rows(f"UPDATE users SET {field}={restore} WHERE id='{MANAGER_ID}'")

        # Keep an old challenge, expire its grant, then reissue: old challenge must fail.
        old = recovery_options(page, secret)
        assert old["status"] == 200, old
        old_created = local_d1_rows(f"SELECT created_at_ms FROM passkey_manager_recovery WHERE user_id='{MANAGER_ID}'")[0]["created_at_ms"]
        old_body = begin_registration(page, old)
        # Keep the row structurally valid while making it expired (the schema requires expires_at_ms > created_at_ms).
        local_d1_rows("UPDATE passkey_manager_recovery SET created_at_ms=0, expires_at_ms=1 WHERE user_id='" + MANAGER_ID + "'")
        assert recovery_options(page, "wrong-secret-" + "x" * 40)["status"] == 401
        assert local_d1_rows(f"SELECT expires_at_ms FROM passkey_manager_recovery WHERE user_id='{MANAGER_ID}'")[0]["expires_at_ms"] == 1
        reissued = recovery_options(page, secret)
        assert reissued["status"] == 200, reissued
        new_created = local_d1_rows(f"SELECT created_at_ms FROM passkey_manager_recovery WHERE user_id='{MANAGER_ID}'")[0]["created_at_ms"]
        assert int(new_created) > int(old_created), (old_created, new_created)
        stale = recovery_verify(page, secret, old_body)
        assert stale["status"] == 401, stale

        # Active grants do not extend their lifetime; the real Manager UI can finish after retry.
        snapshot = local_d1_rows(f"SELECT * FROM passkey_manager_recovery WHERE user_id='{MANAGER_ID}'")[0]
        assert recovery_options(page, secret)["status"] == 200
        assert local_d1_rows(f"SELECT * FROM passkey_manager_recovery WHERE user_id='{MANAGER_ID}'")[0] == snapshot
        cdp.send("WebAuthn.removeCredential", {"authenticatorId": authenticator, "credentialId": old_body["credential"]["rawId"].replace("-", "+").replace("_", "/") + "=" * ((4 - len(old_body["credential"]["rawId"]) % 4) % 4)})
        page.locator(".passkey-details summary").click()
        page.locator("#managerRecoverySecret").fill(secret)
        page.locator("#managerRecoveryButton").click()
        page.locator("#passkeyEnrollmentStatus").wait_for(state="visible", timeout=15000)
        assert "Passkey Manager terdaftar" in page.locator("#passkeyEnrollmentStatus").inner_text()
        assert api(page, "/api/session")["status"] == 401
        assert api(page, "/api/overview")["status"] == 401
        assert count("SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id='" + MANAGER_ID + "'") == 1
        grant = local_d1_rows("SELECT consumed_at_ms FROM passkey_manager_recovery WHERE user_id='" + MANAGER_ID + "'")[0]
        assert grant["consumed_at_ms"] is not None, grant

        # Consumed grant and existing credential block any further issuance, without mutation.
        consumed_snapshot = local_d1_rows("SELECT created_at_ms, expires_at_ms, consumed_at_ms FROM passkey_manager_recovery WHERE user_id='" + MANAGER_ID + "'")[0]
        assert recovery_options(page, secret)["status"] == 401
        assert local_d1_rows("SELECT created_at_ms, expires_at_ms, consumed_at_ms FROM passkey_manager_recovery WHERE user_id='" + MANAGER_ID + "'")[0] == consumed_snapshot
        existing_before = count("SELECT COUNT(*) AS count FROM passkey_credentials")
        assert recovery_verify(page, secret, old_body)["status"] == 401
        local_d1_rows(f"UPDATE passkey_manager_recovery SET consumed_at_ms=NULL, created_at_ms=0, expires_at_ms=1 WHERE user_id='{MANAGER_ID}'")
        assert recovery_options(page, secret)["status"] == 401, "existing credential must block even an expired unconsumed grant"
        local_d1_rows(f"UPDATE passkey_manager_recovery SET created_at_ms={consumed_snapshot['created_at_ms']}, expires_at_ms={consumed_snapshot['expires_at_ms']}, consumed_at_ms={consumed_snapshot['consumed_at_ms']} WHERE user_id='{MANAGER_ID}'")
        assert count("SELECT COUNT(*) AS count FROM passkey_credentials") == existing_before

        # Manager passkey login remains the sole route to privileged access; rejected routes stay 404.
        page.locator("#passkeyLoginButton").click()
        page.locator("#loginGate").wait_for(state="hidden", timeout=15_000)
        session = api(page, "/api/session")
        assert session["status"] == 200 and session["data"]["user"]["id"] == MANAGER_ID and session["data"]["user"]["role"] == "manager", session
        assert session["data"]["user"]["authMethod"] == "passkey"
        assert api(page, "/api/overview")["status"] == 200
        session_cookies = [cookie for cookie in context.cookies() if cookie.get("httpOnly")]
        assert session_cookies and all(cookie["sameSite"] == "Strict" for cookie in session_cookies)
        for path in rejected:
            assert api(page, path, "POST", {})["status"] == 404
        page.locator("[data-page='users']:visible").first.click()
        page.locator("tbody").wait_for()
        assert page.locator("[data-action='issue-passkey-invitation'], [data-action='register-manager-backup']").count() == 0
        assert page.locator("[data-action='reset-user-password']").count() >= 1
        assert page.locator("[data-action='deactivate-user']").count() >= 1
        assert page.locator("#userForm button[type='submit']").count() == 1

        # Existing assertion hardening remains covered after the new lifecycle path.
        for label, mutate in [
            ("origin", lambda c: change_client_data(c, lambda d: d.update(origin="https://attacker.invalid"))),
            ("RP hash", lambda c: change_authenticator_data(c, lambda d: d.__setitem__(0, d[0] ^ 1))),
            ("signature", change_signature),
            ("UP", lambda c: change_authenticator_data(c, lambda d: d.__setitem__(32, d[32] & ~1))),
            ("UV", lambda c: change_authenticator_data(c, lambda d: d.__setitem__(32, d[32] & ~4))),
            ("backup flags", lambda c: change_authenticator_data(c, lambda d: d.__setitem__(32, (d[32] | 0x10) & ~8))),
            ("challenge", lambda c: change_client_data(c, lambda d: d.update(challenge="not-the-challenge"))),
        ]:
            body = begin_assertion(page)
            mutate(body["credential"])
            assert api(page, "/api/passkeys/login/verify", "POST", body)["status"] == 401, label
            assert api(page, "/api/passkeys/login/verify", "POST", begin_assertion(page))["status"] == 200
        replay = begin_assertion(page)
        assert api(page, "/api/passkeys/login/verify", "POST", replay)["status"] == 200
        assert api(page, "/api/passkeys/login/verify", "POST", replay)["status"] == 401
        assert api(page, "/api/logout", "POST", {})["status"] == 200
        assert api(page, "/api/session")["status"] == 401
        page.reload(wait_until="networkidle")
        wait_for_login_controls(page)
        page.locator("#passkeyLoginButton").click()
        page.locator("#loginGate").wait_for(state="hidden", timeout=15000)
        for _ in range(8):
            body = begin_assertion(page)
            change_signature(body["credential"])
            assert api(page, "/api/passkeys/login/verify", "POST", body)["status"] == 401
        assert api(page, "/api/passkeys/login/verify", "POST", begin_assertion(page))["status"] == 429
        assert not diagnostics, diagnostics
        print("PASS: deferred 404/no-side-effects, expired recovery reissue invalidates stale challenge, atomic one-time enrollment, consumed/existing-credential blocking, UI controls, and hardened login", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
