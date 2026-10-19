-- Request numbers are reserved before submission insertion. This migration is
-- intentionally ordered so legacy rows are backfilled before immutability triggers.
ALTER TABLE submissions ADD COLUMN request_number TEXT;

CREATE TABLE IF NOT EXISTS request_number_sequences (
  type TEXT NOT NULL CHECK (type IN ('petty_cash', 'finance_request')),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  next_value INTEGER NOT NULL CHECK (next_value BETWEEN 1 AND 1000000),
  PRIMARY KEY (type, year, month)
);

CREATE TABLE IF NOT EXISTS request_number_reservations (
  submission_id TEXT PRIMARY KEY,
  request_number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('petty_cash', 'finance_request')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 999999),
  UNIQUE (created_by, idempotency_key),
  CHECK (request_number = CASE type WHEN 'petty_cash' THEN 'PC' ELSE 'RF' END ||
         printf('%02d', month) || printf('%04d', year) || printf('%06d', sequence))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_number_partition_sequence
  ON request_number_reservations(type, year, month, sequence);

-- Deterministic legacy backfill. Existing request_number values are untouched;
-- only rows lacking one are assigned, in Jakarta creation month and (created_at,id)
-- order. No status, balance, ledger, audit, or other submission fields are changed.
INSERT INTO request_number_reservations
  (submission_id, request_number, type, created_by, created_at, idempotency_key,
   payload_hash, year, month, sequence)
SELECT s.id,
       CASE s.type WHEN 'petty_cash' THEN 'PC' ELSE 'RF' END ||
       printf('%02d', CAST(strftime('%m', s.created_at, '+7 hours') AS INTEGER)) ||
       strftime('%Y', s.created_at, '+7 hours') || printf('%06d', ranked.sequence),
       s.type, s.created_by, s.created_at, s.idempotency_key, s.payload_hash,
       CAST(strftime('%Y', s.created_at, '+7 hours') AS INTEGER),
       CAST(strftime('%m', s.created_at, '+7 hours') AS INTEGER), ranked.sequence
FROM submissions s
JOIN (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY type, strftime('%Y', created_at, '+7 hours'), strftime('%m', created_at, '+7 hours')
    ORDER BY created_at, id
  ) AS sequence
  FROM submissions
  WHERE request_number IS NULL
) ranked ON ranked.id = s.id
WHERE s.request_number IS NULL;

UPDATE submissions
SET request_number = (
  SELECT r.request_number FROM request_number_reservations r WHERE r.submission_id = submissions.id
)
WHERE request_number IS NULL
  AND EXISTS (SELECT 1 FROM request_number_reservations r WHERE r.submission_id = submissions.id);

INSERT OR REPLACE INTO request_number_sequences(type, year, month, next_value)
SELECT type, year, month, MAX(sequence) + 1
FROM request_number_reservations
GROUP BY type, year, month;

-- New reservations are committed before the submission insert and are never deleted.
CREATE TRIGGER IF NOT EXISTS submissions_request_number_required
BEFORE INSERT ON submissions
WHEN NEW.request_number IS NULL OR NOT EXISTS (
  SELECT 1 FROM request_number_reservations r
   WHERE r.submission_id = NEW.id AND r.request_number = NEW.request_number
     AND r.type = NEW.type AND r.created_by = NEW.created_by
     AND r.created_at = NEW.created_at AND r.idempotency_key = NEW.idempotency_key
     AND r.payload_hash IS NEW.payload_hash
)
BEGIN SELECT RAISE(ABORT, 'request_number_reservation_required'); END;

CREATE TRIGGER IF NOT EXISTS submissions_request_number_immutable
BEFORE UPDATE ON submissions
WHEN OLD.request_number IS NOT NEW.request_number
BEGIN SELECT RAISE(ABORT, 'request_number_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS request_number_reservations_immutable
BEFORE UPDATE ON request_number_reservations
WHEN OLD.submission_id IS NOT NEW.submission_id OR OLD.request_number IS NOT NEW.request_number
  OR OLD.type IS NOT NEW.type OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at OR OLD.idempotency_key IS NOT NEW.idempotency_key
  OR OLD.payload_hash IS NOT NEW.payload_hash
  OR OLD.year IS NOT NEW.year OR OLD.month IS NOT NEW.month OR OLD.sequence IS NOT NEW.sequence
BEGIN SELECT RAISE(ABORT, 'request_number_reservation_immutable'); END;

CREATE TRIGGER IF NOT EXISTS request_number_reservations_no_delete
BEFORE DELETE ON request_number_reservations
BEGIN SELECT RAISE(ABORT, 'request_number_reservation_is_immutable'); END;
