-- Private, immutable receipt attachments for submissions.
CREATE TABLE IF NOT EXISTS submission_receipts (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 180),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
  bytes_blob BLOB NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 524288),
  width INTEGER NOT NULL CHECK (width > 0 AND width <= 4096),
  height INTEGER NOT NULL CHECK (height > 0 AND height <= 4096),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  UNIQUE (uploaded_by, idempotency_key),
  UNIQUE (submission_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_submission_receipts_submission_created
  ON submission_receipts(submission_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_submission_receipts_uploader_key
  ON submission_receipts(uploaded_by, idempotency_key);

CREATE TRIGGER IF NOT EXISTS submission_receipts_active_uploader
BEFORE INSERT ON submission_receipts
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.uploaded_by AND is_active = 1 AND role IN ('user','manager'))
BEGIN SELECT RAISE(ABORT, 'active_account_required_for_receipt'); END;

CREATE TRIGGER IF NOT EXISTS submission_receipts_max_ten
BEFORE INSERT ON submission_receipts
WHEN (SELECT COUNT(*) FROM submission_receipts WHERE submission_id = NEW.submission_id) >= 10
BEGIN SELECT RAISE(ABORT, 'submission_receipt_limit'); END;

CREATE TRIGGER IF NOT EXISTS submission_receipts_append_only_update
BEFORE UPDATE ON submission_receipts
BEGIN SELECT RAISE(ABORT, 'submission_receipts_are_append_only'); END;
CREATE TRIGGER IF NOT EXISTS submission_receipts_append_only_delete
BEFORE DELETE ON submission_receipts
BEGIN SELECT RAISE(ABORT, 'submission_receipts_are_append_only'); END;

CREATE TRIGGER IF NOT EXISTS submission_receipt_created_audit
AFTER INSERT ON submission_receipts
BEGIN
  INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
  VALUES (NEW.uploaded_by, 'submission.receipt_created', 'receipt', NEW.id,
    json_object('submission_id', NEW.submission_id, 'sha256', NEW.sha256, 'size_bytes', NEW.size_bytes,
                'mime_type', NEW.mime_type), NEW.created_at);
END;
