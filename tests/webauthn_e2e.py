from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright
from e2e_local import api, local_d1_rows, local_vars

BASE_URL = os.environ.get("PANGSUMA_LOCAL_URL", "http://localhost:8788")
MANAGER_EMAIL = "rahmat@pangsumafc.com"


def add_virtual_authenticator(context, page):
    cdp = context.new_cdp_session(page)
    cdp.send("WebAuthn.enable")
    result = cdp.send("WebAuthn.addVirtualAuthenticator", {
        "options": {
            "protocol": "ctap2",
            "transport": "internal",
            "hasResidentKey": True,
            "hasUserVerification": True,
            "isUserVerified": True,
            "automaticPresenceSimulation": True,
        }
    })
    return cdp, result["authenticatorId"]


def b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


def b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def begin_assertion(page):
    options = api(page, "/api/passkeys/login/options", "POST", {})
    assert options["status"] == 200, options
    credential = page.evaluate(
        """async options => {
          const toBuffer = value => {
            const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
            const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
            return Uint8Array.from(atob(padded), c => c.charCodeAt(0)).buffer;
          };
          const fromBuffer = value => {
            const bytes = new Uint8Array(value);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
          };
          const publicKey = {...options.publicKey, challenge: toBuffer(options.publicKey.challenge)};
          if (publicKey.allowCredentials) publicKey.allowCredentials = publicKey.allowCredentials.map(item => ({...item, id: toBuffer(item.id)}));
          const result = await navigator.credentials.get({publicKey});
          return {
            id: result.id,
            rawId: fromBuffer(result.rawId),
            type: result.type,
            response: {
              clientDataJSON: fromBuffer(result.response.clientDataJSON),
              authenticatorData: fromBuffer(result.response.authenticatorData),
              signature: fromBuffer(result.response.signature),
              userHandle: result.response.userHandle ? fromBuffer(result.response.userHandle) : null
            }
          };
        }""",
        options["data"],
    )
    return {"challengeId": options["data"]["challengeId"], "credential": credential}


def begin_registration(page, invitation_token: str):
    options = api(page, "/api/passkeys/invitation/options", "POST", {"invitationToken": invitation_token})
    assert options["status"] == 200, options
    credential = page.evaluate(
        """async options => {
          const toBuffer = value => {
            const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
            const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
            return Uint8Array.from(atob(padded), c => c.charCodeAt(0)).buffer;
          };
          const fromBuffer = value => {
            const bytes = new Uint8Array(value);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
          };
          const publicKey = {...options.publicKey, challenge: toBuffer(options.publicKey.challenge)};
          publicKey.user = {...publicKey.user, id: toBuffer(publicKey.user.id)};
          if (publicKey.excludeCredentials) publicKey.excludeCredentials = publicKey.excludeCredentials.map(item => ({...item, id: toBuffer(item.id)}));
          const result = await navigator.credentials.create({publicKey});
          return {
            id: result.id,
            rawId: fromBuffer(result.rawId),
            type: result.type,
            response: {
              clientDataJSON: fromBuffer(result.response.clientDataJSON),
              attestationObject: fromBuffer(result.response.attestationObject)
            }
          };
        }""",
        options["data"],
    )
    return {"challengeId": options["data"]["challengeId"], "credential": credential}


def change_client_data(credential: dict, update):
    client = json.loads(b64decode(credential["response"]["clientDataJSON"]))
    update(client)
    credential["response"]["clientDataJSON"] = b64encode(json.dumps(client, separators=(",", ":")).encode())


def change_authenticator_data(credential: dict, update):
    data = bytearray(b64decode(credential["response"]["authenticatorData"]))
    update(data)
    credential["response"]["authenticatorData"] = b64encode(bytes(data))


def change_signature(credential: dict):
    signature = bytearray(b64decode(credential["response"]["signature"]))
    signature[-1] ^= 1
    credential["response"]["signature"] = b64encode(bytes(signature))


def expect_invalid_assertion(page, label: str, update):
    body = begin_assertion(page)
    update(body["credential"])
    result = api(page, "/api/passkeys/login/verify", "POST", body)
    assert result["status"] == 401, f"{label} should fail with 401, got {result}"


