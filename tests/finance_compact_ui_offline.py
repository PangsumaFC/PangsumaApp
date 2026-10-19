"""Offline browser layout regression for the compact Finance workspace.

This intentionally bypasses auth/server APIs: app.js is evaluated in Chromium,
then financePage is rendered with a synthetic manager state and module mocks.
"""
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
APP = (ROOT / "site/app.js").read_text()
CSS = (ROOT / "site/financial-controls.css").read_text()

STATE = """
const s = window.__state;
s.user = {id:'offline-manager', role:'manager'};
s.submissions = [];
s.summary = {};
s.cashLedger = [];
s.cashFlow = {openingConfigured:true};
s.history = {cashLedger:{loaded:0,total:0}};
s.cashInsights = {
  account:{balanceIdr:'300000'},
  accounting:{expectedBalanceIdr:'300000', discrepancyIdr:'0', isBalanced:true},
  totals:{openingIdr:'300000', topupsIdr:'0', outgoingIdr:'0'},
  minimumIdr:'250000',
  trend:{outgoingIdr:'0', precedingOutgoingIdr:'0', window:{start:'2026-01-01',end:'2026-01-30',previousStart:'2025-12-01',previousEnd:'2025-12-31'},days:[]},
  daily:[{day:'2026-01-30',openingIdr:'300000',incomingIdr:'0',outgoingIdr:'0',closingIdr:'300000'}]
};
window.__renderFinance = () => { document.querySelector('#root').innerHTML = window.__financePage(); };
window.__renderFinance();
"""


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.set_content(f'''<style>{CSS}:root{{--line:#dfe4e8;--paper:#fff;--blue-deep:#17334e;--blue:#285b88;--muted:#586878;--green:#256447;--gold-deep:#795b17;--shadow-soft:0 2px 8px rgba(23,51,78,.06)}}*{{box-sizing:border-box}}body{{margin:0;padding:12px;background:#f5f7f9;font:15px system-ui;color:#1b2d3e}}</style><div id="root"></div><script>{APP.replace('initialize();', "globalThis.__financePage = financePage; globalThis.__state = state;")}</script><script>window.FinancialControls={{renderOverview:()=>'',renderFinance:()=>''}};</script><script>{STATE}</script>''')
        for width in (320, 390, 768, 1280):
            page.set_viewport_size({"width": width, "height": 844})
            page.evaluate("window.__renderFinance()")
            measured = page.evaluate("""() => ({
              width: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
              summaryHeight: document.querySelector('.cash-health-card').getBoundingClientRect().height,
              detailHeight: document.querySelector('.cash-trend-details').getBoundingClientRect().height,
              detailsOpen: document.querySelector('.cash-trend-details').open,
              nestedDetails: document.querySelectorAll('.cash-trend-details details').length,
              visibleAccount: getComputedStyle(document.querySelector('.cash-health-status strong')).display !== 'none'
            })""")
            assert measured["scrollWidth"] <= measured["width"] + 1, (width, measured)
            assert measured["summaryHeight"] < 260, (width, measured)
            assert measured["detailHeight"] < 80 and not measured["detailsOpen"], (width, measured)
            assert measured["nestedDetails"] == 0 and measured["visibleAccount"]
            page.locator('.cash-trend-details summary').focus()
            expect(page.locator('.cash-trend-details summary')).to_be_focused()
            page.keyboard.press("Enter")
            expect(page.locator('.cash-trend-details')).to_have_attribute("open", "")
            page.keyboard.press("Enter")
            assert not page.locator('.cash-trend-details').get_attribute("open")
        browser.close()
    print("FINANCE_COMPACT_UI_OFFLINE_PASS widths=320,390,768,1280 compact_summary=1 overflow=0 focus_keyboard=1")


if __name__ == "__main__":
    main()
