"""Offline schema regression. Every database is SQLite :memory:, never a service."""
from pathlib import Path
import re
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


class DeploySchemaProbeTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        # Exercise the actual SQL passed to Wrangler, not a test-only copy.
        workflow = (ROOT / ".github/workflows/deploy.yml").read_text()
        commands = re.findall(r'--command "([^"\n]+)"', workflow)
        commands = [sql for sql in commands if sql.startswith("SELECT p.user_id,")]
        self.assertEqual(len(commands), 1, "Expected one inline auth/profile schema probe")
        self.query = commands[0]

    def migrate(self, *filenames):
        for filename in filenames:
            self.db.executescript((ROOT / "migrations" / filename).read_text())

    def migrate_all(self):
        self.migrate("0001_initial.sql", "0002_passkey_auth.sql", "0003_user_profiles.sql")

    def probe(self):
        self.db.execute("PRAGMA query_only = ON")
        return self.db.execute(self.query).fetchall()

    def test_empty_fully_migrated_database_passes(self):
        self.migrate_all()
        self.assertEqual(self.probe(), [])

    def test_profiles_present_but_auth_migration_missing_fails(self):
        self.migrate("0001_initial.sql", "0003_user_profiles.sql")
        with self.assertRaisesRegex(sqlite3.OperationalError, "no such column"):
            self.probe()

    def test_each_missing_auth_column_fails_even_with_empty_tables(self):
        self.migrate_all()
        for table, column in (("sessions", "auth_method"), ("users", "webauthn_user_handle")):
            with self.subTest(table=table, column=column):
                self.db.execute("SAVEPOINT missing_column")
                if table == "users":
                    self.db.execute("DROP INDEX idx_users_webauthn_user_handle")
                self.db.execute(f'ALTER TABLE "{table}" DROP COLUMN "{column}"')
                try:
                    with self.assertRaisesRegex(sqlite3.OperationalError, "no such column"):
                        self.probe()
                finally:
                    self.db.execute("PRAGMA query_only = OFF")
                    self.db.execute("ROLLBACK TO missing_column")
                    self.db.execute("RELEASE missing_column")

    def test_missing_profile_migration_still_fails(self):
        self.migrate("0001_initial.sql", "0002_passkey_auth.sql")
        with self.assertRaisesRegex(sqlite3.OperationalError, "no such table"):
            self.probe()

    def test_partial_profile_schema_still_fails(self):
        self.migrate_all()
        self.db.execute("ALTER TABLE user_profiles DROP COLUMN photo_mime")
        with self.assertRaisesRegex(sqlite3.OperationalError, "no such column"):
            self.probe()

    def test_populated_database_returns_no_rows_and_is_unchanged(self):
        self.migrate_all()
        self.db.execute("""INSERT INTO users
            (id,name,email,role,created_at,updated_at)
            VALUES ('probe-user','Probe User','probe@example.test','user','2026-10-17','2026-10-17')""")
        self.db.execute("INSERT INTO user_profiles (user_id,nickname) VALUES ('probe-user','Local')")
        self.db.execute("""INSERT INTO sessions (session_hash,user_id,created_at,expires_at)
            VALUES ('probe-session','probe-user','2026-10-17','2099-01-01')""")
        before = list(self.db.iterdump())
        self.assertEqual(self.probe(), [])
        self.assertEqual(list(self.db.iterdump()), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
