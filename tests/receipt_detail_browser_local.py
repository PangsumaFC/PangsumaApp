"""Offline detail-receipt runtime regression with hidden filenames and approved consent."""
import base64
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from qa_fixture_server import serve_in_thread
ROOT = Path(__file__).resolve().parents[1]
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
server, _ = serve_in_thread(host='127.0.0.1', port=0)
base = f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/opt/google/chrome/chrome', headless=True, args=['--no-sandbox'])
        for role in ['user', 'manager']:
            page = browser.new_page(viewport={'width':390,'height':900})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            def route_request(route):
                if route.request.url.endswith('/qa-empty'):
                    route.fulfill(content_type='text/html', body='<div id="detail"></div>')
                elif route.request.url.endswith('/api/receipts/synthetic-receipt'):
                    route.fulfill(content_type='image/png', body=PNG)
                elif route.request.url.startswith(base + '/'):
                    route.continue_()
                else:
                    route.abort()
            page.route('**/*', route_request)
            page.goto(base + '/qa-empty')
            page.set_content('<div id="detail"></div>')
            page.add_script_tag(content=(ROOT/'site/report-evidence.js').read_text())
            page.evaluate('''role => {
              window.writes=[]; window.items=[]; window.role=role; window.failOnce=true;
              ReportEvidence.configure({getUser:()=>({id:'owner',role:window.role}),newKey:()=> 'stable-synthetic-key',api:async(path,options={})=>{
                if(options.method==='POST'){
                  writes.push({body:options.body,key:options.headers['Idempotency-Key']});
                  if(failOnce){failOnce=false;throw new Error('Synthetic retry required');}
                  items=[{id:'synthetic-receipt',url:'/api/receipts/synthetic-receipt',filename:'HIDDEN-secret-file.png',dropboxUrl:'https://www.dropbox.com/scl/fi/synthetic/hidden.png',sizeBytes:70}];
                  return {receipt:items[0]};
                }
                return {items,count:items.length,maxCount:10};
              }});
              ReportEvidence.mountReceipts(document.querySelector('#detail'),{id:'synthetic-submission',createdBy:'owner'});
            }''', role)
            picker = page.locator('.receipt-file')
            expect(picker).to_be_enabled()
            picker.set_input_files({'name':'HIDDEN-selected-file.png','mimeType':'image/png','buffer':PNG})
            expect(page.locator('.receipt-preview')).to_be_visible()
            expect(page.locator('.receipt-upload')).to_be_enabled()
            assert page.evaluate('writes.length') == 0, 'preview alone must never upload'
            assert page.locator('.receipt-file-name,.receipt-consent,.receipt-dropbox-disclosure').count() == 0
            page.locator('.receipt-upload').click()
            expect(page.locator('.receipt-status')).to_contain_text('Synthetic retry required')
            page.locator('.receipt-upload').click()
            expect(page.locator('.receipt-item')).to_have_count(1)
            writes = page.evaluate('writes')
            assert len(writes)==2 and writes[0]==writes[1]
            assert all(w['body']['dropboxPublicConsent'] is True for w in writes)
            assert 'HIDDEN-' not in page.locator('#detail').inner_text()
            assert 'Dropbox' not in page.locator('#detail').inner_text()
            picker.set_input_files({'name':'HIDDEN-second.png','mimeType':'image/png','buffer':PNG})
            expect(page.locator('.receipt-preview')).to_be_visible()
            picker.set_input_files([])
            expect(page.locator('.receipt-upload')).to_be_disabled()
            assert not errors, errors
            page.evaluate('''() => { ReportEvidence.clear(); document.querySelector('#detail').innerHTML=''; ReportEvidence.mountReceipts(document.querySelector('#detail'),{id:'other-submission',createdBy:'other-user'}); }''')
            expect(page.locator('.receipt-file')).to_have_count(0)
            expect(page.locator('.receipt-upload')).to_have_count(0)
            assert not errors, errors
            print(json.dumps({'role':role,'previewNoUpload':True,'retrySameKeyAndPayload':True,'automaticConsent':True,'filenamesHidden':True,'emptyFileSelection':'passed','ownerOnlyUpload':'passed'}), flush=True)
            page.close()
        browser.close()
finally:
    server.shutdown()
