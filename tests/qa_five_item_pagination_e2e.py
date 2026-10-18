"""Deterministic five-item cursor pagination QA for every bounded app surface.

Run directly with ``python3 tests/qa_five_item_pagination_e2e.py``.  The fixture is
read-only, serves the production ``site`` bundle, and all browser requests are
restricted to its loopback origin.
"""
from __future__ import annotations
import json, os, sys, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
PAGE_SIZE = 5


def user(role):
    return {"id": f"qa-{role}", "role": role, "name": f"QA {role.title()}",
            "email": f"{role}@qa.invalid", "loginId": f"{role}@qa.invalid",
            "position": "QA", "dashboardPosition": "QA", "nickname": "QA",
            "quote": "synthetic", "photoUrl": "", "profileVersion": 1,
            "active": True, "passwordReady": True, "mustChangePassword": False}


def item(i, kind="petty_cash", status="approved", owner="qa-user"):
    return {"id": f"qa-{kind}-{i:02d}", "type": kind, "status": status,
            "amountIdr": 1000 + i, "date": "2026-10-18", "description": f"QA {kind} {i:02d}",
            "note": "synthetic", "createdBy": owner, "createdByName": f"QA User {i:02d}",
            "createdByPosition": "QA", "createdAt": f"2026-10-{18-(i//24):02d}T{i%24:02d}:00:00Z",
            "updatedAt": f"2026-10-{18-(i//24):02d}T{i%24:02d}:30:00Z"}


SUBMISSIONS = [item(i, "finance_request" if i % 2 else "petty_cash", "pending" if i <= 12 else "approved") for i in range(1, 25)]
# User history is exactly 12 rows; manager finance and approval streams are larger.
USER_HISTORY = [item(i, "petty_cash", "approved" if i % 2 else "rejected", "qa-user") for i in range(1, 13)]
PENDING = [item(i, "finance_request" if i % 2 else "petty_cash", "pending", f"qa-user-{i}") for i in range(1, 13)]
PENDING[0]["description"] = "QA Finance target"
APPROVED = [item(i, "finance_request", "approved", f"qa-user-{i}") for i in range(1, 5)]
REPORTS = [item(i, "finance_request" if i % 2 else "petty_cash", "approved" if i == 12 else "pending", f"qa-user-{i}") for i in range(1, 13)]