def start_login(page, email: str, password: str):
    page.locator("#loginIdentifier").fill(email)
    page.locator("#loginPassword").fill(password)
    page.locator("#loginSubmit").click()
    page.locator("#loginGate").wait_for(state="hidden", timeout=15_000)


def wait_for_login_controls(page):
    page.locator("#passkeyControls").wait_for(state="visible", timeout=10_000)
    assert page.locator("#passkeyLoginButton").is_enabled()


def issue_invitation_from_ui(page, user):
    row = page.locator("tbody tr").filter(has_text=user["name"])
    row.locator('[data-action="issue-passkey-invitation"]').click()
    page.locator("#passkeyInviteDialog").wait_for(state="visible")
    code = page.locator("#passkeyInviteCode").input_value()
    assert re.fullmatch(r"[A-Za-z0-9_-]{40,80}", code), "invitation must be a high-entropy base64url token"
    assert user["name"] in page.locator("#passkeyInviteDescription").inner_text()
    page.locator("#copyPasskeyInvite").click()
    assert "Kode undangan" in page.locator("#toast").inner_text() or page.locator("#passkeyInviteCode").evaluate("el => el.selectionStart === 0")
    page.get_by_role("button", name="Selesai").click()
    page.locator("#passkeyInviteDialog").wait_for(state="hidden")
    assert page.locator("#passkeyInviteCode").input_value() == "", "closing the dialog must clear the one-time token"
    return code


def sql_update_credential(credential_id: str, expression: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,1400}", credential_id):
        raise AssertionError("unexpected credential ID encoding")
    local_d1_rows(f"UPDATE passkey_credentials SET {expression} WHERE credential_id = '{credential_id}'")


