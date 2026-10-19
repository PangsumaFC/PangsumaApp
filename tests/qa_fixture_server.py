"""Reusable loopback fixture server for QA browser regressions."""
from __future__ import annotations

import argparse
import json
import pathlib
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SITE = pathlib.Path(__file__).resolve().parents[1] / "site"


def _user(role: str, suffix: str = "") -> dict:
    return {
        "id": f"qa-{role}{suffix}", "role": role,
        "name": "QA Demo Manager" if role == "manager" else "QA Demo User",
        "email": f"{role}{suffix}@loopback.invalid", "loginId": f"{role}{suffix}@loopback.invalid",
        "position": "QA sintetis", "dashboardPosition": "QA sintetis", "nickname": "QA Nickname",
        "quote": "Quote sintetis", "photoUrl": "", "profileVersion": 1,
        "active": True, "passwordReady": True, "mustChangePassword": False,
    }


def _users() -> list[dict]:
    # The application asks for limit=100.  The fixture intentionally returns an
    # effective limit of 2 below, so pagination is real and deterministic.
    users = [_user("manager"),
        {**_user("user", "-alpha"), "name": "Alpha Striker", "email": "alpha.login@loopback.invalid", "loginId": "alpha.login@loopback.invalid"},
        {**_user("user", "-beta"), "name": "Beta Keeper", "email": "keeper.beta@loopback.invalid", "loginId": "keeper.beta@loopback.invalid"},
        {**_user("user", "-gamma"), "name": "Gamma Coach", "email": "coach.gamma@loopback.invalid", "loginId": "coach.gamma@loopback.invalid"},
        {**_user("user", "-delta"), "name": "Delta Analyst", "email": "analyst.delta@loopback.invalid", "loginId": "analyst.delta@loopback.invalid"}]
    users.extend({**_user("user", f"-page-{i:03d}"), "name": f"Page Match {i:03d}",
                  "email": f"page-match-{i:03d}@loopback.invalid", "loginId": f"page-match-{i:03d}@loopback.invalid"}
                 for i in range(1, 107))
    return users


def _reports(role: str) -> list[dict]:
    owner = "qa-user-alpha" if role == "manager" else f"qa-{role}"
    return [{"id": "qa-report-finance", "type": "finance_request", "status": "pending", "amountIdr": 12345, "date": "2026-10-18", "description": "QA Finance draft", "note": "Synthetic", "createdBy": owner, "createdByName": "QA Demo User", "createdByPosition": "QA", "createdAt": "2026-10-18T08:00:00Z", "updatedAt": "2026-10-18T09:00:00Z"},
            {"id": "qa-report-petty", "type": "petty_cash", "status": "pending", "amountIdr": 100, "date": "2026-10-18", "description": "QA Petty draft", "note": "Synthetic", "createdBy": owner, "createdByName": "QA Demo User", "createdByPosition": "QA", "createdAt": "2026-10-18T08:00:00Z", "updatedAt": "2026-10-18T09:00:00Z"}]


def _json(handler, value, status=200):
    body = json.dumps(value, ensure_ascii=False).encode()
    handler.send_response(status); handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store"); handler.send_header("Content-Length", str(len(body))); handler.end_headers(); handler.wfile.write(body)