def page(rows, query, key="id"):
    # Cursor is deliberately transparent in the fixture, while still exercising
    # the app's opaque-cursor plumbing and exact server slicing.
    try: start = int(query.get("cursor", ["0"])[0] or 0)
    except ValueError: start = 0
    if query.get("direction", [""])[0] == "before": start = max(0, start - PAGE_SIZE)
    out = rows[start:start + PAGE_SIZE]
    return {"items": out, "submissions": out, "total": len(rows),
            "cursor": str(start), "nextCursor": str(start + PAGE_SIZE) if start + PAGE_SIZE < len(rows) else None,
            "previousCursor": str(start) if start else None,
            "hasMore": start + PAGE_SIZE < len(rows), "hasPrevious": start > 0}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw): super().__init__(*a, directory=str(SITE), **kw)
    def log_message(self, *_): pass
    def role(self): return "user" if "qa-role=user" in self.headers.get("Cookie", "") else "manager"
    def send_json(self, value, status=200):
        body = json.dumps(value).encode(); self.send_response(status)
        self.send_header("Content-Type", "application/json"); self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p = urlsplit(self.path); q = parse_qs(p.query); role = self.role()
        if p.path in ("/manager", "/user"):
            self.send_response(200); self.send_header("Set-Cookie", f"qa-role={'user' if p.path == '/user' else 'manager'}; Path=/")
            self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write((SITE / "index.html").read_bytes()); return
        if not p.path.startswith("/api/"): return super().do_GET()
        path = p.path[5:]
        if path == "passkeys/status": return self.send_json({"enabled": False})
        if path == "session": return self.send_json({"user": user(role)})
        if path == "overview":
            rows = USER_HISTORY if role == "user" else SUBMISSIONS[:5]
            return self.send_json({"user": user(role), "users": [], "submissions": rows[:5],
              "pendingSubmissions": PENDING[:5] if role == "manager" else [], "cashBalanceIdr": 100000,
              "cashLedger": [item(i, "ledger", "approved") for i in range(1, 6)],
              "auditEvents": [item(i, "audit", "approved") for i in range(1, 6)],
              "summary": {"pending": len(PENDING), "financeWaiting": 6, "today": 5, "total": 24},
              "cashFlow": {"incomingIdr": "100000", "outgoingIdr": "12000"},
              "history": {"submissions": {"total": len(rows), "loaded": min(5,len(rows)), "hasMore": len(rows)>5, "nextCursor": "5"},
                          "cashLedger": {"total": 12, "loaded": 5, "hasMore": True, "nextCursor": "5"},
                          "auditEvents": {"total": 12, "loaded": 5, "hasMore": True, "nextCursor": "5"}}})
        if path == "users":
            term = q.get("q", [""])[0].casefold(); all_users = [{**user("user"), "id": f"qa-user-{i}", "name": f"User {i:02d}", "email": f"user{i:02d}@qa.invalid", "loginId": f"user{i:02d}@qa.invalid"} for i in range(1, 13)]
            if term == "qa-error": return self.send_json({"error": {"message": "Synthetic fixture failure"}}, 503)
            matched = [x for x in all_users if not term or term in x["name"].casefold() or term in x["email"]]
            try: n = max(1, int(q.get("page", ["1"])[0]))
            except ValueError: n = 1
            start = (n - 1) * PAGE_SIZE; out = matched[start:start+PAGE_SIZE]
            return self.send_json({"users": out, "total": len(matched), "page": n, "limit": PAGE_SIZE, "hasMore": start+PAGE_SIZE < len(matched)})
        if path.startswith("history/"):
            rows = USER_HISTORY if path == "history/submissions" and role == "user" else ([item(i, "ledger") for i in range(1,13)] if path == "history/cash-ledger" else [item(i, "audit") for i in range(1,13)])
            term = q.get("q", [""])[0].casefold()
            if term: rows = [r for r in rows if term in r.get("description", "").casefold() or term in r.get("status", "").casefold()]
            key = "cashLedger" if "cash-ledger" in path else ("auditEvents" if "audit-events" in path else "submissions")
            result = page(rows, q); result[key] = result["items"]; return self.send_json(result)
        if path == "submissions":
            if q.get("status", [""])[0] == "pending":
                return self.send_json(page(PENDING, q))
            rows = USER_HISTORY if role == "user" else SUBMISSIONS
            term = q.get("q",[""])[0].casefold(); rows = [r for r in rows if not term or term in r["description"].casefold()]
            if q.get("jenis",[""])[0]: rows=[r for r in rows if r["type"]==q["jenis"][0]]
            return self.send_json(page(rows, q))
        if path == "reports":
            term = q.get("q", [""])[0].casefold(); rows = [r for r in REPORTS if not term or term in r["description"].casefold()]
            if q.get("status", [""])[0]: rows = [r for r in rows if r["status"] == q["status"][0]]
            result = page(rows, q); result["previousCursor"] = str(max(0,int(q.get("cursor",["0"])[0])-5)) if int(q.get("cursor",["0"])[0]) else None; return self.send_json(result)
        if path == "cash/insights": return self.send_json({"balanceIdr":"100000","daily":[],"monthly":[],"topExpenses":[],"recentTopups":[],"summary":{"incomingIdr":"100000","outgoingIdr":"12000"},"alerts":[]})
        if path.endswith("/activity"):
            result = page([item(i,"activity") for i in range(1,13)], q)
            result["activity"] = result["items"]
            result["submission"] = SUBMISSIONS[0]
            return self.send_json(result)
        return self.send_json({})
    def reject(self): return self.send_json({"error":{"code":"qa_read_only","message":"fixture is read-only"}}, 503)
    do_POST = do_PUT = do_PATCH = do_DELETE = lambda self: self.reject()


def start():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler); threading.Thread(target=server.serve_forever, daemon=True).start(); return server

def ok(x, msg=""): assert x, msg or "assertion failed"
def wait(page): page.wait_for_timeout(650)
def go(page, name): page.evaluate("name => navigateToPage(name)", name); wait(page)
def texts(page): return page.locator("#appContent").inner_text()
def ids(page): return [x for x in page.locator("#appContent .item-title:visible").all_inner_texts()]

