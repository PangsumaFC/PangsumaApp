"""Frontend-only financial workspace regression for the isolated local profile runner."""
from __future__ import annotations
import datetime as dt
import os
import subprocess
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo
from playwright.sync_api import expect, sync_playwright
from profile_flow_e2e import BASE, MANAGER, SCREENSHOTS, api, credential, http, login, rotate_first_login


def finance_insights(page):
    page.locator('[data-page="finance"]:visible').first.click()
    details = page.locator('[data-panel="cash-insights"]')
    if details.get_attribute("open") is None:
        details.locator('summary').first.click()


def main():
    password = os.environ["LOCAL_MANAGER_PASSWORD"]
    status, data, _ = http("/api/bootstrap", {"managerCredential": credential(password)},
                           headers={"Authorization": "Bearer " + os.environ["BOOTSTRAP_TOKEN"]})
    assert status == 201, (status, data)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    errors = []
    today = dt.datetime.now(ZoneInfo("Asia/Jakarta")).date().isoformat()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, timezone_id="Asia/Jakarta")
        ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(BASE + "/") else r.abort())
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        login(page, MANAGER, password)
        rotate_first_login(page, password)
        initial = api(page, "/api/overview")["data"]
        assert initial["cashBalanceIdr"] == 0
        assert not page.locator("#cashMinimumForm").count() or not page.locator("#cashMinimumInput").input_value()

        # The real top-up API is used to establish exactly the known workspace balance.
        top = api(page, "/api/cash/topups", "POST", {"amountIdr": 300000, "note": "Transfer lokal", "confirmed": True},
                  {"Idempotency-Key": str(uuid.uuid4())})
        assert top["status"] == 201, top
        page.evaluate("""async () => { await refreshOverview(); renderApp(); }""")
        expect(page.locator("body")).to_contain_text("300.000")
        finance_insights(page)
        equation = page.locator(".cash-health-equation")
        expect(equation).to_contain_text("300.000")
        assert equation.locator("dd").count() >= 4

        # One form owns type selection; no repeated choice dialog.
        page.locator('[data-page="overview"]:visible').first.click()
        page.locator('[data-action="open-report-choice"]:visible').first.click()
        expect(page.locator("#reportForm")).to_be_visible()
        page.locator("#reportType").select_option("petty_cash")
        form = page.locator("#reportForm")
        expect(form).to_be_visible()
        form.locator('[name="amountIdr"]').fill("1250")
        form.locator('[name="date"]').fill(today)
        form.locator('[name="description"]').fill("Workspace dana latihan")
        form.locator('[name="note"]').fill("Catatan workspace lokal")

        # Offline submit must not discard the draft or disable retry forever.
        ctx.set_offline(True)
        form.locator('[type="submit"]').click()
        expect(form.locator('[name="description"]')).to_have_value("Workspace dana latihan")
        expect(page.locator("#offlineNotice")).to_be_visible()
        expect(form.locator('[type="submit"]')).to_be_enabled()
        ctx.set_offline(False)
        page.reload(wait_until="networkidle")
        page.locator('[data-action="open-report-choice"]:visible').first.click()
        page.locator("#reportType").select_option("petty_cash")
        form = page.locator("#reportForm")
        expect(form.locator('[name="description"]')).to_have_value("Workspace dana latihan")

        # Commit on the server, then lose only the browser response to test idempotent retry.
        seen = []
        def lose_response(route):
            seen.append((route.request.headers.get("idempotency-key"), route.request.post_data_json))
            if len(seen) == 1:
                response = route.fetch()
                assert response.status == 201
                route.abort("failed")
            else:
                route.continue_()
        page.route("**/api/submissions", lose_response)
        form.locator('[type="submit"]').click()
        expect(form.locator('[type="submit"]')).to_be_enabled()
        expect(form).to_be_visible()
        assert seen and seen[0][0]
        before_retry = api(page, "/api/overview")["data"]
        created = [s for s in before_retry["submissions"] if s["description"] == "Workspace dana latihan"]
        assert len(created) == 1 and created[0]["status"] == "approved", created
        assert len([e for e in before_retry["cashLedger"] if e.get("submission_id") == created[0]["id"]]) == 1
        page.unroute("**/api/submissions", lose_response)
        form.locator('[type="submit"]').click()
        form.wait_for(state="detached", timeout=15000)
        after = api(page, "/api/overview")["data"]
        own = [s for s in after["submissions"] if s["description"] == "Workspace dana latihan"]
        assert len(own) == 1 and own[0]["status"] == "approved"
        assert after["cashBalanceIdr"] == 300000 - 1250
        assert len([e for e in after["cashLedger"] if e.get("submission_id") == own[0]["id"]]) == 1
        page.reload(wait_until="networkidle")
        page.locator('[data-action="open-report-choice"]:visible').first.click()
        page.locator("#reportType").select_option("petty_cash")
        expect(page.locator('#reportForm [name="description"]')).to_have_value("")
        page.locator('[data-page="finance"]:visible').first.click()
        region = page.locator("#managerReportsRegion")
        expect(region).to_be_visible()
        region.locator('.report-filter-advanced summary').click()
        region.locator('[name="q"]').fill("Workspace dana latihan")
        region.locator('[name="jenis"]').select_option("petty_cash")
        region.locator('[name="status"]').select_option("approved")
        region.locator('[name="periode"]').select_option("customWIB")
        region.locator('[name="start"]').fill(today)
        region.locator('[name="end"]').fill(today)
        region.locator('[type="submit"]').click()
        row = region.locator(".manager-filtered-results .item-row").filter(has_text="Workspace dana latihan")
        expect(row).to_have_count(1, timeout=15000)
        assert page.locator("#managerPdfFallback,#managerPdfFallbackLink").count() == 0
        href = page.evaluate("() => ManagerReportFilters.pdfUrl()")
        query = parse_qs(urlparse(href).query)
        for key, value in {"q":"Workspace dana latihan", "jenis":"petty_cash", "status":"approved", "periode":"customWIB", "start":today, "end":today}.items():
            assert query.get(key) == [value], (key, query, href)
        with page.expect_download() as dl:
            page.locator('[data-action="download-pdf"]:visible').click()
        pdf = SCREENSHOTS / "filtered-workspace.pdf"
        dl.value.save_as(pdf)
        text = " ".join(subprocess.run(["pdftotext", str(pdf), "-"], check=True, capture_output=True, text=True).stdout.split())
        assert "Workspace dana latihan" in text and today in text and "Total kas keseluruhan" in text
        assert "1" in text

        # Activity dialog is opened twice and must remain a single live dialog with real audit rows.
        detail = row.locator('[data-action="report-detail"]')
        expect(detail).to_have_count(1)
        detail.click()
        dialog = page.locator("#reportActivityDialog")
        expect(dialog).to_be_visible()
        body = dialog.locator("[data-report-activity-body]")
        expect(body).to_contain_text("Disetujui", timeout=15000)
        assert body.locator(".audit-list li").count() >= 2
        body_text = body.inner_text()
        assert "Rahmat" in body_text or "rahmat" in body_text
        assert "WIB" in body_text
        dialog.locator('[data-action="close-dialog"]').click()
        detail.click(); expect(page.locator("#reportActivityDialog")).to_be_visible()
        assert page.locator("#reportActivityDialog").count() == 1
        page.locator('#reportActivityDialog [data-action="close-dialog"]').click()

        # Health threshold is device-only and trend rows expose exact finite totals.
        finance_insights(page)
        health = page.locator(".cash-health-card")
        expect(health).to_be_visible()
        health.locator('[data-action="configure-cash-minimum"]').click()
        page.locator("#cashMinimumInput").fill("500000")
        page.locator("#cashMinimumForm").locator('[type="submit"]').click()
        expect(health).to_contain_text("500.000")
        expect(page.locator(".cash-minimum-status")).to_contain_text("Di bawah batas minimum")
        page.reload(wait_until="networkidle")
        finance_insights(page)
        expect(page.locator("#cashMinimumInput")).to_have_value("500000")
        page.locator("details").filter(has_text="Lihat grafik dan rincian harian").evaluate_all("els => els.forEach(e => e.open = true)")
        for row in page.locator(".cash-daily-table tbody tr").all():
            vals = row.locator("td").all_text_contents()
            assert vals and all("NaN" not in v and "Infinity" not in v for v in vals)
        assert page.locator(".cash-daily-table tbody tr").count() >= 1
        page.screenshot(path=str(SCREENSHOTS / "financial-workspace-390.png"), full_page=True)
        assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
        assert page.locator("button.primary-button:visible").evaluate_all("bs => bs.filter(b => b.getBoundingClientRect().height < 44).length") == 0
        assert page.locator("#loginIdentifier:visible, #loginPassword:visible").count() == 0
        page.screenshot(path=str(SCREENSHOTS / "financial-workspace-final.png"), full_page=True)
        assert not errors, errors
        ctx.close(); browser.close()
    print(f"FINANCIAL_WORKSPACE_E2E_PASS balance=298750 topup=300000 petty_approved=1 debit=1 filtered_rows=1 pdf=1 activity_audit=1 minimum_device_only=1 trend_finite=1 screenshots={SCREENSHOTS}", flush=True)


if __name__ == "__main__":
    main()
