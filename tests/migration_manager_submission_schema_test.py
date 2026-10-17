#!/usr/bin/env python3
"""Regression coverage for the local 0004 manager-submission migration."""

from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class ManagerSubmissionMigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self._apply("0001_initial.sql")
        self.db.executemany(
            """
            INSERT INTO users
              (id, name, email, position, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("user-1", "Staff User", "user@example.test", "Staff", "user", "2026-01-01", "2026-01-01"),
                ("manager-1", "Manager", "manager@example.test", "Manager", "manager", "2026-01-01", "2026-01-01"),
                ("inactive-manager", "Inactive Manager", "inactive@example.test", "Manager", "manager", "2026-01-01", "2026-01-01"),
            ],
        )
        self.db.execute("UPDATE users SET is_active = 0 WHERE id = 'inactive-manager'")
        self._insert_submission("seeded-user-submission", "user-1", "seed-user")
        self._apply("0002_passkey_auth.sql")
        self._apply("0003_user_profiles.sql")
        self.db.execute(
            "INSERT INTO user_profiles (user_id, nickname, dashboard_position, quote, photo, photo_mime) VALUES (?, ?, ?, ?, ?, ?)",
            ("user-1", "Seed", "Treasurer", "Keep the books clear.", bytes([1, 2, 3]), "image/png"),
        )
        self.db.execute(
            "UPDATE cash_accounts SET balance_idr = 250000, updated_at = '2026-01-02' WHERE id = 'operational'"
        )
        self.db.execute(
            "INSERT INTO cash_ledger (event_type, direction, amount_idr, balance_after_idr, actor_id, note, created_at) VALUES ('opening_balance', 'credit', 250000, 250000, 'manager-1', 'Seeded ledger', '2026-01-02')"
        )
        self.db.execute(
            "INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            ("manager-1", "seed.audit", "test", "seed-1", '{"seed":true}', "2026-01-02"),
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _apply(self, filename):
        self.db.executescript((MIGRATIONS / filename).read_text())

    def _insert_submission(self, submission_id, creator_id, key):
        self.db.execute(
            """
            INSERT INTO submissions
              (id, idempotency_key, created_by, type, amount_idr, date,
               description, note, created_at, updated_at)
            VALUES (?, ?, ?, 'finance_request', 10000, '2026-01-03',
                    'Valid seeded request', '', '2026-01-03', '2026-01-03')
            """,
            (submission_id, key, creator_id),
        )

    def _state(self):
        return {
            "users": self.db.execute(
                "SELECT id, role, is_active FROM users ORDER BY id"
            ).fetchall(),
            "profiles": self.db.execute(
                "SELECT user_id, nickname, dashboard_position, quote, photo, photo_mime, version FROM user_profiles ORDER BY user_id"
            ).fetchall(),
            "cash": self.db.execute(
                "SELECT id, balance_idr, updated_at FROM cash_accounts"
            ).fetchall(),
            "submissions": self.db.execute(
                "SELECT id, created_by, status, amount_idr FROM submissions ORDER BY id"
            ).fetchall(),
            "ledger": self.db.execute(
                "SELECT id, event_type, direction, amount_idr, balance_after_idr, submission_id, actor_id FROM cash_ledger ORDER BY id"
            ).fetchall(),
            "audit": self.db.execute(
                "SELECT id, actor_id, action, entity_type, entity_id, details_json, created_at FROM audit_events ORDER BY id"
            ).fetchall(),
        }

    def test_old_trigger_rejects_manager_before_0004(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self._insert_submission("manager-before-0004", "manager-1", "before-manager")

    def test_0004_allows_active_manager_and_user_and_preserves_state(self):
        before = self._state()
        self._apply("0004_manager_submissions.sql")
        self.assertEqual(self._state(), before, "schema migration must not change any seeded row")

        self._insert_submission("manager-after-0004", "manager-1", "after-manager")
        self._insert_submission("user-after-0004", "user-1", "after-user")
        self.db.commit()

        after = self._state()
        for table in ("users", "profiles", "cash", "ledger", "audit"):
            self.assertEqual(after[table], before[table], table)
        self.assertIn(before["submissions"][0], after["submissions"])
        self.assertIn(("manager-after-0004", "manager-1", "pending", 10000), after["submissions"])
        self.assertIn(("user-after-0004", "user-1", "pending", 10000), after["submissions"])
        self.assertEqual(len(after["submissions"]), len(before["submissions"]) + 2)

    def test_0004_rejects_inactive_creator_and_keeps_self_decision_block(self):
        self._apply("0004_manager_submissions.sql")
        with self.assertRaises(sqlite3.IntegrityError):
            self._insert_submission("inactive-manager-submission", "inactive-manager", "inactive-manager")

        self._insert_submission("self-decision-submission", "manager-1", "self-decision")
        for status in ("approved", "rejected"):
            with self.assertRaisesRegex(sqlite3.IntegrityError, "self_decision_not_allowed"):
                self.db.execute(
                    "UPDATE submissions SET status = ?, resolved_by = 'manager-1', updated_by = 'manager-1', updated_at = '2026-01-04' WHERE id = 'self-decision-submission'",
                    (status,),
                )


if __name__ == "__main__":
    unittest.main()