def main():
    server = start(); base = f"http://127.0.0.1:{server.server_port}"; results=[]; contexts=[]
    with sync_playwright() as pw:
      browser = pw.chromium.launch(executable_path=os.environ.get("CHROMIUM", "/usr/bin/chromium"), headless=True, args=["--no-sandbox"])
      def run(name, fn):
        try: fn(); results.append([name,"PASS"]); print("PASS", name, flush=True)
        except Exception as e: results.append([name,"FAIL",str(e)[:400]]); print("FAIL", name, str(e)[:400], flush=True)
      try:
        cm = browser.new_context(viewport={"width":1280,"height":900}, service_workers="block"); contexts.append(cm); m=cm.new_page(); blocked=[]; cm.route("**/*", lambda r: r.continue_() if r.request.url.startswith(base+"/") else (blocked.append(r.request.url), r.abort())); m.goto(base+"/manager", wait_until="networkidle"); wait(m)
        cu = browser.new_context(viewport={"width":390,"height":844}, service_workers="block"); contexts.append(cu); u=cu.new_page(); cu.route("**/*", lambda r: r.continue_() if r.request.url.startswith(base+"/") else r.abort()); u.goto(base+"/user", wait_until="networkidle"); wait(u)
        def history_all():
            go(u,"my-reports"); first=ids(u); ok(len(first)==5); collected=list(first)
            for number,count in ((2,5),(3,2)):
                u.locator('[data-action="load-more-history"][data-collection="submissions"]:visible').click(); wait(u)
                ok(f"Halaman {number}" in texts(u)); current=ids(u); ok(len(current)==count); collected.extend(current)
            ok(len(collected)==12 and len(set(collected))==12, collected)
            ok(set(collected)=={f"QA petty_cash {i:02d}" for i in range(1,13)}, collected)
            for number in (2,1):
                u.locator('[data-action="history-previous"][data-collection="submissions"]:visible').click(); wait(u); ok(f"Halaman {number}" in texts(u))
            ok(ids(u)==first)
        run("user history next/back all 12 without duplicates or omissions", history_all)
        def user_search():
            go(u,"my-reports"); s=u.locator("#archiveSearch"); s.fill("QA petty_cash 12"); wait(u); ok("QA petty_cash 12" in texts(u))
        run("user history search reaches target row 12", user_search)
        def approvals():
            go(m,"approvals"); wait(m); ok(len(m.locator(".item-row:visible").all())<=5); m.locator('[data-action="pending-next"]:visible').click(force=True); wait(m); ok(m.locator('[data-action="approve"]:visible').count()<=5); m.locator('[data-action="pending-previous"]:visible').click(force=True); wait(m); ok("QA Finance target" in texts(m)); ok("QA Finance target" in texts(m))
        run("manager approvals pending excludes approved and next/back", approvals)
        def activity():
            go(m,"approvals"); wait(m); m.locator('[data-action="report-detail"]:visible').first.click(force=True); wait(m)
            dialog = m.locator("#reportActivityDialog"); ok(dialog.is_visible()); ok(dialog.locator(".audit-list li").count() == 5)
            dialog.locator('[data-report-activity-more]').click(force=True); wait(m); ok(dialog.locator(".audit-list li").count() == 5)
            dialog.locator('[data-report-activity-before]').click(force=True); wait(m); ok(dialog.locator(".audit-list li").count() == 5); dialog.locator('[data-action="close-dialog"]').click()
        run("report activity twelve events is bounded five per cursor page", activity)
        def finance():
            go(m,"finance"); wait(m); ok(len(m.locator(".item-row:visible").all())<=5); m.locator('[name="q"]:visible').fill("QA petty_cash 12"); m.locator('#managerReportFiltersForm:visible button[type="submit"]').click(force=True); wait(m); ok("QA petty_cash 12" in texts(m)); m.locator('[data-manager-report-action="reset"]:visible').click(force=True); wait(m); m.locator('[data-manager-report-action="after"]:visible').click(force=True); wait(m); m.locator('[data-manager-report-action="before"]:visible').click(force=True); wait(m)
        run("manager Finance next/back/search", finance)
        def users():
            go(m,"users"); wait(m); ok(len(m.locator("tbody tr:visible").all())==5); req=[]; m.on("request", lambda r: req.append(r.url) if "/api/users?" in r.url else None); m.locator("#usersSearch").fill("User"); wait(m); m.locator('[data-action="load-more-users"]:visible').click(force=True); wait(m); ok(any("page=2" in x and "limit=5" in x for x in req), req)
        run("users server query limit 5 and pagination", users)
        def users_recovery():
            m.locator("#usersSearch").fill("no-such"); wait(m); ok(m.locator("tbody tr:visible").count()==0)
            m.locator("#usersSearch").fill("qa-error"); wait(m); ok(m.locator('[role="alert"]:visible').count()>=1)
            m.locator("#usersSearch").fill("User 01"); wait(m); ok("User 01" in texts(m))
        run("manager users empty and error recovery", users_recovery)
        def responsive():
            for width in (320,390,1280):
                m.set_viewport_size({"width":width,"height":844}); go(m,"overview"); ok(m.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), width)
        run("dashboard responsive 320/390/1280 no overflow", responsive)
        run("pagination focus survives rerender", lambda: (m.set_viewport_size({"width":1280,"height":900}), go(m,"approvals"), m.locator('[data-action="pending-next"]:visible').focus(), m.locator('[data-action="pending-next"]:visible').click(force=True), wait(m), ok(m.locator('[data-action="pending-previous"]:visible').evaluate("e => e === document.activeElement"))))
        def readonly():
            ok(m.evaluate("fetch('/api/users',{method:'POST',body:'x'}).then(r=>r.status)")==503)
            m.evaluate("fetch('https://outside.invalid/qa').catch(()=>null)"); wait(m); ok(any("outside.invalid" in x for x in blocked))
        run("fixture rejects every mutation and blocks external network", readonly)
      finally:
        for c in contexts: c.close()
        browser.close(); server.shutdown(); server.server_close()
    print("RESULTS_JSON="+json.dumps(results)); passed=sum(x[1]=="PASS" for x in results); print(f"TOTAL {len(results)} PASS {passed} FAIL {len(results)-passed}")
    return 0 if passed == len(results) else 1

if __name__ == "__main__": raise SystemExit(main())
