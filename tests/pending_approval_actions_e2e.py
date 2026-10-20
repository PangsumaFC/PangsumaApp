"""Read-only browser regression: 16 pending items outside five recent rows.
Every request is restricted to the loopback fixture; final approval/rejection
buttons are never pressed and all mutation requests fail the test.
"""
import os
from playwright.sync_api import sync_playwright, expect
import qa_five_item_pagination_e2e as fixture


def main():
    fixture.SUBMISSIONS = [fixture.item(i, status="approved") for i in range(101, 106)]
    fixture.PENDING = [fixture.item(i, "finance_request" if i % 2 else "petty_cash", "pending", f"qa-user-{i}") for i in range(1, 17)]
    assert not ({x["id"] for x in fixture.SUBMISSIONS} & {x["id"] for x in fixture.PENDING})
    server = fixture.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=os.environ.get("CHROMIUM", "/usr/bin/chromium"), headless=True, args=["--no-sandbox"])
            try:
                for width in (320, 390, 768, 1280):
                    context = browser.new_context(viewport={"width": width, "height": 900}, service_workers="block")
                    mutations, external = [], []
                    def route(r):
                        if not r.request.url.startswith(base + "/"):
                            external.append(r.request.url); r.abort()
                        elif r.request.method not in ("GET", "HEAD"):
                            mutations.append(r.request.url); r.abort()
                        else:
                            r.continue_()
                    context.route("**/*", route)
                    page = context.new_page()
                    page.goto(base + "/manager", wait_until="networkidle")
                    page.locator('.nav-button[data-page="approvals"]:visible').click()
                    visited = []
                    for start in range(0, 16, 5):
                        rows = fixture.PENDING[start:start + 5]
                        for row in rows:
                            item_id = row["id"]
                            approve = page.locator(f'[data-action="approve"][data-id="{item_id}"]')
                            expect(approve).to_be_visible()
                            approve.click()
                            dialog = page.locator('#confirmDialog')
                            expect(dialog).to_be_visible()
                            expect(dialog.locator('#confirmDescription')).to_contain_text(row['description'])
                            expect(dialog.locator('#confirmSubmit')).to_have_text('Setujui & kurangi saldo' if row['type'] == 'petty_cash' else 'Setujui pengajuan')
                            dialog.get_by_role('button', name='Batal', exact=True).click()
                            expect(dialog).not_to_be_visible()
                            page.locator(f'[data-action="reject"][data-id="{item_id}"]').click()
                            reject = page.locator('#rejectDialog')
                            expect(reject).to_be_visible()
                            expect(reject.locator('#rejectDescription')).to_contain_text(row['description'])
                            expect(reject.locator('#rejectReason')).to_have_value('')
                            expect(reject.locator('#rejectReason')).to_be_focused()
                            reject.get_by_role('button', name='Kembali', exact=True).click()
                            expect(reject).not_to_be_visible()
                            visited.append(item_id)
                        if start + 5 < 16:
                            page.locator('[data-action="pending-next"]:visible').click()
                    assert len(visited) == len(set(visited)) == 16
                    assert not mutations, mutations
                    assert not external, external
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                    print(f'PASS pending dialogs width={width} items=16 approve=16 reject=16 mutations=0', flush=True)
                    context.close()
            finally:
                browser.close()
    finally:
        server.shutdown(); server.server_close()
    print('PENDING_APPROVAL_ACTIONS_E2E_PASS widths=320,390,768,1280 dialog_checks=128 mutations=0')


if __name__ == '__main__':
    main()
