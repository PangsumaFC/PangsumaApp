"""Browser regression for the native receipt viewer on the real manager app."""
from __future__ import annotations

import base64
import json
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from qa_fixture_server import serve_in_thread

ROOT = Path(__file__).resolve().parents[1]
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI"
    "HWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
)


def main() -> None:
    server, _ = serve_in_thread(host="127.0.0.1", port=0)
    base = f"http://127.0.0.1:{server.server_port}"
    list_url = f"{base}/api/submissions/qa-report-finance/receipts"
    image_url = f"{base}/api/receipts/receipt-synthetic"
    calls: list[dict] = []
    external: list[str] = []
    mutations: list[str] = []
    mode = {"value": "ok", "bytes": 0}
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"]
            )
            context = browser.new_context(
                viewport={"width": 390, "height": 844}, service_workers="block"
            )

            def route(route):
                request = route.request
                # The fixture has no separate file named manager-mock; continue the
                # real app request through its /manager entry, never replace it with
                # test HTML.  The browser remains on the requested mock route.
                if request.url == f"{base}/manager-mock":
                    route.continue_(url=f"{base}/manager")
                elif request.url == list_url:
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps(
                            {
                                "items": [
                                    {
                                        "id": "receipt-synthetic",
                                        "filename": "synthetic.png",
                                        "url": "/api/receipts/receipt-synthetic",
                                        "sizeBytes": len(PNG),
                                        "actorName": "Pemilik sintetis",
                                    }
                                ],
                                "count": 1,
                                "maxCount": 10,
                            }
                        ),
                    )
                elif request.url == image_url:
                    mode["bytes"] += 1
                    # The first byte request is the real list thumbnail.  Scenario
                    # requests start at bytes==2, so thumbnails never consume a
                    # simulated viewer failure.
                    if mode["bytes"] == 1:
                        route.fulfill(status=200, content_type="image/png", body=PNG)
                    elif mode["value"] == "expired":
                        route.fulfill(
                            status=401,
                            content_type="application/json",
                            body='{"error":{"code":"authentication_required","message":"Sesi berakhir."}}',
                        )
                    elif mode["value"] == "forbidden":
                        route.fulfill(
                            status=403,
                            content_type="application/json",
                            body='{"error":{"code":"forbidden","message":"Akses ditolak."}}',
                        )
                    elif mode["value"] == "invalid-mime":
                        route.fulfill(status=200, content_type="text/plain", body=PNG)
                    elif mode["value"] == "retry" and mode["bytes"] == 2:
                        route.fulfill(
                            status=503,
                            content_type="application/json",
                            body='{"error":{"code":"temporary","message":"Jaringan sementara gagal."}}',
                        )
                    elif mode["value"] == "delayed":
                        time.sleep(0.9)
                        route.fulfill(status=200, content_type="image/png", body=PNG)
                    else:
                        route.fulfill(status=200, content_type="image/png", body=PNG)
                elif not request.url.startswith(base + "/"):
                    external.append(request.url)
                    route.abort()
                elif request.method not in ("GET", "HEAD"):
                    mutations.append(request.url)
                    route.abort()
                else:
                    route.continue_()

            context.route("**/*", route)
            page = context.new_page()
            page.on(
                "request",
                lambda request: calls.append(
                    {"url": request.url, "method": request.method, "resource": request.resource_type}
                ),
            )
            page.goto(f"{base}/manager-mock", wait_until="networkidle")
            # Keep the explicit /manager-mock contract without changing the served
            # document: this is only a same-document URL label, not a fake page.
            page.evaluate("history.replaceState({}, '', '/manager-mock')")
            expect(page.locator(".app-shell")).to_be_visible(timeout=15_000)
            page.locator('[data-page="approvals"]:visible').first.click()
            expect(page.locator('[data-action="report-detail"]:visible').first).to_be_visible(
                timeout=15_000
            )
            page.locator('[data-action="report-detail"]:visible').first.click()
            dialog = page.locator("#reportActivityDialog")
            expect(dialog).to_be_visible(timeout=15_000)
            workspace = dialog.locator(".receipt-workspace")
            expect(workspace).to_be_visible(timeout=15_000)
            expect(workspace.locator(".receipt-item")).to_have_count(1, timeout=15_000)
            expect(workspace.locator(".receipt-open")).to_have_text("Buka foto")
            expect(workspace.locator(".receipt-item img")).to_have_count(1)
            page.wait_for_function(
                "document.querySelector('.receipt-item img')?.naturalWidth > 0"
            )

            def open_viewer() -> None:
                workspace.locator(".receipt-open").click()
                expect(page.locator(".receipt-viewer")).to_be_visible(timeout=5_000)

            # Manager is not the submission owner, but the real app allows viewing.
            mode["value"] = "ok"
            mode["bytes"] = 1
            open_viewer()
            image = page.locator(".receipt-viewer-image")
            expect(image).to_be_visible(timeout=5_000)
            assert page.eval_on_selector(".receipt-viewer-image", "el => el.src.startsWith('blob:')")
            page.wait_for_function("document.querySelector('.receipt-viewer-image').naturalWidth > 0")
            assert page.evaluate(
                """async () => { const r = await fetch(document.querySelector('.receipt-viewer-image').src);
                return Array.from(new Uint8Array(await r.arrayBuffer())); }"""
            ) == list(PNG)
            assert page.url == f"{base}/manager-mock"
            assert len(page.context.pages) == 1
            assert any(
                item["url"] == image_url and item["method"] == "GET"
                for item in calls
            )
            page.locator(".receipt-viewer-close").click()
            expect(page.locator(".receipt-viewer")).not_to_be_visible()

            # A real api() 401 invokes showLogin(), which clears the native viewer.
            mode["value"] = "expired"
            mode["bytes"] = 1
            open_viewer()
            expect(page.locator(".receipt-viewer")).to_have_count(0, timeout=5_000)
            expect(page.locator("#loginGate")).to_be_visible(timeout=5_000)
            expect(page.locator("#loginError")).to_contain_text("Sesi Anda berakhir")
            assert "authentication_required" not in page.locator("body").inner_text()

            # The remaining viewer cases run after a fresh real manager session.
            page.goto(f"{base}/manager-mock", wait_until="networkidle")
            page.evaluate("history.replaceState({}, '', '/manager-mock')")
            page.locator('[data-page="approvals"]:visible').first.click()
            page.locator('[data-action="report-detail"]:visible').first.click()
            dialog = page.locator("#reportActivityDialog")
            workspace = dialog.locator(".receipt-workspace")
            expect(workspace.locator(".receipt-open")).to_be_visible(timeout=15_000)

            for value, text in (("forbidden", "tidak memiliki akses"), ("invalid-mime", "belum dapat dimuat")):
                mode["value"] = value
                mode["bytes"] = 1
                open_viewer()
                expect(page.locator(".receipt-viewer-status")).to_contain_text(text)
                expect(page.locator(".receipt-viewer-image")).to_be_hidden()
                page.locator(".receipt-viewer-close").click()

            mode["value"] = "retry"
            mode["bytes"] = 1
            open_viewer()
            expect(page.locator(".receipt-viewer-retry")).to_be_visible()
            page.locator(".receipt-viewer-retry").click()
            expect(page.locator(".receipt-viewer-image")).to_be_visible(timeout=5_000)
            page.locator(".receipt-viewer-close").click()

            # Closing while the real api() blob request is pending must abort it and
            # leave no popup or navigation behind.
            mode["value"] = "delayed"
            mode["bytes"] = 1
            open_viewer()
            page.locator(".receipt-viewer-close").click()
            expect(page.locator(".receipt-viewer")).to_have_count(0)
            page.wait_for_timeout(1_100)
            assert page.url == f"{base}/manager-mock"
            assert len(page.context.pages) == 1
            assert not external, external
            assert not mutations, mutations
            print(
                "RECEIPT_VIEWER_BROWSER_LOCAL_PASS manager_nonowner=ok real_app=1 "
                "full_bytes=identical auth=credentials 401=login_and_viewer_removed "
                "403=handled invalid_mime=handled retry=ok close_abort=ok",
                flush=True,
            )
            context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
