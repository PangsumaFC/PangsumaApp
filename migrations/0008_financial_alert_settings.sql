-- Global manager-owned financial alert preferences; NULL means unconfigured.
CREATE TABLE IF NOT EXISTS financial_alert_settings (
  id TEXT PRIMARY KEY CHECK (id = 'operational'),
  minimum_cash_idr INTEGER CHECK (minimum_cash_idr IS NULL OR (typeof(minimum_cash_idr) = 'integer' AND minimum_cash_idr BETWEEN 0 AND 9007199254740991)),
  pending_max_days INTEGER CHECK (pending_max_days IS NULL OR (typeof(pending_max_days) = 'integer' AND pending_max_days BETWEEN 1 AND 3650)),
  version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(version) = 'integer' AND version >= 0),
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL DEFAULT 'initial',
  payload_hash TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO financial_alert_settings (id, minimum_cash_idr, pending_max_days, version, updated_by, updated_at)
VALUES ('operational', NULL, NULL, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE IF NOT EXISTS financial_settings_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  version_before INTEGER NOT NULL,
  version_after INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_financial_settings_changes_created ON financial_settings_changes(created_at, id);

CREATE TRIGGER IF NOT EXISTS financial_settings_manager_guard
BEFORE UPDATE OF minimum_cash_idr, pending_max_days, version, updated_by, updated_at, idempotency_key, payload_hash ON financial_alert_settings
WHEN NEW.updated_by IS NOT NULL AND COALESCE((SELECT role FROM users WHERE id=NEW.updated_by), '') <> 'manager'
BEGIN SELECT RAISE(ABORT, 'financial_settings_manager_required'); END;

CREATE TRIGGER IF NOT EXISTS financial_settings_audit_update
AFTER UPDATE OF minimum_cash_idr, pending_max_days, version, updated_by, updated_at, idempotency_key, payload_hash ON financial_alert_settings
WHEN OLD.minimum_cash_idr IS NOT NEW.minimum_cash_idr OR OLD.pending_max_days IS NOT NEW.pending_max_days
BEGIN
  INSERT INTO financial_settings_changes (manager_id,idempotency_key,payload_hash,before_json,after_json,version_before,version_after,created_at)
  VALUES (NEW.updated_by,NEW.idempotency_key,NEW.payload_hash,
    json_object('minimumCashIdr',OLD.minimum_cash_idr,'pendingMaxDays',OLD.pending_max_days,'version',OLD.version,'updatedBy',OLD.updated_by,'updatedAt',OLD.updated_at),
    json_object('minimumCashIdr',NEW.minimum_cash_idr,'pendingMaxDays',NEW.pending_max_days,'version',NEW.version,'updatedBy',NEW.updated_by,'updatedAt',NEW.updated_at),
    OLD.version,NEW.version,NEW.updated_at);
  INSERT INTO audit_events (actor_id,action,entity_type,entity_id,details_json,created_at)
  VALUES (NEW.updated_by,'financial.settings_updated','financial_settings',NEW.id,
    json_object('before',json_object('minimumCashIdr',OLD.minimum_cash_idr,'pendingMaxDays',OLD.pending_max_days,'version',OLD.version),
                'after',json_object('minimumCashIdr',NEW.minimum_cash_idr,'pendingMaxDays',NEW.pending_max_days,'version',NEW.version)),NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS financial_settings_append_only_update
BEFORE UPDATE ON financial_settings_changes BEGIN SELECT RAISE(ABORT, 'financial_settings_changes_are_append_only'); END;
CREATE TRIGGER IF NOT EXISTS financial_settings_append_only_delete
BEFORE DELETE ON financial_settings_changes BEGIN SELECT RAISE(ABORT, 'financial_settings_changes_are_append_only'); END;

CREATE INDEX IF NOT EXISTS idx_submissions_duplicate_type_amount_date_id ON submissions(type, amount_idr, date, id);
CREATE INDEX IF NOT EXISTS idx_submissions_pending_created ON submissions(status, created_at, id);