def make_handler(site: pathlib.Path = SITE):
    class FixtureHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(site), **kwargs)
        def log_message(self, *_args): return
        def _role(self):
            cookie = self.headers.get("Cookie", "")
            if "qa-role=none" in cookie: return "none"
            return "user" if "qa-role=user" in cookie else "manager"
        def do_GET(self):  # noqa: N802
            parsed = urlsplit(self.path)
            if parsed.path in ("/manager", "/user", "/login-mock"):
                role = "user" if parsed.path == "/user" else "manager"; role = "none" if parsed.path == "/login-mock" else role
                self.send_response(200); self.send_header("Set-Cookie", f"qa-role={role}; Path=/; SameSite=Lax"); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers(); self.wfile.write((site / "index.html").read_bytes()); return
            if not parsed.path.startswith("/api/"): return super().do_GET()
            path, query, role = parsed.path[5:], parse_qs(parsed.query), self._role(); current, users, reports = _user(role), _users(), _reports(role)
            if path == "passkeys/status": return _json(self, {"enabled": False})
            if path == "session": return _json(self, {"error": {"code": "unauthorized"}}, 401) if role == "none" else _json(self, {"user": current})
            if path == "overview": return _json(self, {"user": current, "users": users if role == "manager" else [], "submissions": reports, "pendingSubmissions": reports, "cashBalanceIdr": 100000, "cashLedger": [], "auditEvents": [], "summary": {"pending": 2, "financeWaiting": 1, "today": 2, "total": 2}, "cashFlow": {"incomingIdr": "100000", "outgoingIdr": "0"}, "history": {"submissions": {"total": 2, "hasMore": False, "loaded": 2}, "cashLedger": {"total": 0}, "auditEvents": {"total": 0}}})
            if path == "users":
                term = query.get("q", [""])[0].strip().casefold(); matched = [u for u in users if not term or term in u["name"].casefold() or term in u["email"].casefold() or term in u["loginId"].casefold()]
                page = max(1, int(query.get("page", ["1"])[0] or 1)); requested = max(1, min(100, int(query.get("limit", ["100"])[0] or 100))); limit = min(requested, 2)
                start = (page - 1) * limit
                # Alpha is delayed after its request starts; Beta is immediate.
                if term == "alpha": time.sleep(0.45)
                if term == "qa-error": return _json(self, {"error": {"code": "qa_fixture_error", "message": "Synthetic fixture failure"}}, 503)
                rows = matched[start:start + limit]
                return _json(self, {"users": rows, "total": len(matched), "page": page, "limit": limit, "hasMore": start + limit < len(matched)})
            if path.endswith("/profile") or path == "profile": return _json(self, {"user": current})
            if path == "reports" or path.startswith("history/") or path == "submissions": return _json(self, {"items": reports, "submissions": reports, "total": len(reports), "hasMore": False, "nextCursor": None, "previousCursor": None, "filters": {}})
            if path == "export.pdf": return _json(self, {"error": {"code": "qa_fixture_failure"}}, 503)
            if path.endswith("/activity"): return _json(self, {"submission": reports[0], "items": [], "events": [], "hasMore": False})
            if path.endswith("/receipts"): return _json(self, {"items": [], "count": 0, "maxCount": 10, "canUpload": True})
            if path == "cash/insights": return _json(self, {"balanceIdr": "100000", "daily": [], "monthly": [], "topExpenses": [], "recentTopups": [], "summary": {"incomingIdr": "100000", "outgoingIdr": "0"}, "alerts": []})
            return _json(self, {})
        def do_POST(self):  # noqa: N802
            if urlsplit(self.path).path == "/api/logout":
                return _json(self, {"ok": True})
            return self._reject_write()
        def _reject_write(self): return _json(self, {"error": {"code": "qa_read_only", "message": "Simulasi lokal: tidak ada data yang disimpan."}}, 503)
        do_PUT = lambda self: self._reject_write()  # noqa: E731
        do_PATCH = lambda self: self._reject_write()  # noqa: E731
        do_DELETE = lambda self: self._reject_write()  # noqa: E731
    return FixtureHandler


def serve_in_thread(host="127.0.0.1", port=0, site=SITE):
    server = ThreadingHTTPServer((host, port), make_handler(pathlib.Path(site))); thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start(); return server, thread


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--host", default="127.0.0.1"); parser.add_argument("--port", type=int, default=8769); parser.add_argument("--site", type=pathlib.Path, default=SITE); args = parser.parse_args(); server, _ = serve_in_thread(args.host, args.port, args.site); print(f"QA_FIXTURE_URL=http://{args.host}:{server.server_port}", flush=True); server.serve_forever()
