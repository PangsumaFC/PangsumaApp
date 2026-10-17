PRAGMA foreign_keys = ON;

DROP TRIGGER IF EXISTS submissions_user_only;

CREATE TRIGGER IF NOT EXISTS submissions_authenticated_account_only
BEFORE INSERT ON submissions
WHEN COALESCE((SELECT is_active FROM users WHERE id = NEW.created_by), 0) <> 1
  OR COALESCE((SELECT role FROM users WHERE id = NEW.created_by), '') NOT IN ('user', 'manager')
BEGIN
  SELECT RAISE(ABORT, 'only_active_user_or_manager_accounts_may_submit');
END;
