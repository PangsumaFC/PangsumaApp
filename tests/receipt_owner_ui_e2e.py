"""Browser module regression with synthetic in-memory evidence; never contacts production."""
from pathlib import Path
import base64
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = Path('/workspace/pangsuma-pdf-main-fix-evidence/receipt-ui')
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        for standalone in (False, True):
            for role in ('manager', 'user'):
                context = browser.new_context(viewport={'width': 390, 'height': 844})
                if standalone:
                    context.add_init_script('const mm=window.matchMedia.bind(window);window.matchMedia=q=>q==="(display-mode: standalone)"?{matches:true,addEventListener(){},removeEventListener(){}}:mm(q);')
                def route_handler(route):
                    if route.request.url.endswith('/api/receipts/receipt-user'):
                        route.fulfill(status=200, content_type='image/png', body=PNG)
                    else:
                        route.fulfill(status=200, content_type='text/html', body='<main id="evidence"></main>')
                context.route('**/*', route_handler)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto('https://local.test/')
                page.add_script_tag(path=str(ROOT / 'site/report-evidence.js'))
                page.evaluate('''role => {
                  window.__uploads = 0;
                  ReportEvidence.configure({getUser:()=>({id:role==='manager'?'manager-1':'user-a',role}),newKey:()=> 'local-upload-key',api:async(path, options={})=>{
                    if(options.method==='POST'){window.__uploads++;return {ok:true};}
                    return {items:[{id:'receipt-user',filename:'nota-user.png',url:'/api/receipts/receipt-user',sizeBytes:67,actorName:'User pemilik'}],count:1,maxCount:10};
                  }});
                  ReportEvidence.mountReceipts(document.querySelector('#evidence'),{id:'submission-user',createdById:'user-a'});
                }''', role)
                expect(page.locator('.receipt-item')).to_have_count(1)
                expect(page.locator('.receipt-item-info')).to_contain_text('User pemilik')
                page.wait_for_function('document.querySelector(".receipt-item img").naturalWidth > 0')
                if role == 'manager':
                    assert page.locator('.receipt-picker,.receipt-file,.receipt-upload').count() == 0
                    assert page.evaluate('window.__uploads') == 0
                else:
                    expect(page.locator('.receipt-file')).to_have_count(1)
                    page.locator('.receipt-file').set_input_files({'name':'nota-baru.png','mimeType':'image/png','buffer':PNG})
                    expect(page.locator('.receipt-upload')).to_be_enabled()
                    page.locator('.receipt-upload').click()
                    expect(page.locator('.receipt-status')).to_contain_text('berhasil')
                    assert page.evaluate('window.__uploads') == 1
                assert not errors, errors
                page.screenshot(path=str(OUT / f'{role}-{"pwa" if standalone else "tab"}.png'), full_page=True)
                print(f'RECEIPT_OWNER_UI_PASS mode={"pwa" if standalone else "tab"} role={role} existing_user_image=1 upload={role=="user"}', flush=True)
                context.close()
        browser.close()
    print('RECEIPT_OWNER_UI_E2E_PASS cases=4 native_android_device=0 production_requests=0', flush=True)

if __name__ == '__main__':
    main()
