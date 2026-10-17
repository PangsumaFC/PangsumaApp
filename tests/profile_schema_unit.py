"""Offline schema regression. Every database is SQLite :memory:, never a service."""
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProfileSchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        for filename in ("0001_initial.sql", "0002_passkey_auth.sql"):
            self.db.executescript((ROOT / "migrations" / filename).read_text())
        self.db.execute("""INSERT INTO users
            (id,name,email,position,role,created_at,updated_at)
            VALUES ('local-user','Local User','local@example.test','Official Job','user','2026-10-17','2026-10-17')""")
        self.db.execute("""INSERT INTO submissions
            (id,idempotency_key,created_by,type,amount_idr,date,description,created_at,updated_at)
            VALUES ('report-1','key-1','local-user','finance_request',125000,'2026-10-17','Existing local report','2026-10-17','2026-10-17')""")
        self.db.commit()

    def migrate(self):
        self.db.executescript((ROOT / "migrations" / "0003_user_profiles.sql").read_text())

    def snapshot(self):
        tables = [row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'user_profiles' ORDER BY name")]
        return {table: self.db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() for table in tables}

    def test_additive_migration_and_profile_edit_preserve_existing_data(self):
        before = self.snapshot()
        self.migrate()
        self.db.execute("""INSERT INTO user_profiles (user_id,nickname,dashboard_position,quote)
            VALUES ('local-user','Nickname','Dashboard Only','Personal quote')""")
        self.db.execute("UPDATE user_profiles SET nickname='Updated',version=version+1 WHERE user_id='local-user' AND version=1")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.db.execute("SELECT balance_idr FROM cash_accounts").fetchone(), (0,))

    def test_photo_blob_accepts_128kib_and_rejects_one_byte_more(self):
        self.migrate()
        self.db.execute("INSERT INTO user_profiles (user_id,photo,photo_mime) VALUES ('local-user',?,'image/jpeg')", (bytes(131072),))
        self.assertEqual(self.db.execute("SELECT length(photo) FROM user_profiles").fetchone(), (131072,))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "CHECK constraint failed"):
            self.db.execute("UPDATE user_profiles SET photo=?", (bytes(131073),))
        self.assertEqual(self.db.execute("SELECT length(photo) FROM user_profiles").fetchone(), (131072,))

    def test_unmigrated_read_gate_fails_before_profile_select(self):
        query = "SELECT user_id,nickname,dashboard_position,quote,photo,photo_mime,version FROM user_profiles LIMIT 0"
        with self.assertRaisesRegex(sqlite3.OperationalError, "no such table"):
            self.db.execute(query)
        self.migrate()
        self.assertEqual(self.db.execute(query).fetchall(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
