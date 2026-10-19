"""Offline Chromium regression for the actual Manager pagination module and CSS."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CSS_FILES = ['pangsuma-theme.css', 'financial-controls.css', 'report-evidence.css', 'mobile-polish.css', 'pwa-files.css']

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/opt/google/chrome/chrome', headless=True, args=['--no-sandbox'])
    for width in [320, 390, 768, 1280]:
        page = browser.new_page(viewport={'width': width, 'height': 1000})
        page.route('**/*', lambda route: route.abort())
        styles = '\n'.join((ROOT / 'site' / name).read_text() for name in CSS_FILES)
        page.set_content('<!doctype html><html lang="id"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + styles + '</style><body><main style="max-width:1100px;margin:0 auto;padding:16px;min-width:0"><div id="testRoot"></div></main></body></html>')
        page.add_script_tag(content=(ROOT / 'site/report-filters.js').read_text())
        page.evaluate('''() => {
          window.calls = []; window.loadingDelay = 0;
          window.role = 'manager';
          ManagerReportFilters.configure({
            getUser: () => ({ id:'synthetic-manager', role:window.role }),
            api: async path => { calls.push(path); await new Promise(r => setTimeout(r, loadingDelay)); return { items:[], total:15, hasMore:true, hasPrevious:true, nextCursor:'next-synthetic', previousCursor:'prev-synthetic' }; },
            renderCard: () => '',
            onChange: () => { document.querySelector('#testRoot').innerHTML = ManagerReportFilters.render(); }
          });
          document.querySelector('#testRoot').innerHTML = ManagerReportFilters.render();
        }''')
        page.wait_for_function("document.querySelectorAll('.report-pagination button').length === 3 && !document.querySelector('.report-pagination button:disabled')")
        geometry = page.evaluate('''() => {
          const buttons = [...document.querySelectorAll('.report-pagination button')];
          return { viewport:innerWidth, scroll:document.documentElement.scrollWidth,
            buttons:buttons.map(b => { const r=b.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,label:b.getAttribute('aria-label') }; }) };
        }''')
        assert geometry['scroll'] <= width, geometry
        buttons = geometry['buttons']
        assert len(buttons) == 3
        assert all(b['x'] >= 0 and b['right'] <= width and b['height'] >= 44 and b['width'] > 0 and b['label'] for b in buttons), geometry
        assert max(b['height'] for b in buttons) - min(b['height'] for b in buttons) < 1, geometry
        assert buttons[1]['x'] - buttons[0]['right'] >= 7.5, geometry
        if width <= 480:
            assert abs(buttons[0]['y'] - buttons[1]['y']) < 1, geometry
            assert buttons[2]['y'] - buttons[0]['bottom'] >= 9.5, geometry
            assert abs(buttons[2]['width'] - (buttons[1]['right'] - buttons[0]['x'])) < 1, geometry
        for action, cursor in [('before', 'prev-synthetic'), ('after', 'next-synthetic'), ('reset-page', None)]:
            page.evaluate('window.loadingDelay = 100')
            selector = f'[data-manager-report-action="{action}"]'
            page.locator(selector).focus()
            page.keyboard.press('Tab')
            page.locator(selector).focus()
            focused = page.locator(selector).evaluate('(b) => ({focused:document.activeElement===b, outline:getComputedStyle(b).outlineStyle})')
            assert focused['focused'] and focused['outline'] != 'none', focused
            page.keyboard.press('Enter')
            page.wait_for_function("document.querySelectorAll('.report-pagination button:disabled').length === 3")
            assert page.locator('.report-pagination button').count() == 3
            page.wait_for_function("!document.querySelector('.report-pagination button:disabled')")
            call = page.evaluate('calls.at(-1)')
            assert ('cursor=' + cursor) in call if cursor else 'cursor=' not in call, call
        page.evaluate("window.role='user'; document.querySelector('#testRoot').innerHTML=ManagerReportFilters.render()")
        assert page.locator('.report-pagination').count() == 0
        print(json.dumps({'width': width, 'overflow': False, 'buttonHeights': [b['height'] for b in buttons], 'keyboardAndRouting': 'passed', 'managerOnly': 'passed'}), flush=True)
        page.close()
    browser.close()
