PRAGMA foreign_keys = ON;

CREATE TABLE cash_reconciliations (
  id TEXT PRIMARY KEY,
  period_ym TEXT NOT NULL CHECK (period_ym GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  as_of TEXT NOT NULL,
  ledger_cutoff_id INTEGER NOT NULL CHECK (ledger_cutoff_id >= 0),
  ledger_balance_idr TEXT NOT NULL CHECK (length(ledger_balance_idr) BETWEEN 1 AND 16 AND ledger_balance_idr NOT GLOB '*[^0-9]*'),
  account_balance_idr TEXT NOT NULL CHECK (length(account_balance_idr) BETWEEN 1 AND 16 AND account_balance_idr NOT GLOB '*[^0-9]*'),
  physical_cash_idr INTEGER NOT NULL CHECK (typeof(physical_cash_idr) = 'integer' AND physical_cash_idr >= 0 AND physical_cash_idr <= 9007199254740991),
  discrepancy_idr TEXT NOT NULL CHECK (discrepancy_idr GLOB '-[0-9]*' OR discrepancy_idr GLOB '[0-9]*'),
  manager_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL CHECK (length(note) BETWEEN 3 AND 1000),
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  UNIQUE (manager_id, idempotency_key)
);
CREATE INDEX idx_cash_reconciliations_period ON cash_reconciliations(period_ym, created_at DESC, id DESC);
CREATE INDEX idx_cash_reconciliations_created ON cash_reconciliations(created_at DESC, id DESC);

CREATE TRIGGER cash_reconciliation_creation_audit
AFTER INSERT ON cash_reconciliations
BEGIN
  INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
  VALUES (
    NEW.manager_id,
    'cash.reconciled',
    'cash_reconciliation',
    NEW.id,
    json_object(
      'period_ym', NEW.period_ym,
      'as_of', NEW.as_of,
      'ledger_cutoff_id', NEW.ledger_cutoff_id,
      'ledger_balance_idr', NEW.ledger_balance_idr,
      'account_balance_idr', NEW.account_balance_idr,
      'physical_cash_idr', NEW.physical_cash_idr,
      'discrepancy_idr', NEW.discrepancy_idr,
      'note', NEW.note,
      'idempotency_key', NEW.idempotency_key,
      'payload_hash', NEW.payload_hash
    ),
    NEW.created_at
  );
END;

CREATE TRIGGER cash_reconciliations_append_only_update
BEFORE UPDATE ON cash_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'cash_reconciliations_are_append_only');
END;
CREATE TRIGGER cash_reconciliations_append_only_delete
BEFORE DELETE ON cash_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'cash_reconciliations_are_append_only');
END;
