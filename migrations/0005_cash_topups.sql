PRAGMA foreign_keys = ON;

-- Rebuild only cash_ledger so the event_type CHECK admits cash_topup.
-- Explicitly preserve every existing row and its AUTOINCREMENT id.
DROP TRIGGER IF EXISTS cash_ledger_append_only_update;
DROP TRIGGER IF EXISTS cash_ledger_append_only_delete;
DROP TRIGGER IF EXISTS petty_cash_approval_ledger;

CREATE TABLE cash_ledger_rebuild (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN ('opening_balance', 'petty_cash_approval', 'cash_topup')),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_idr INTEGER NOT NULL CHECK (amount_idr >= 0),
  balance_after_idr INTEGER NOT NULL CHECK (balance_after_idr >= 0),
  submission_id TEXT REFERENCES submissions(id),
  actor_id TEXT REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  topup_id TEXT
);
INSERT INTO cash_ledger_rebuild
  (id, event_type, direction, amount_idr, balance_after_idr, submission_id, actor_id, note, created_at)
SELECT id, event_type, direction, amount_idr, balance_after_idr, submission_id, actor_id, note, created_at
FROM cash_ledger
ORDER BY id;
DROP TABLE cash_ledger;
ALTER TABLE cash_ledger_rebuild RENAME TO cash_ledger;

CREATE UNIQUE INDEX idx_cash_ledger_submission_once
  ON cash_ledger(submission_id) WHERE submission_id IS NOT NULL;
CREATE UNIQUE INDEX idx_cash_ledger_opening_once
  ON cash_ledger(event_type) WHERE event_type = 'opening_balance' AND amount_idr > 0;
CREATE UNIQUE INDEX idx_cash_ledger_topup_once
  ON cash_ledger(topup_id) WHERE topup_id IS NOT NULL;
CREATE INDEX idx_cash_ledger_created ON cash_ledger(created_at DESC);

CREATE TABLE cash_topups (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  amount_idr INTEGER NOT NULL CHECK (amount_idr > 0 AND amount_idr <= 9007199254740991),
  note TEXT NOT NULL CHECK (length(note) BETWEEN 3 AND 500),
  created_at TEXT NOT NULL,
  UNIQUE (manager_id, idempotency_key)
);
CREATE INDEX idx_cash_topups_created ON cash_topups(created_at DESC, id DESC);

CREATE TRIGGER cash_topup_balance_guard
BEFORE INSERT ON cash_topups
BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT balance_idr FROM cash_accounts WHERE id = 'operational'), 0) + NEW.amount_idr > 9007199254740991
    THEN RAISE(ABORT, 'cash_topup_balance_overflow')
  END;
END;

CREATE TRIGGER cash_topup_ledger_and_account
AFTER INSERT ON cash_topups
BEGIN
  UPDATE cash_accounts
    SET balance_idr = balance_idr + NEW.amount_idr,
        updated_at = NEW.created_at
    WHERE id = 'operational';
  INSERT INTO cash_ledger
    (event_type, direction, amount_idr, balance_after_idr, actor_id, note, created_at, topup_id)
  VALUES
    ('cash_topup', 'credit', NEW.amount_idr,
     (SELECT balance_idr FROM cash_accounts WHERE id = 'operational'),
     NEW.manager_id, NEW.note, NEW.created_at, NEW.id);
  INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
  VALUES
    (NEW.manager_id, 'cash.topup_created', 'cash_topup', NEW.id,
     json_object('amount_idr', NEW.amount_idr, 'note', NEW.note,
                 'balance_after_idr', (SELECT balance_idr FROM cash_accounts WHERE id = 'operational')),
     NEW.created_at);
END;

CREATE TRIGGER cash_topups_append_only_update
BEFORE UPDATE ON cash_topups
BEGIN
  SELECT RAISE(ABORT, 'cash_topups_are_append_only');
END;
CREATE TRIGGER cash_topups_append_only_delete
BEFORE DELETE ON cash_topups
BEGIN
  SELECT RAISE(ABORT, 'cash_topups_are_append_only');
END;
CREATE TRIGGER cash_ledger_append_only_update
BEFORE UPDATE ON cash_ledger
BEGIN
  SELECT RAISE(ABORT, 'cash_ledger_is_append_only');
END;
CREATE TRIGGER cash_ledger_append_only_delete
BEFORE DELETE ON cash_ledger
BEGIN
  SELECT RAISE(ABORT, 'cash_ledger_is_append_only');
END;
CREATE TRIGGER petty_cash_approval_ledger
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
