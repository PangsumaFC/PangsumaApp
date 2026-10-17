"""Regression tests for manager submissions and the createSubmission DB batch."""
from pathlib import Path
import sqlite3
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class ManagerSubmissionSchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.apply("0001_initial.sql", "0002_passkey_auth.sql", "0003_user_profiles.sql")
        self.seed_accounts()

    def apply(self, *filenames):
        for filename in filenames:
            self.db.executescript((MIGRATIONS / filename).read_text())

    def seed_accounts(self):
        accounts = [
            ("manager", "Manager", "manager@example.test", "manager", 1),
            ("manager-2", "Second Manager", "manager2@example.test", "manager", 1),
            ("user", "User", "user@example.test", "user", 1),
            ("inactive-user", "Inactive User", "inactive-user@example.test", "user", 0),
            ("inactive-manager", "Inactive Manager", "inactive-manager@example.test", "manager", 0),
        ]
        self.db.executemany(
            """INSERT INTO users
               (id, name, email, role, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, '2026-10-18', '2026-10-18')""",
            accounts,
        )
        self.db.commit()

    def submission(self, submission_id, owner, kind="finance_request", amount=10000, key=None):
        self.db.execute(
            """INSERT INTO submissions
               (id, idempotency_key, created_by, type, amount_idr, date,
                description, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, '2026-10-18', ?, '2026-10-18', '2026-10-18')""",
            (submission_id, key or f"key-{submission_id}", owner, kind, amount, f"Request {submission_id}"),
        )

    def create_submission_batch(self, submission_id, owner, kind="finance_request", amount=10000, key=None):
        """Model createSubmission's insert + created audit + manager-only UPDATE atomically."""
        key = key or f"key-{submission_id}"
        if self.db.execute(
            "SELECT 1 FROM submissions WHERE created_by = ? AND idempotency_key = ?",
            (owner, key),
        ).fetchone():
            return False
        self.db.execute("SAVEPOINT create_submission")
        try:
            self.submission(submission_id, owner, kind, amount, key=key)
            self.db.execute(
                """INSERT INTO audit_events
                   (actor_id, action, entity_type, entity_id, details_json, created_at)
                   VALUES (?, 'submission.created', 'submission', ?, ?, ?)""",
                (owner, submission_id, f'{{"type":"{kind}","amountIdr":{amount}}}', "2026-10-18T02:00:00Z"),
            )
            if self.db.execute("SELECT role FROM users WHERE id = ?", (owner,)).fetchone()[0] == "manager":
                api_source = (ROOT / "functions/api/[[path]].js").read_text()
                create_source = api_source.split("async function createSubmission(", 1)[1].split("async function decideSubmission(", 1)[0]
                auto_update = re.search(r"statements\.push\(db\.prepare\(`(.*?)`\)", create_source, re.S)
                self.assertIsNotNone(auto_update)
                self.db.execute(
                    auto_update.group(1),
                    (owner, "2026-10-18T02:00:01Z", submission_id, owner),
                )
            self.db.execute("RELEASE SAVEPOINT create_submission")
            return True
        except Exception:
            self.db.execute("ROLLBACK TO SAVEPOINT create_submission")
            self.db.execute("RELEASE SAVEPOINT create_submission")
            raise

    def test_old_trigger_rejects_manager_then_migration_allows_active_accounts_only(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "only_user_accounts_may_submit"):
            self.submission("manager-before", "manager")
        self.apply("0004_manager_submissions.sql")
        self.submission("manager-after", "manager")
        self.submission("user-after", "user")
        self.db.commit()
        self.assertEqual(
            self.db.execute("SELECT created_by, status FROM submissions ORDER BY id").fetchall(),
            [("manager", "pending"), ("user", "pending")],
        )
        for account in ("inactive-user", "inactive-manager", "missing-account"):
            with self.subTest(account=account):
                with self.assertRaisesRegex(sqlite3.IntegrityError, "active_account_required_to_submit"):
                    self.submission(f"rejected-{account}", account)

    def test_0004_preserves_existing_rows_cash_and_audit(self):
        self.submission("existing", "user", amount=25000)
        self.db.execute("UPDATE cash_accounts SET balance_idr = 75000, updated_at = 'before-0004' WHERE id = 'operational'")
        self.db.execute(
            """INSERT INTO audit_events
               (actor_id, action, entity_type, entity_id, details_json, created_at)
               VALUES ('user', 'existing.action', 'submission', 'existing', '{}', 'before-0004')"""
        )
        self.db.commit()
        before = {table: self.db.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
                  for table in ("submissions", "cash_accounts", "cash_ledger", "audit_events")}
        self.apply("0004_manager_submissions.sql")
        after = {table: self.db.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
                 for table in ("submissions", "cash_accounts", "cash_ledger", "audit_events")}
        self.assertEqual(after, before)
        self.assertEqual(self.db.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'submissions_user_only'").fetchall(), [])
        self.assertEqual(self.db.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'submissions_active_account_only'").fetchall(), [("submissions_active_account_only",)])

    def test_self_decision_is_rejected_and_second_manager_can_approve_finance(self):
        self.apply("0004_manager_submissions.sql")
        self.submission("manager-finance", "manager")
        self.db.commit()
        for status, timestamp in (("approved", "2026-10-18T01:00:00Z"), ("rejected", "2026-10-18T01:01:00Z")):
            with self.assertRaisesRegex(sqlite3.IntegrityError, "self_decision_not_allowed"):
                self.db.execute("""UPDATE submissions SET status = ?, resolved_by = 'manager',
                   updated_by = 'manager', updated_at = ? WHERE id = 'manager-finance'""", (status, timestamp))
        self.db.execute("""UPDATE submissions SET status = 'approved', resolved_by = 'manager-2',
           updated_by = 'manager-2', updated_at = '2026-10-18T01:02:00Z' WHERE id = 'manager-finance'""")
        self.db.commit()
        self.assertEqual(self.db.execute("SELECT status, resolved_by FROM submissions WHERE id = 'manager-finance'").fetchone(), ("approved", "manager-2"))
        self.assertEqual(self.db.execute("SELECT action, actor_id, entity_id FROM audit_events WHERE entity_id = 'manager-finance'").fetchone(), ("submission.status_changed", "manager-2", "manager-finance"))

    def test_manager_batch_auto_approves_only_manager_and_aggregates_finance_paths(self):
        self.apply("0004_manager_submissions.sql")
        self.create_submission_batch("manager-finance", "manager")
        self.create_submission_batch("user-pending", "user")
        self.create_submission_batch("user-approved", "user")
        self.create_submission_batch("user-rejected", "user")
        self.db.execute("UPDATE submissions SET status='approved', resolved_by='manager-2', updated_by='manager-2', updated_at='2026-10-18T02:01:00Z' WHERE id='user-approved'")
        self.db.execute("UPDATE submissions SET status='rejected', resolved_by='manager-2', updated_by='manager-2', updated_at='2026-10-18T02:02:00Z' WHERE id='user-rejected'")
        self.db.execute("UPDATE cash_accounts SET balance_idr=50000 WHERE id='operational'")
        self.db.execute("""INSERT INTO cash_ledger(event_type,direction,amount_idr,balance_after_idr,actor_id,note,created_at)
            VALUES ('opening_balance','credit',50000,50000,'manager','Opening','2026-10-18T02:00:00Z')""")
        self.create_submission_batch("manager-petty", "manager", kind="petty_cash", amount=12500)
        self.db.commit()
        self.assertEqual(self.db.execute("SELECT status, resolved_by FROM submissions WHERE id='manager-finance'").fetchone(), ("approved", None))
        self.assertEqual(self.db.execute("SELECT status FROM submissions WHERE id='user-pending'").fetchone(), ("pending",))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM submissions WHERE type='finance_request' AND status='approved'").fetchone(), (2,))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM submissions WHERE type='finance_request' AND status='pending'").fetchone(), (1,))
        self.db.execute("UPDATE submissions SET status='sent', sent_by='manager-2', updated_by='manager-2', updated_at='2026-10-18T02:03:00Z' WHERE id='manager-finance'")
        self.db.commit()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM submissions WHERE type='finance_request' AND status='approved'").fetchone(), (1,))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM submissions WHERE type='finance_request' AND status='sent'").fetchone(), (1,))
        self.assertEqual(self.db.execute("SELECT status, resolved_by FROM submissions WHERE id='user-approved'").fetchone(), ("approved", "manager-2"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM audit_events WHERE action='submission.created'").fetchone(), (5,))

    def test_manager_batch_replay_is_idempotent_and_petty_cash_debits_once(self):
        self.apply("0004_manager_submissions.sql")
        self.db.execute("UPDATE cash_accounts SET balance_idr=50000 WHERE id='operational'")
        self.db.execute("""INSERT INTO cash_ledger(event_type,direction,amount_idr,balance_after_idr,actor_id,note,created_at)
            VALUES ('opening_balance','credit',50000,50000,'manager','Opening','2026-10-18T02:00:00Z')""")
        self.assertTrue(self.create_submission_batch("manager-petty", "manager", "petty_cash", 12500, key="replay-key"))
        self.assertFalse(self.create_submission_batch("different-id", "manager", "petty_cash", 12500, key="replay-key"))
        self.db.commit()
        self.assertEqual(self.db.execute("SELECT balance_idr FROM cash_accounts WHERE id='operational'").fetchone(), (37500,))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cash_ledger WHERE submission_id='manager-petty'").fetchone(), (1,))
        self.assertEqual(self.db.execute("SELECT resolved_by FROM submissions WHERE id='manager-petty'").fetchone(), (None,))

    def test_manager_batch_rolls_back_row_audit_and_ledger_on_zero_or_insufficient_balance(self):
        self.apply("0004_manager_submissions.sql")
        before_ledger = self.db.execute("SELECT COUNT(*) FROM cash_ledger").fetchone()[0]
        for submission_id, balance, amount in (("zero-balance", 0, 1), ("insufficient", 50, 100)):
            self.db.execute("UPDATE cash_accounts SET balance_idr = ? WHERE id = 'operational'", (balance,))
            with self.subTest(submission_id=submission_id):
                with self.assertRaisesRegex(sqlite3.IntegrityError, "insufficient_petty_cash_balance"):
                    self.create_submission_batch(submission_id, "manager", "petty_cash", amount)
                self.assertIsNone(self.db.execute("SELECT 1 FROM submissions WHERE id=?", (submission_id,)).fetchone())
                self.assertIsNone(self.db.execute("SELECT 1 FROM audit_events WHERE entity_id=?", (submission_id,)).fetchone())
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cash_ledger").fetchone()[0], before_ledger)
                self.assertEqual(self.db.execute("SELECT balance_idr FROM cash_accounts WHERE id = 'operational'").fetchone()[0], balance)

    def test_petty_cash_approval_still_debits_ledger_after_opening_balance(self):
        self.apply("0004_manager_submissions.sql")
        self.db.execute("UPDATE cash_accounts SET balance_idr = 50000, updated_at = '2026-10-18T02:00:00Z' WHERE id = 'operational'")
        self.db.execute("""INSERT INTO cash_ledger
               (event_type, direction, amount_idr, balance_after_idr, actor_id, note, created_at)
               VALUES ('opening_balance', 'credit', 50000, 50000, 'manager', 'Confirmed opening balance', '2026-10-18T02:00:00Z')""")
        self.submission("petty", "manager", kind="petty_cash", amount=12500)
        self.db.commit()
        self.db.execute("""UPDATE submissions SET status = 'approved', resolved_by = 'manager-2',
               updated_by = 'manager-2', updated_at = '2026-10-18T02:01:00Z' WHERE id = 'petty'""")
        self.db.commit()
        self.assertEqual(self.db.execute("SELECT balance_idr FROM cash_accounts WHERE id = 'operational'").fetchone(), (37500,))
        self.assertEqual(self.db.execute("SELECT event_type, direction, amount_idr, balance_after_idr, submission_id, actor_id FROM cash_ledger WHERE submission_id = 'petty'").fetchone(), ("petty_cash_approval", "debit", 12500, 37500, "petty", "manager-2"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
