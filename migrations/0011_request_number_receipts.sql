-- Prerequisites: 0009_receipt_dropbox_metadata.sql and 0010_request_numbers.sql.
-- Only the insert guard changes. Existing paths, links, ownership and pending
-- jobs remain untouched; ready/identity/no-delete guards remain installed.
DROP TRIGGER IF EXISTS receipt_dropbox_metadata_insert_guard;
CREATE TRIGGER receipt_dropbox_metadata_insert_guard
BEFORE INSERT ON receipt_dropbox_metadata
WHEN NEW.state <> 'pending' OR NOT EXISTS (
  SELECT 1 FROM submission_receipts r JOIN submissions s ON s.id=r.submission_id
  JOIN users u ON u.id=r.uploaded_by
  JOIN request_number_reservations nr ON nr.submission_id=s.id AND nr.request_number=s.request_number
  WHERE r.id=NEW.receipt_id AND r.created_at=NEW.created_at AND r.uploaded_by=s.created_by
    AND u.is_active=1 AND u.role IN ('user','manager')
    AND ((r.mime_type='image/png' AND lower(r.filename) LIKE '%.png') OR
         (r.mime_type='image/jpeg' AND (lower(r.filename) LIKE '%.jpg' OR lower(r.filename) LIKE '%.jpeg')))
    AND NEW.dropbox_path = '/Pengajuan Pangsuma/' || s.request_number || '/' || r.id || '/' ||
      s.request_number ||
      CASE WHEN (SELECT COUNT(*) FROM submission_receipts WHERE submission_id=r.submission_id)>1
        THEN '-' || printf('%02d',(SELECT COUNT(*) FROM submission_receipts WHERE submission_id=r.submission_id)-1) ELSE '' END ||
      CASE WHEN r.mime_type='image/png' THEN '.png'
           WHEN lower(r.filename) LIKE '%.jpeg' THEN '.jpeg' ELSE '.jpg' END
)
BEGIN SELECT RAISE(ABORT, 'receipt_dropbox_fresh_owner_required'); END;
