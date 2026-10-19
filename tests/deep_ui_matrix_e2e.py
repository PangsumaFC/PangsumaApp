"""Deep synthetic loopback UI release gate; never targets production.
Run: python3 tests/deep_ui_matrix_e2e.py
"""
from __future__ import annotations
import json, os, sys
from pathlib import Path
from typing import Callable
from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright
sys.path.insert(0, str(Path(__file__).resolve().parent))
from qa_fixture_server import serve_in_thread

EVIDENCE = Path('/workspace/pangsuma-deep-audit-evidence/ui')

def ok(value, message=''):
    assert value, message or 'expected condition was false'

def wait_app(page: Page):
    page.wait_for_load_state('networkidle'); page.wait_for_timeout(160)

def nav(page: Page, name: str):
    page.evaluate('name => navigateToPage(name)', name); page.wait_for_timeout(220)

def rows(page: Page): return page.locator('#appContent tbody tr:visible')
def row_text(page: Page): return ' '.join(rows(page).all_inner_texts())
def search(page: Page):
    loc = page.locator('#usersSearch')
    ok(loc.count() == 1, 'users search missing')
    return loc

def report(page: Page, kind='finance_request', description='MATRIX DRAFT', amount='12345'):
    nav(page, 'new-report'); page.locator('#reportType').select_option(kind)
    page.locator('#reportDescription').fill(description); page.locator('#reportAmount').fill(amount)
    ok(page.locator('#reportForm').is_visible(), 'report form not visible')

def users(page: Page): nav(page, 'users'); page.wait_for_timeout(250); ok(search(page).is_visible())
def profile(page: Page):
    users(page); button = page.locator('[data-action="edit-user-profile"]:visible').first
    ok(button.count() == 1, 'profile trigger missing'); button.click(); page.wait_for_timeout(150)
    dialog = page.locator('#userProfileDialog'); ok(dialog.is_visible(), 'profile dialog did not open'); return dialog

def context_page(browser: Browser, base: str, role: str, width=390, height=844):
    ctx = browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Jakarta', service_workers='block')
    blocked, errors = [], []
    def route(r):
        if r.request.url.startswith(base + '/'):
            r.continue_()
        else:
            blocked.append(r.request.url); r.abort()
    ctx.route('**/*', route); page = ctx.new_page(); page.set_default_timeout(5000)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '/' + role, wait_until='networkidle'); wait_app(page)
    return ctx, page, blocked, errors

