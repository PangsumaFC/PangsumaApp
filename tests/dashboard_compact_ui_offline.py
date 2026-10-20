"""Real-bundle responsive regression for the manager dashboard."""
from __future__ import annotations
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from qa_five_item_pagination_e2e import start
SALDO = 498765432
WIDTHS = (320, 390, 414, 768, 1280)

def main() -> None:
    server = start(); base = f"http://127.0.0.1:{server.server_port}"
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("CHROMIUM", "/usr/bin/chromium"), headless=True, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width":390,"height":844}, service_workers="block")
        blocked = []
        context.route("**/*", lambda r: r.continue_() if r.request.url.startswith(base + "/") else (blocked.append(r.request.url), r.abort()))
        def overview(route):
            response = route.fetch(); payload = response.json(); payload["cashBalanceIdr"] = SALDO
            route.fulfill(response=response, body=json.dumps(payload))
        context.route(base + "/api/overview", overview)
        page = context.new_page()
        try:
            page.goto(base + "/manager", wait_until="networkidle"); page.wait_for_timeout(700)
            expect(page.locator("#appContent")).to_contain_text("Rp 498.765.432")
            expect(page.locator('[data-action="open-cash-topup"]:visible')).to_have_count(1)
            expect(page.locator('[data-action="open-report-choice"]:visible')).to_have_count(1)
            for width in WIDTHS:
                page.set_viewport_size({"width":width,"height":844})
                m = page.evaluate("""() => { const top=document.querySelector('[data-action="open-cash-topup"]'), create=document.querySelector('[data-action="open-report-choice"]'), content=document.querySelector('.balance-panel > div'), balance=document.querySelector('.balance-panel strong'), actionRow=document.querySelector('.manager-action-row'); const r=e=>{const x=e.getBoundingClientRect();return {x:x.x,y:x.y,w:x.width,h:x.height}}; const range=document.createRange(); range.selectNodeContents(top); return {top:r(top),create:r(create),content:r(content),balance:r(balance),actionRow:r(actionRow),labelLines:range.getClientRects().length,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,white:getComputedStyle(top).whiteSpace,same:Math.abs(top.getBoundingClientRect().height-create.getBoundingClientRect().height)<1}; }""")
                assert m["overflow"] <= 1, (width,m); assert m["top"]["h"] >= 44 and m["create"]["h"] >= 44, (width,m); assert m["same"], (width,m)
                assert m["top"]["y"] >= m["balance"]["y"] + m["balance"]["h"], (width,m)
                if width <= 414:
                    assert m["top"]["w"] >= m["content"]["w"]-1 and m["white"] == "nowrap", (width,m)
                    assert m["labelLines"] == 1, (width,m)
                    assert abs(m["create"]["w"] - m["actionRow"]["w"]) <= 1, (width,m)
                    assert abs(m["create"]["x"] - m["actionRow"]["x"]) <= 1, (width,m)
            posts=[]; page.on("request", lambda q: posts.append(q.url) if q.method=="POST" else None)
            page.locator('[data-action="open-cash-topup"]:visible').click(); expect(page.locator("#cashTopupDialog")).to_be_visible()
            page.locator("#cashTopupDialog [data-action=close-dialog]").last.click(); expect(page.locator("#cashTopupDialog")).not_to_be_visible()
            assert not any(u.endswith("/api/cash/topups") for u in posts), posts
            page.set_viewport_size({"width":390,"height":844}); page.locator('[data-page="finance"]:visible').click(); page.wait_for_timeout(800)
            for width in WIDTHS:
                page.set_viewport_size({"width":width,"height":844})
                gap = page.evaluate("""() => { const h=document.querySelector('.finance-page > .page-heading'), r=document.querySelector('.finance-reports-section'), a=document.querySelector('#financialAlertsFinance'); if(!h||!r)return null; return {gap:r.getBoundingClientRect().top-h.getBoundingClientRect().bottom, empty:!a||!a.textContent.trim()}; }""")
                assert gap is not None, "finance heading/reports were not rendered"
                if width <= 414 and gap["empty"]: assert 0 <= gap["gap"] <= 24, (width, gap)
            page.set_viewport_size({"width":390,"height":844})
            page.evaluate("""() => { document.querySelector('#financialAlertsFinance').innerHTML='<p class=\"fc-alert\" role=\"status\">QA alert content</p>'; }""")
            expect(page.locator("#financialAlertsFinance .fc-alert")).to_be_visible(); expect(page.locator("#financialAlertsFinance .fc-alert")).to_contain_text("QA alert content")
            assert page.evaluate("() => document.querySelector('#financialAlertsFinance').getBoundingClientRect().height") > 0
            assert not blocked, blocked
        finally:
            context.close(); browser.close(); server.shutdown(); server.server_close()
    print("DASHBOARD_COMPACT_UI_OFFLINE_PASS real_bundle=1 widths=320,390,414,768,1280 saldo=498765432")
if __name__ == "__main__": main()
