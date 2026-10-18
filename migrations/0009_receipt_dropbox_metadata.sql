-- Dropbox metadata for newly uploaded receipt files only; legacy blobs remain untouched.
CREATE TABLE IF NOT EXISTS receipt_dropbox_metadata (
  receipt_id TEXT PRIMARY KEY REFERENCES submission_receipts(id),
  dropbox_path TEXT NOT NULL UNIQUE,
  file_id TEXT,
  public_url TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','ready')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((state = 'pending' AND file_id IS NULL AND public_url IS NULL AND completed_at IS NULL) OR
         (state = 'ready' AND file_id IS NOT NULL AND public_url IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (dropbox_path LIKE '/Pengajuan Pangsuma/%'),
  CHECK (public_url IS NULL OR public_url LIKE 'https://www.dropbox.com/scl/fi/%' OR public_url LIKE 'https://www.dropbox.com/s/%')
);
CREATE INDEX IF NOT EXISTS idx_receipt_dropbox_state ON receipt_dropbox_metadata(state, created_at);

-- The server creates pending metadata atomically with each new receipt.
-- Guards enforce an active submission owner, exact timestamp, and canonical path.
CREATE TRIGGER IF NOT EXISTS receipt_dropbox_metadata_insert_guard
BEFORE INSERT ON receipt_dropbox_metadata
WHEN NEW.state <> 'pending' OR NOT EXISTS (
  SELECT 1 FROM submission_receipts r JOIN submissions s ON s.id=r.submission_id
  JOIN users u ON u.id=r.uploaded_by
  WHERE r.id=NEW.receipt_id AND r.created_at=NEW.created_at AND r.uploaded_by=s.created_by
    AND u.is_active=1 AND u.role IN ('user','manager')
    AND NEW.dropbox_path = '/Pengajuan Pangsuma/' || r.id || CASE WHEN r.mime_type='image/png' THEN '.png' ELSE '.jpg' END
)
BEGIN SELECT RAISE(ABORT, 'receipt_dropbox_fresh_owner_required'); END;

CREATE TRIGGER IF NOT EXISTS receipt_dropbox_identity_immutable
BEFORE UPDATE ON receipt_dropbox_metadata
WHEN NEW.receipt_id <> OLD.receipt_id OR NEW.dropbox_path <> OLD.dropbox_path OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'receipt_dropbox_identity_immutable'); END;
CREATE TRIGGER IF NOT EXISTS receipt_dropbox_ready_immutable
BEFORE UPDATE ON receipt_dropbox_metadata
WHEN OLD.state = 'ready' AND (NEW.state <> OLD.state OR NEW.file_id IS NOT OLD.file_id OR NEW.public_url IS NOT OLD.public_url OR NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT, 'receipt_dropbox_ready_immutable'); END;
CREATE TRIGGER IF NOT EXISTS receipt_dropbox_active_owner
BEFORE UPDATE ON receipt_dropbox_metadata
WHEN NEW.state = 'ready' AND NOT EXISTS (
  SELECT 1 FROM submission_receipts r JOIN submissions s ON s.id=r.submission_id JOIN users u ON u.id=r.uploaded_by
  WHERE r.id=NEW.receipt_id AND r.uploaded_by=s.created_by AND u.is_active=1 AND u.role IN ('user','manager')
)
BEGIN SELECT RAISE(ABORT, 'receipt_dropbox_active_owner_required'); END;
CREATE TRIGGER IF NOT EXISTS receipt_dropbox_ready_audit
AFTER UPDATE ON receipt_dropbox_metadata
WHEN OLD.state = 'pending' AND NEW.state = 'ready'
BEGIN
  INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
  SELECT r.uploaded_by, 'submission.receipt_dropbox_ready', 'receipt', r.id,
    json_object('receipt_id', r.id, 'state', 'ready'), NEW.completed_at
  FROM submission_receipts r WHERE r.id=NEW.receipt_id;
END;
CREATE TRIGGER IF NOT EXISTS receipt_dropbox_delete_guard
BEFORE DELETE ON receipt_dropbox_metadata
BEGIN SELECT RAISE(ABORT, 'receipt_dropbox_immutable'); END;