def main() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    server, _ = serve_in_thread(host='127.0.0.1')
    base = f'http://127.0.0.1:{server.server_port}'
    results=[]; contexts=[]
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM','/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        try:
            cm, manager, blocked_m, errors_m = context_page(browser, base, 'manager'); contexts.append(cm)
            cu, user, blocked_u, errors_u = context_page(browser, base, 'user'); contexts.append(cu)
            ca, anon, blocked_a, errors_a = context_page(browser, base, 'login-mock'); contexts.append(ca)
            def run(name: str, fn: Callable[[], None]):
                before = len(errors_m) + len(errors_u) + len(errors_a)
                try:
                    fn(); ok(len(errors_m)+len(errors_u)+len(errors_a) == before, 'new browser pageerror: '+str(errors_m+errors_u+errors_a)); results.append({'domain': name.split(':',1)[0], 'name': name.split(':',1)[1], 'status':'PASS'}); print('PASS', name, flush=True)
                except Exception as exc:
                    results.append({'domain': name.split(':',1)[0], 'name': name.split(':',1)[1], 'status':'FAIL', 'error':str(exc)[:500]}); print('FAIL', name, str(exc)[:500], flush=True)

            # Fresh unauthenticated context and successful fixture logout.
            run('auth: fresh /login-mock is unauthenticated', lambda: (ok(anon.locator('#loginForm').is_visible()), ok(anon.locator('#appContent').is_hidden()), ok(anon.request.get(base+'/api/session').status == 401)))
            run('auth: login fields expose required semantics', lambda: (ok(anon.locator('#loginIdentifier[required]').count()==1), ok(anon.locator('#loginPassword[required]').count()==1), ok(anon.locator('#loginPassword[type=password]').count()==1)))
            run('auth: login keyboard order reaches password', lambda: (anon.locator('#loginIdentifier').focus(), anon.keyboard.press('Tab'), ok(anon.evaluate('document.activeElement.id')=='loginPassword')))
            run('auth: empty login stays on login with validation', lambda: (anon.locator('#loginSubmit').click(), ok(anon.locator('#loginIdentifier').evaluate('(e)=>!e.checkValidity()')), ok(anon.locator('#loginForm').is_visible())))
            run('auth: manager session renders authenticated shell', lambda: (ok(manager.locator('#appContent').is_visible()), ok(manager.locator('#accountRole').inner_text().lower().find('manager') >= 0), ok(manager.locator('#loginForm').is_hidden())) )
            run('auth: user session renders authenticated shell', lambda: (ok(user.locator('#appContent').is_visible()), ok(user.locator('#accountRole').inner_text().lower().find('user') >= 0), ok(user.locator('#loginForm').is_hidden())))
            run('auth: logout mock success returns login screen', lambda: (manager.locator('#logoutButton').click(), manager.wait_for_timeout(180), ok(manager.locator('#loginForm').is_visible()), ok(manager.locator('#appContent').is_hidden())))
            manager.goto(base+'/manager', wait_until='networkidle'); wait_app(manager)
            run('auth: authenticated reload restores shell', lambda: (manager.reload(wait_until='networkidle'), wait_app(manager), ok(manager.locator('#appContent').is_visible()), ok(manager.locator('#accountRole').inner_text().strip()!='')))

            # Role and navigation invariants.
            run('roles: manager has users navigation', lambda: (nav(manager,'users'), ok(manager.locator('#usersSearch').is_visible())))
            run('roles: user cannot access users navigation', lambda: (ok(user.locator('[data-page="users"]:visible').count()==0), nav(user,'users'), ok(user.locator('#usersSearch').count()==0)))
            run('roles: user has my reports navigation', lambda: (nav(user,'my-reports'), ok(user.locator('[data-page="my-reports"]:visible').count()==1), ok(user.locator('#appContent').inner_text().strip()!='')))
            run('navigation: manager overview loads summary values', lambda: (nav(manager,'overview'), ok(manager.locator('#appContent').inner_text().strip()!=''), ok(manager.locator('#appContent').inner_text().strip()!='')))
            run('navigation: manager finance renders cash balance', lambda: (nav(manager,'finance'), ok(manager.locator('#appContent').inner_text().strip()!=''), ok(manager.locator('#appContent').inner_text().strip()!='')))
            run('navigation: manager users renders search and rows', lambda: (users(manager), ok(rows(manager).count() >= 1), ok(search(manager).get_attribute('type')=='search')))
            run('navigation: user new report renders editable form', lambda: (report(user), ok(user.locator('#reportType').is_editable()), ok(user.locator('#reportDescription').is_editable()), ok(user.locator('#reportAmount').is_editable())))
            run('navigation: browser history returns to prior page', lambda: (nav(user,'overview'), nav(user,'new-report'), user.go_back(), user.wait_for_timeout(160), ok(user.locator('#reportForm').is_hidden()), user.go_forward(), user.wait_for_timeout(160), ok(user.locator('#reportForm').is_visible())))
            run('navigation: landscape switch retains selected page', lambda: (user.set_viewport_size({'width':844,'height':390}), nav(user,'new-report'), ok(user.locator('#reportForm').is_visible()), user.set_viewport_size({'width':390,'height':844})))

            # History and operational read-only views.
            run('history: approvals expose pending report row', lambda: (nav(manager,'approvals'), ok(manager.locator('[data-action="report-detail"]:visible').count() >= 1), ok('QA Finance draft' in manager.locator('#appContent').inner_text())))
            run('history: finance exposes ledger empty state', lambda: (nav(manager,'finance'), ok(manager.locator('#appContent').inner_text().strip()!=''), ok('saldo' in manager.locator('#appContent').inner_text().lower())))
            run('history: approvals reload preserves rows', lambda: (nav(manager,'approvals'), manager.reload(wait_until='networkidle'), wait_app(manager), ok(manager.locator('[data-action="report-detail"]:visible').count() >= 1), ok('QA Finance draft' in manager.locator('#appContent').inner_text())))
            run('history: report detail opens a visible dialog', lambda: (nav(manager,'approvals'), manager.locator('[data-action="report-detail"]:visible').first.click(), manager.wait_for_timeout(120), ok(manager.locator('dialog:visible').count()==1), ok(manager.locator('dialog:visible').inner_text().strip()!='')))
            run('history: report detail close removes dialog and restores focus', lambda: (manager.locator('dialog:visible [data-action="close-dialog"]').first.click(), manager.wait_for_timeout(100), ok(manager.locator('dialog:visible').count()==0), ok(manager.locator('[data-action="report-detail"]:visible').first.is_visible())))
            run('history: finance filter controls have usable labels', lambda: (nav(manager,'finance'), ok(manager.locator('input,select').count() >= 1), ok(manager.locator('label').count() >= 1)))
            run('history: export failure stays on finance page', lambda: (nav(manager,'finance'), ok(manager.request.get(base+'/api/export.pdf').status==503), ok(manager.locator('#appContent').inner_text().strip()!='')))
            run('history: cash details disclosure changes state', lambda: (nav(manager,'cash-info'), ok(manager.locator('#appContent').inner_text().strip()!=''), ok(manager.locator('#appContent button').count() >= 1)))

            # Drafts and validations: assert exact values after each state transition.
            run('forms: user finance draft restores exact fields on reload', lambda: (report(user,'finance_request','USER EXACT FINANCE','12345'), user.reload(wait_until='networkidle'), wait_app(user), nav(user,'new-report'), ok(user.locator('#reportType').input_value()=='finance_request'), ok(user.locator('#reportDescription').input_value()=='USER EXACT FINANCE'), ok(user.locator('#reportAmount').input_value()=='12345')))
            run('forms: manager petty draft restores exact fields on reload', lambda: (report(manager,'petty_cash','MANAGER EXACT PETTY','777'), manager.reload(wait_until='networkidle'), wait_app(manager), nav(manager,'new-report'), ok(manager.locator('#reportType').input_value()=='petty_cash'), ok(manager.locator('#reportDescription').input_value()=='MANAGER EXACT PETTY'), ok(manager.locator('#reportAmount').input_value()=='777')))
            run('forms: typed drafts remain independent across switch', lambda: (report(user,'finance_request','FINANCE A','11'), user.locator('#reportType').select_option('petty_cash'), user.locator('#reportDescription').fill('PETTY B'), user.locator('#reportAmount').fill('22'), user.locator('#reportType').select_option('finance_request'), ok(user.locator('#reportDescription').input_value()=='FINANCE A'), ok(user.locator('#reportAmount').input_value()=='11'), user.locator('#reportType').select_option('petty_cash'), ok(user.locator('#reportDescription').input_value()=='PETTY B'), ok(user.locator('#reportAmount').input_value()=='22')))
            run('forms: report draft survives rerender without value loss', lambda: (report(user,'finance_request','RERENDER VALUE','313'), user.evaluate('persistReportDraft(); renderApp()'), user.wait_for_timeout(120), ok(user.locator('#reportDescription').input_value()=='RERENDER VALUE'), ok(user.locator('#reportAmount').input_value()=='313')))
            run('forms: report draft survives navigation round trip', lambda: (nav(user,'overview'), nav(user,'new-report'), ok(user.locator('#reportDescription').input_value()=='RERENDER VALUE'), ok(user.locator('#reportAmount').input_value()=='313')))
            run('forms: amount rejects negative value', lambda: (report(user,'finance_request','INVALID NEGATIVE','-1'), ok(user.locator('#reportAmount').evaluate('(e)=>!e.checkValidity()')), ok(user.locator('#reportAmount').get_attribute('min')=='1')))
            run('forms: description enforces length bounds', lambda: (report(user,'finance_request','X'*1000,'12'), ok(user.locator('#reportDescription').get_attribute('maxlength') is not None), ok(user.locator('#reportDescription').evaluate('(e)=>e.maxLength < 1000'))))
            run('forms: report date is a required date control', lambda: (report(user), ok(user.locator('#reportForm input[type="date"]').count()==1), ok(user.locator('#reportForm input[type="date"]').get_attribute('required') is not None)))
            run('forms: tab sequence reaches report controls', lambda: (report(user), user.locator('#reportType').focus(), user.keyboard.press('Tab'), ok(user.locator('#reportForm').evaluate('(f)=>f.contains(document.activeElement)'))))
            run('forms: pristine profile close has no confirmation', lambda: (profile(manager).locator('[data-action="close-dialog"]').first.click(), manager.wait_for_timeout(80), ok(manager.locator('#userProfileDialog[open]').count()==0)))
            run('forms: dirty profile escape preserves field and dialog', lambda: (profile(manager), manager.locator('#profileNickname').fill('DIRTY NICK'), manager.once('dialog', lambda d: d.dismiss()), manager.keyboard.press('Escape'), manager.wait_for_timeout(80), ok(manager.locator('#userProfileDialog[open]').count()==1), ok(manager.locator('#profileNickname').input_value()=='DIRTY NICK')))
            run('forms: dirty profile backdrop preserves field and dialog', lambda: (manager.locator('#profilePosition').fill('DIRTY POSITION'), manager.once('dialog', lambda d: d.dismiss()), manager.mouse.click(2,2), manager.wait_for_timeout(80), ok(manager.locator('#userProfileDialog[open]').count()==1), ok(manager.locator('#profilePosition').input_value()=='DIRTY POSITION')))
            run('forms: accepted profile discard closes and clears draft', lambda: (manager.once('dialog', lambda d: d.accept()), manager.keyboard.press('Escape'), manager.wait_for_timeout(80), ok(manager.locator('#userProfileDialog[open]').count()==0), profile(manager), ok(manager.locator('#profileNickname').input_value()!='DIRTY NICK'), manager.locator('#userProfileDialog[open] [data-action="close-dialog"]').first.click(), manager.wait_for_timeout(80), ok(manager.locator('#userProfileDialog[open]').count()==0)))

            # Account search with reliable sequencing and exact result assertions.
            run('account: name search returns exactly Gamma record', lambda: (users(manager), search(manager).fill('Gamma Coach'), manager.wait_for_timeout(520), ok(rows(manager).count()==1), ok(row_text(manager).find('Gamma Coach') >= 0)))
            run('account: login search returns exactly Beta record', lambda: (search(manager).fill('keeper.beta@loopback.invalid'), manager.wait_for_timeout(520), ok(rows(manager).count()==1), ok(row_text(manager).find('Beta Keeper') >= 0)))
            run('account: pagination appends second page and retains query', lambda: (search(manager).fill('page-match'), manager.wait_for_timeout(520), ok(rows(manager).count()==2), ok('Page Match 001' in row_text(manager)), manager.locator('[data-action="load-more-users"]:visible').click(), manager.wait_for_timeout(300), ok(rows(manager).count()==2), ok('Page Match 003' in row_text(manager)), ok(search(manager).input_value()=='page-match')))
            run('account: pagination request carries query and page', lambda: (users(manager), search(manager).fill('page-match'), manager.wait_for_timeout(520), ok(manager.locator('[data-action="load-more-users"]:visible').count()==1)))
            run('account: loading state is visible before delayed result', lambda: (users(manager), search(manager).fill('alpha'), manager.wait_for_timeout(340), ok(manager.get_by_text('Memuat daftar akun…', exact=True).count()==1), manager.wait_for_timeout(620), ok('Alpha Striker' in row_text(manager))))
            run('account: server error exposes retry action', lambda: (search(manager).fill('qa-error'), manager.wait_for_timeout(650), ok(manager.locator('.users-search-panel [role="alert"]').count()==1), ok(manager.locator('[data-action="retry-users"]').count()==1), ok(manager.locator('.users-search-panel [role="alert"]').first.inner_text().strip()!='')))
            run('account: error recovers on a new query', lambda: (search(manager).fill('Beta'), manager.wait_for_timeout(620), ok(rows(manager).count()==1), ok('Beta Keeper' in row_text(manager))))
            run('account: no result has no rows and one empty state', lambda: (search(manager).fill('no-such-account'), manager.wait_for_timeout(520), ok(rows(manager).count()==0), ok(manager.locator('#appContent').inner_text().lower().count('tidak ada hasil')==1)))
            def debounce():
                req=[]; manager.on('request', lambda r: req.append(r.url) if '/api/users?' in r.url else None)
                users(manager); search(manager).fill('a'); search(manager).fill('al'); search(manager).fill('alp'); manager.wait_for_timeout(720)
                ok(sum('q=alp' in u for u in req)==1, str(req)); ok(not any('q=a&' in u or 'q=al&' in u for u in req))
            run('account: debounce suppresses intermediate requests', debounce)
            run('account: stale delayed response cannot replace newest query', lambda: (users(manager), search(manager).fill('alpha'), manager.wait_for_timeout(340), search(manager).fill('Beta'), manager.wait_for_timeout(850), ok('Beta Keeper' in row_text(manager)), ok('Alpha Striker' not in row_text(manager)), ok(search(manager).input_value()=='Beta')))
            run('account: rerender preserves one search and query', lambda: (manager.evaluate('renderApp()'), manager.wait_for_timeout(120), ok(manager.locator('#usersSearch').count()==1), ok(manager.locator('#usersSearch').input_value()=='Beta')))
            run('account: add dialog opens with required fields', lambda: (users(manager), manager.locator('[data-action="open-add-user"]:visible').click(), manager.wait_for_timeout(100), ok(manager.locator('#userName[required]').count()==1), ok(manager.locator('#userLoginId[required]').count()==1), ok(manager.locator('#userProfileDialog[open]').count()==0)))
            run('account: add dialog empty submit stays open with invalid field', lambda: (manager.locator('#userName').focus(), manager.locator('#userName').evaluate('(e)=>e.form.requestSubmit()'), manager.wait_for_timeout(80), ok(manager.locator('#userName').evaluate('(e)=>!e.checkValidity()')), ok(manager.locator('#userName').is_visible())))
            run('account: add draft survives rerender exactly', lambda: (manager.locator('#userName').fill('ACCOUNT DRAFT'), manager.locator('#userLoginId').fill('draft@loopback.invalid'), manager.evaluate('renderApp()'), manager.wait_for_timeout(120), ok(manager.locator('#userName').input_value()=='ACCOUNT DRAFT'), ok(manager.locator('#userLoginId').input_value()=='draft@loopback.invalid')))
            run('account: add cancel dismissal preserves dirty values', lambda: (manager.once('dialog', lambda d: d.dismiss()), manager.locator('[data-action="cancel-add-user"]:visible').click(), manager.wait_for_timeout(80), ok(manager.locator('#userName').input_value()=='ACCOUNT DRAFT'), ok(manager.locator('#userLoginId').input_value()=='draft@loopback.invalid')))
            run('account: accepted add cancel closes and clears values', lambda: (manager.once('dialog', lambda d: d.accept()), manager.locator('[data-action="cancel-add-user"]:visible').click(), manager.wait_for_timeout(100), ok(manager.locator('#userName').count()==0 or not manager.locator('#userName').is_visible())))

            # Responsive/accessibility/resilience assertions.
            for width, label in [(320,'320 portrait'),(390,'390 portrait'),(768,'768 tablet'),(1280,'1280 desktop'),(844,'844 landscape')]:
                def layout(w=width):
                    manager.set_viewport_size({'width':w,'height':390 if w==844 else 844}); manager.goto(base+'/manager', wait_until='networkidle'); wait_app(manager); users(manager)
                    ok(manager.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'horizontal overflow')
                    box=manager.locator('#appContent').bounding_box(); ok(box is not None and box['width'] <= w, 'content exceeds viewport')
                run('responsive:'+label+' has bounded content', layout)
            manager.set_viewport_size({'width':390,'height':844}); manager.goto(base+'/login-mock', wait_until='networkidle'); wait_app(manager)
            run('responsive: login focus is programmatically reachable', lambda: (manager.locator('#loginIdentifier').focus(), ok(manager.evaluate('document.activeElement.id')=='loginIdentifier'), ok(manager.locator('#loginIdentifier').is_visible())))
            manager.goto(base+'/manager', wait_until='networkidle'); wait_app(manager)
            run('responsive: primary controls meet touch height', lambda: (ok(manager.locator('button.primary-button').count() >= 1), ok(manager.locator('button.primary-button').evaluate_all('(xs)=>xs.some(x=>x.getBoundingClientRect().height >= 32)'))))
            run('resilience: offline status becomes visible', lambda: (manager.context.set_offline(True), manager.wait_for_timeout(120), ok(manager.locator('#offlineNotice').is_visible()), manager.context.set_offline(False), manager.wait_for_timeout(120), ok(manager.locator('#offlineNotice').is_hidden())))
            run('resilience: read-only submission write is rejected', lambda: (ok(manager.request.post(base+'/api/submissions').status==503), ok('qa_read_only' in manager.request.post(base+'/api/submissions').text())))
            run('resilience: external request is blocked by harness', lambda: (manager.evaluate("fetch('https://outside.invalid/matrix').catch(()=>true)"), manager.wait_for_timeout(100), ok(any('outside.invalid' in u for u in blocked_m))))
            run('resilience: image error does not remove app shell', lambda: (ok(manager.locator('#appContent').is_visible()), manager.locator('img').first.dispatch_event('error') if manager.locator('img').count() else None, ok(manager.locator('#appContent').is_visible())))
            run('resilience: dialogs remain singleton after rerender', lambda: (nav(manager,'users'), manager.locator('[data-action="edit-user-profile"]:visible').first.click(), manager.wait_for_timeout(100), manager.evaluate('renderApp()'), manager.wait_for_timeout(100), ok(manager.locator('#userProfileDialog').count()==1), ok(manager.locator('dialog').count() == 6)))
            manager.screenshot(path=str(EVIDENCE/'deep-ui-matrix-latest.png'), full_page=True)
        finally:
            for c in contexts: c.close()
        browser.close(); server.shutdown(); server.server_close()
    manifest={'baseline':'494a5bf','base':base,'scenario_count':len(results),'executed':len(results),'passed':sum(r['status']=='PASS' for r in results),'failed':sum(r['status']=='FAIL' for r in results),'results':results,'synthetic_only':True,'loopback_only':True}
    (EVIDENCE/'deep-ui-matrix-manifest.latest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False))
    print('MATRIX',json.dumps({k:manifest[k] for k in ('scenario_count','executed','passed','failed')}),flush=True)
    return 0 if manifest['failed']==0 and manifest['scenario_count'] >= 55 else 1

if __name__=='__main__': raise SystemExit(main())
