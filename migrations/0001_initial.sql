PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  position TEXT NOT NULL DEFAULT '' CHECK (length(position) <= 80),
  role TEXT NOT NULL CHECK (role IN ('manager', 'user')),
  password_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_users_active_role ON users(is_active, role);

CREATE TABLE IF NOT EXISTS sessions (
  session_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS cash_accounts (
  id TEXT PRIMARY KEY CHECK (id = 'operational'),
  balance_idr INTEGER NOT NULL CHECK (balance_idr >= 0),
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO cash_accounts (id, balance_idr, updated_at)
VALUES ('operational', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT CHECK (payload_hash IS NULL OR length(payload_hash) = 64),
  created_by TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('petty_cash', 'finance_request')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'sent')),
  amount_idr INTEGER NOT NULL CHECK (amount_idr > 0),
  date TEXT NOT NULL CHECK (length(date) = 10),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 3 AND 150),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  decision_reason TEXT NOT NULL DEFAULT '' CHECK (length(decision_reason) <= 500),
  resolved_by TEXT REFERENCES users(id),
  sent_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (created_by, idempotency_key),
  CHECK (
    (type = 'petty_cash' AND status IN ('pending', 'approved', 'rejected')) OR
    (type = 'finance_request' AND status IN ('pending', 'approved', 'rejected', 'sent'))
  )
);
CREATE INDEX IF NOT EXISTS idx_submissions_owner_date ON submissions(created_by, date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_status_date ON submissions(status, date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_type_status ON submissions(type, status, created_at DESC);

CREATE TABLE IF NOT EXISTS cash_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN ('opening_balance', 'petty_cash_approval')),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_idr INTEGER NOT NULL CHECK (amount_idr >= 0),
  balance_after_idr INTEGER NOT NULL CHECK (balance_after_idr >= 0),
  submission_id TEXT REFERENCES submissions(id),
  actor_id TEXT REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_ledger_submission_once
  ON cash_ledger(submission_id) WHERE submission_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_ledger_opening_once
  ON cash_ledger(event_type) WHERE event_type = 'opening_balance' AND amount_idr > 0;
CREATE INDEX IF NOT EXISTS idx_cash_ledger_created ON cash_ledger(created_at DESC);
INSERT OR IGNORE INTO cash_ledger
  (id, event_type, direction, amount_idr, balance_after_idr, note, created_at)
VALUES
  (1, 'opening_balance', 'credit', 0, 0,
   'Saldo awal ditetapkan nol sampai pemilik mengonfirmasi angka aktual.',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  rate_key TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 0 AND 1000000),
  window_started_ms INTEGER NOT NULL CHECK (window_started_ms >= 0),
  blocked_until_ms INTEGER NOT NULL DEFAULT 0 CHECK (blocked_until_ms >= 0)
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_expiry
  ON login_attempts(blocked_until_ms, window_started_ms);

CREATE TRIGGER IF NOT EXISTS submissions_user_only
BEFORE INSERT ON submissions
WHEN COALESCE((SELECT role FROM users WHERE id = NEW.created_by), '') <> 'user'
BEGIN
  SELECT RAISE(ABORT, 'only_user_accounts_may_submit');
END;

CREATE TRIGGER IF NOT EXISTS submissions_content_immutable
BEFORE UPDATE ON submissions
WHEN OLD.created_by IS NOT NEW.created_by
  OR OLD.type IS NOT NEW.type
  OR OLD.amount_idr IS NOT NEW.amount_idr
  OR OLD.date IS NOT NEW.date
  OR OLD.description IS NOT NEW.description
  OR OLD.note IS NOT NEW.note
  OR OLD.idempotency_key IS NOT NEW.idempotency_key
  OR OLD.payload_hash IS NOT NEW.payload_hash
BEGIN
  SELECT RAISE(ABORT, 'submitted_content_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS submissions_status_transition_guard
BEFORE UPDATE OF status ON submissions
WHEN OLD.status <> NEW.status
  AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')) OR
    (OLD.status = 'approved' AND NEW.status = 'sent' AND OLD.type = 'finance_request')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_submission_status_transition');
END;

CREATE TRIGGER IF NOT EXISTS submissions_no_self_approval
BEFORE UPDATE OF status ON submissions
WHEN OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')
  AND NEW.resolved_by = OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'self_decision_not_allowed');
END;

CREATE TRIGGER IF NOT EXISTS petty_cash_balance_guard
BEFORE UPDATE OF status ON submissions
WHEN OLD.type = 'petty_cash' AND OLD.status = 'pending' AND NEW.status = 'approved'
BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT balance_idr FROM cash_accounts WHERE id = 'operational'), 0) < OLD.amount_idr
    THEN RAISE(ABORT, 'insufficient_petty_cash_balance')
  END;
END;

CREATE TRIGGER IF NOT EXISTS petty_cash_approval_ledger
AFTER UPDATE OF status ON submissions
WHEN OLD.type = 'petty_cash' AND OLD.status = 'pending' AND NEW.status = 'approved'
BEGIN
  UPDATE cash_accounts
    SET balance_idr = balance_idr - OLD.amount_idr,
        updated_at = NEW.updated_at
    WHERE id = 'operational';
  INSERT INTO cash_ledger
    (event_type, direction, amount_idr, balance_after_idr, submission_id, actor_id, note, created_at)
  VALUES
    ('petty_cash_approval', 'debit', OLD.amount_idr,
     (SELECT balance_idr FROM cash_accounts WHERE id = 'operational'),
     OLD.id, NEW.updated_by, OLD.description, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS submission_status_audit
AFTER UPDATE OF status ON submissions
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
  VALUES (
    NEW.updated_by,
    'submission.status_changed',
    'submission',
    NEW.id,
    json_object('from', OLD.status, 'to', NEW.status, 'type', NEW.type,
                'amount_idr', OLD.amount_idr, 'reason', NEW.decision_reason),
    NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS user_deactivation_audit
AFTER UPDATE OF is_active ON users
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
  VALUES (NEW.updated_by, 'user.deactivated', 'user', NEW.id,
          json_object('active', 0), NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS user_password_change_audit
AFTER UPDATE OF password_hash ON users
WHEN OLD.password_hash IS NOT NEW.password_hash AND NEW.updated_by IS NOT NULL
BEGIN
  INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
  VALUES (NEW.updated_by, 'user.password_changed', 'user', NEW.id,
          json_object('must_change_password', NEW.must_change_password), NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS cash_ledger_append_only_update
BEFORE UPDATE ON cash_ledger
BEGIN
  SELECT RAISE(ABORT, 'cash_ledger_is_append_only');
END;
CREATE TRIGGER IF NOT EXISTS cash_ledger_append_only_delete
BEFORE DELETE ON cash_ledger
BEGIN
  SELECT RAISE(ABORT, 'cash_ledger_is_append_only');
END;
CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events_are_append_only');
END;
CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events_are_append_only');
END;
