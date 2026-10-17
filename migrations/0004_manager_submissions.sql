-- Allow active Manager accounts to submit their own requests, just like Users.
-- Keep the existing immutable-content, approval, balance, and audit triggers.
DROP TRIGGER IF EXISTS submissions_user_only;

CREATE TRIGGER IF NOT EXISTS submissions_active_account_only
BEFORE INSERT ON submissions
WHEN NOT EXISTS (
  SELECT 1 FROM users
  WHERE id = NEW.created_by AND is_active = 1 AND role IN ('user', 'manager')
)
BEGIN
  SELECT RAISE(ABORT, 'active_account_required_to_submit');
END;
