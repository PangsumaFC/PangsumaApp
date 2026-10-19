"""Read-only responsive password header regression; no real accounts or APIs."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from qa_five_item_pagination_e2e import start

VIEWPORTS = [(320, 740), (390, 844), (768, 1024), (1280, 900), (1440, 1000), (844, 390), (1024, 768)]

def main():
    server = start()
    base = f'http://127.0.0.1:{server.server_port}'
    output = Path(os.environ.get('QA_OUTPUT', '/tmp/pangsuma-password-header'))
    output.mkdir(parents=True, exist_ok=True)
    records = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
            for role in ('user', 'manager'):
                for width, height in VIEWPORTS:
                    context = browser.new_context(viewport={'width': width, 'height': height}, service_workers='block')
                    forbidden = []
                    def route(r):
                        if not r.request.url.startswith(base + '/') or r.request.method != 'GET':
                            forbidden.append([r.request.method, r.request.url]); r.abort()
                        else:
                            r.continue_()
                    context.route('**/*', route)
                    page = context.new_page()
                    page.goto(base + '/' + role, wait_until='networkidle')
                    button = page.get_by_role('button', name='Ganti kata sandi', exact=True)
                    expect(button).to_have_count(1)
                    expect(button).to_be_visible()
                    expect(button).to_have_attribute('title', 'Ganti kata sandi')
                    metrics = page.evaluate('''() => {
                      const b = document.querySelector('.account-password-button');
                      const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
                      return {button:rect(b),icon:rect(b.querySelector('svg')),header:rect(document.querySelector('.topbar')),
                        controls:[...document.querySelector('.top-actions').children].filter(e=>e.getBoundingClientRect().width).map(rect),
                        brand:rect(document.querySelector('.brand')),scrollWidth:document.documentElement.scrollWidth,text:b.textContent.trim()};
                    }''')
                    b, icon, header = (metrics[k] for k in ('button', 'icon', 'header'))
                    assert b['width'] >= 44 and b['height'] >= 44, metrics
                    assert not metrics['text'], metrics
                    assert metrics['scrollWidth'] <= width, metrics
                    assert 0 <= b['left'] and b['right'] <= width, metrics
                    assert header['top'] <= b['top'] and b['bottom'] <= header['bottom'], metrics
                    assert abs((icon['left'] + icon['right']) - (b['left'] + b['right'])) < 1, metrics
                    assert abs((icon['top'] + icon['bottom']) - (b['top'] + b['bottom'])) < 1, metrics
                    controls = [metrics['brand']] + metrics['controls']
                    for left, right in zip(controls, controls[1:]):
                        assert left['right'] <= right['left'] + 0.5, metrics
                    # Reach the native button with keyboard Tab, not programmatic focus.
                    for _ in range(20):
                        page.keyboard.press('Tab')
                        if button.evaluate('(e) => e === document.activeElement'): break
                    assert button.evaluate('(e) => e === document.activeElement'), 'not keyboard reachable'
                    focus = button.evaluate('(e) => ({visible:e.matches(":focus-visible"),width:getComputedStyle(e).outlineWidth,style:getComputedStyle(e).outlineStyle})')
                    assert focus['visible'] and focus['style'] != 'none' and float(focus['width'].removesuffix('px')) >= 2, focus
                    for key in ('Enter', 'Space'):
                        if key == 'Space':
                            page.evaluate("navigateToPage('overview')")
                            button.focus()
                        page.keyboard.press(key)
                        expect(page.get_by_role('heading', name='Ganti kata sandi', exact=True)).to_be_visible()
                        assert page.evaluate('currentPage') == 'change-password'
                    page.evaluate("navigateToPage('overview')")
                    button.click()
                    assert page.evaluate('currentPage') == 'change-password'
                    if width in (390, 768, 1440):
                        page.screenshot(path=str(output / f'{role}-password-{width}.png'))
                    assert not forbidden, forbidden
                    records.append({'role':role,'viewport':[width,height],'metrics':metrics,'focus':focus})
                    print('PASS', role, f'{width}x{height}', 'geometry/name/44px/Tab/focus/Enter/Space/click', flush=True)
                    context.close()
            browser.close()
    finally:
        server.shutdown(); server.server_close()
    (output / 'metrics.json').write_text(json.dumps(records, indent=2))
    print('PASSWORD_HEADER_PASS', len(records), 'read-only viewport/role cases', flush=True)

if __name__ == '__main__': main()