def main():
    secrets = local_vars()
    required = ["LOCAL_MANAGER_PASSWORD", "MANAGER_ENROLLMENT_SECRET"]
    missing = [name for name in required if not secrets.get(name)]
    assert not missing, f"missing local-only values: {', '.join(missing)}"

    browser_errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        manager_context = browser.new_context(viewport={"width": 390, "height": 844})
        manager_context.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE_URL)
        manager_page = manager_context.new_page()
        manager_page.on("pageerror", lambda error: browser_errors.append(str(error)))
        manager_cdp, manager_authenticator = add_virtual_authenticator(manager_context, manager_page)
        manager_page.goto(BASE_URL, wait_until="networkidle")
        wait_for_login_controls(manager_page)

        if not local_d1_rows("SELECT id FROM users LIMIT 1"):
            boot = api(manager_page, "/api/bootstrap", "POST", {"managerPassword": secrets["LOCAL_MANAGER_PASSWORD"]}, {"Authorization": "Bearer " + secrets["BOOTSTRAP_TOKEN"]})
            assert boot["status"] == 201 and boot["data"]["seededUsers"] == 10, boot

        # Password-authenticated Manager sessions cannot create passkey invitations.
        start_login(manager_page, MANAGER_EMAIL, secrets["LOCAL_MANAGER_PASSWORD"])
        session = api(manager_page, "/api/session")
        assert session["status"] == 200 and session["data"]["user"]["authMethod"] == "password", session
        manager_id_rows = local_d1_rows("SELECT id FROM users WHERE email='rahmat@pangsumafc.com' COLLATE NOCASE")
        assert len(manager_id_rows) == 1 and manager_id_rows[0]["id"] == "00000000-0000-4000-8000-000000000002", manager_id_rows
        overview = api(manager_page, "/api/overview")
        users = [user for user in overview["data"]["users"] if user["role"] == "user" and user["active"]]
        assert len(users) >= 2, "synthetic test roster must have two active Users"
        denied_invite = api(manager_page, "/api/passkeys/invitations", "POST", {"userId": users[0]["id"]})
        assert denied_invite["status"] == 403 and denied_invite["data"]["error"]["code"] == "passkey_required", denied_invite
        manager_page.locator('[data-page="users"]:visible').first.click()
        invite_buttons = manager_page.get_by_role("button", name="Buat undangan passkey")
        assert invite_buttons.count() == len(users), "each active User must show a disabled invite control"
        assert all(invite_buttons.nth(index).is_disabled() for index in range(len(users)))
        assert "passkey Manager" in manager_page.locator("main").inner_text()
        manager_page.locator("#logoutButton").click()
        manager_page.locator("body.logged-out").wait_for()

        # A wrong owner recovery code is rejected without exposing the Manager roster.
        wrong_secret = api(manager_page, "/api/passkeys/manager-recovery/options", "POST", {"secret": "x" * 48})
        assert wrong_secret["status"] == 401, wrong_secret
        manager_page.locator(".passkey-details").nth(1).locator("summary").click()
        manager_page.locator("#managerRecoverySecret").fill(secrets["MANAGER_ENROLLMENT_SECRET"])
        manager_page.locator("#managerRecoveryButton").click()
        manager_page.get_by_text("Passkey Manager terdaftar. Masuk dengan passkey untuk melanjutkan.").wait_for(timeout=20_000)
        assert manager_page.locator("#loginGate").is_visible(), "recovery must leave the Manager at the sign-in screen"
        assert api(manager_page, "/api/session")["status"] == 401, "recovery must not create a session"
        assert api(manager_page, "/api/overview")["status"] == 401, "recovery must not reveal the roster or financial overview"
        assert manager_page.locator("#managerRecoverySecret").input_value() == ""
        replay_recovery = api(manager_page, "/api/passkeys/manager-recovery/options", "POST", {"secret": secrets["MANAGER_ENROLLMENT_SECRET"]})
        assert replay_recovery["status"] == 401, replay_recovery

        # Only the ordinary discoverable assertion creates a privileged Manager session.
        manager_page.locator("#passkeyLoginButton").click()
        manager_page.locator("#loginGate").wait_for(state="hidden", timeout=15_000)
        session = api(manager_page, "/api/session")
        assert session["status"] == 200 and session["data"]["user"]["role"] == "manager"
        assert session["data"]["user"]["authMethod"] == "passkey", session

        # Manager can add a second passkey after the first, then use passkey-only invitations.
        manager_page.locator('[data-page="users"]:visible').first.click()
        manager_backup = manager_page.locator('[data-action="register-manager-backup"]')
        assert manager_backup.count() == 1
        manager_backup.click()
        manager_page.get_by_text("Passkey cadangan Manager terdaftar.").wait_for(timeout=15_000)
        manager_rows = local_d1_rows(
            "SELECT COUNT(*) AS count FROM passkey_credentials c JOIN users u ON u.id=c.user_id "
            "WHERE u.email='rahmat@pangsumafc.com' COLLATE NOCASE"
        )
        assert int(manager_rows[0]["count"]) == 2, manager_rows

        # The second enrolled key also supports an ordinary Manager passkey login.
        manager_page.locator("#logoutButton").click()
        manager_page.locator("body.logged-out").wait_for()
        wait_for_login_controls(manager_page)
        manager_page.locator("#passkeyLoginButton").click()
        manager_page.locator("#loginGate").wait_for(state="hidden", timeout=15_000)
        session = api(manager_page, "/api/session")
        assert session["status"] == 200 and session["data"]["user"]["authMethod"] == "passkey", session

        overview = api(manager_page, "/api/overview")
        users = [user for user in overview["data"]["users"] if user["role"] == "user" and user["active"]]
        target, other = users[0], users[1]
        manager_page.locator('[data-page="users"]:visible').first.click()
        invitation_token = issue_invitation_from_ui(manager_page, target)
        other_invite = api(manager_page, "/api/passkeys/invitations", "POST", {"userId": other["id"]})
        assert other_invite["status"] == 201, other_invite
        other_token = other_invite["data"]["invitation"]["token"]

        # Challenges and invitations are bound to one account, and registration origin is exact.
        probe_context = browser.new_context(viewport={"width": 390, "height": 844})
        probe_page = probe_context.new_page()
        probe_page.on("pageerror", lambda error: browser_errors.append(str(error)))
        probe_cdp, probe_authenticator = add_virtual_authenticator(probe_context, probe_page)
        probe_page.goto(BASE_URL, wait_until="networkidle")
        wait_for_login_controls(probe_page)
        cross_bound = begin_registration(probe_page, other_token)
        wrong_account = api(probe_page, "/api/passkeys/invitation/verify", "POST", {
            "invitationToken": invitation_token,
            **cross_bound,
        })
        assert wrong_account["status"] == 401, wrong_account
        wrong_origin_registration = begin_registration(probe_page, invitation_token)
        change_client_data(wrong_origin_registration["credential"], lambda data: data.update(origin="https://attacker.invalid"))
        bad_registration = api(probe_page, "/api/passkeys/invitation/verify", "POST", {
            "invitationToken": invitation_token,
            **wrong_origin_registration,
        })
        assert bad_registration["status"] == 401, bad_registration

        # User registers through the visible invitation form; no password or email OTP is sent.
        user_context = browser.new_context(viewport={"width": 390, "height": 844})
        user_page = user_context.new_page()
        user_page.on("pageerror", lambda error: browser_errors.append(str(error)))
        user_cdp, user_authenticator = add_virtual_authenticator(user_context, user_page)
        user_page.goto(BASE_URL, wait_until="networkidle")
        wait_for_login_controls(user_page)
        assert api(user_page, "/api/passkeys/invitation/options", "POST", {"invitationToken": "not-a-valid-invitation-token"})["status"] == 401
        user_page.locator(".passkey-details").first.locator("summary").click()
        user_page.locator("#invitationToken").fill(invitation_token)
        user_page.locator("#inviteRegisterButton").click()
        user_page.locator("#loginGate").wait_for(state="hidden", timeout=20_000)
        session = api(user_page, "/api/session")
        assert session["status"] == 200 and session["data"]["user"]["id"] == target["id"], session
        assert session["data"]["user"]["role"] == "user" and session["data"]["user"]["authMethod"] == "passkey", session
        assert session["data"]["user"]["mustChangePassword"] is False, session
        registered_rows = local_d1_rows(
            f"SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id='{target['id']}'"
        )
        assert int(registered_rows[0]["count"]) == 1, registered_rows
        assert api(user_page, "/api/passkeys/invitation/options", "POST", {"invitationToken": invitation_token})["status"] == 401

        # UI login is discoverable and account-bound; verify a successful assertion, then replay it.
        user_page.locator("#logoutButton").click()
        user_page.locator("body.logged-out").wait_for()
        wait_for_login_controls(user_page)
        user_page.locator("#passkeyLoginButton").click()
        user_page.locator("#loginGate").wait_for(state="hidden", timeout=15_000)
        session = api(user_page, "/api/session")
        assert session["status"] == 200 and session["data"]["user"]["id"] == target["id"], session

        # Exact origin, RP hash, challenge, signature, UP/UV, userHandle, and backup policy.
        expect_invalid_assertion(manager_page, "wrong client origin", lambda credential: change_client_data(credential, lambda data: data.update(origin="https://attacker.invalid")))
        expect_invalid_assertion(manager_page, "wrong RP ID hash", lambda credential: change_authenticator_data(credential, lambda data: data.__setitem__(0, data[0] ^ 1)))
        expect_invalid_assertion(manager_page, "wrong challenge", lambda credential: change_client_data(credential, lambda data: data.update(challenge="not-the-challenge")))
        expect_invalid_assertion(manager_page, "invalid signature", change_signature)

        expect_invalid_assertion(user_page, "cross-origin client data", lambda credential: change_client_data(credential, lambda data: data.update(crossOrigin=True)))
        expect_invalid_assertion(user_page, "missing user presence", lambda credential: change_authenticator_data(credential, lambda data: data.__setitem__(32, data[32] & ~1)))
        expect_invalid_assertion(user_page, "missing user verification", lambda credential: change_authenticator_data(credential, lambda data: data.__setitem__(32, data[32] & ~4)))
        expect_invalid_assertion(user_page, "backup state without eligibility", lambda credential: change_authenticator_data(credential, lambda data: data.__setitem__(32, (data[32] | 0x10) & ~0x08)))
        expect_invalid_assertion(user_page, "wrong user handle", lambda credential: credential["response"].update(userHandle=b64encode(b"not-the-user-handle")))

        user_credential = begin_assertion(user_page)["credential"]
        credential_id = user_credential["id"]
        sql_update_credential(credential_id, "sign_count=4294967295")
        counter_anomaly = begin_assertion(user_page)
        counter_response = api(user_page, "/api/passkeys/login/verify", "POST", counter_anomaly)
        assert counter_response["status"] == 401, counter_response
        stored_count = local_d1_rows(f"SELECT sign_count FROM passkey_credentials WHERE credential_id='{credential_id}'")
        assert int(stored_count[0]["sign_count"]) == 4294967295, stored_count
        sql_update_credential(credential_id, "sign_count=0")

        sql_update_credential(credential_id, "backup_eligible=1, backup_state=0")
        backup_mismatch = begin_assertion(user_page)
        backup_response = api(user_page, "/api/passkeys/login/verify", "POST", backup_mismatch)
        assert backup_response["status"] == 401, backup_response
        sql_update_credential(credential_id, "backup_eligible=0, backup_state=0")

        # A valid login clears prior failures. Replaying its exact single-use challenge is rejected.
        user_page.locator("#logoutButton").click()
        user_page.locator("body.logged-out").wait_for()
        wait_for_login_controls(user_page)
        user_page.locator("#passkeyLoginButton").click()
        user_page.locator("#loginGate").wait_for(state="hidden", timeout=15_000)
        replay_body = begin_assertion(user_page)
        first_verify = api(user_page, "/api/passkeys/login/verify", "POST", replay_body)
        assert first_verify["status"] == 200, first_verify
        replay_verify = api(user_page, "/api/passkeys/login/verify", "POST", replay_body)
        assert replay_verify["status"] == 401, replay_verify
        api(user_page, "/api/logout", "POST", {})
        user_page.reload(wait_until="networkidle")
        wait_for_login_controls(user_page)

        # Repeated invalid signatures block the credential, even when fresh challenges are requested.
        for index in range(8):
            body = begin_assertion(user_page)
            change_signature(body["credential"])
            result = api(user_page, "/api/passkeys/login/verify", "POST", body)
            assert result["status"] == 401, f"invalid signature {index + 1}: {result}"
        blocked_body = begin_assertion(user_page)
        blocked = api(user_page, "/api/passkeys/login/verify", "POST", blocked_body)
        assert blocked["status"] == 429, blocked

        # Responsive login and all new browser controls remain within the viewport.
        for width in (320, 390):
            user_page.set_viewport_size({"width": width, "height": 844})
            user_page.wait_for_timeout(50)
            dimensions = user_page.evaluate("() => ({viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth})")
            assert dimensions["page"] <= dimensions["viewport"] + 1, f"horizontal overflow at {width}px: {dimensions}"

        assert not browser_errors, f"uncaught browser errors: {browser_errors}"
        for cdp, authenticator in ((manager_cdp, manager_authenticator), (probe_cdp, probe_authenticator), (user_cdp, user_authenticator)):
            try:
                cdp.send("WebAuthn.removeVirtualAuthenticator", {"authenticatorId": authenticator})
                cdp.detach()
            except Exception:
                pass
        browser.close()

    print("WEBAUTHN E2E PASSED")
    print("- UUID-pinned Manager recovery registered a key without issuing a session or exposing overview; secret was one-time, then normal discoverable login and second Manager key passed.")
    print("- Manager-issued account-bound invitations, registration-origin rejection, User passkey registration/login, and one-time invitation use passed.")
    print("- Negative tests passed for wrong origin, RP hash, challenge, signature, cross-origin data, UP/UV, user handle, backup flags, replay, and counter anomalies.")
    print("- Repeated invalid signatures triggered credential throttling; passkey login UI had no horizontal overflow at 320 and 390 px.")
    print("- All users, credentials, secrets, and D1 writes were synthetic and local to the isolated Wrangler test database.")


if __name__ == "__main__":
    main()
