import json, pathlib, sqlite3, subprocess, tempfile, unittest

ROOT = pathlib.Path(__file__).parents[1]
EVIDENCE = ROOT / 'tests' / 'fixtures' / 'request-numbers'
LEGACY = EVIDENCE / 'request-number-legacy-fixture.jsonl'
REPORT = EVIDENCE / 'request-number-legacy-dryrun.json'
COLLISION = EVIDENCE / 'request-number-legacy-collision.jsonl'
COLLISION_REPORT = EVIDENCE / 'request-number-legacy-collision-dryrun.json'


def apply_before_0010(db):
    for n in range(1, 10):
        stem = {
            1:'initial',2:'passkey_auth',3:'user_profiles',4:'manager_submissions',5:'cash_topups',
            6:'financial_controls',7:'submission_receipts',8:'financial_alert_settings',9:'receipt_dropbox_metadata'}[n]
        db.executescript((ROOT / 'migrations' / f'{n:04d}_{stem}.sql').read_text())


def add_user(db, ident, role='user', active=1):
    db.execute('INSERT INTO users(id,name,email,position,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
               (ident, ident, ident+'@local', 'Staff', role, active, '2028-01-01T00:00:00Z', '2028-01-01T00:00:00Z'))


class RequestNumberMigration(unittest.TestCase):
    def make_legacy(self):
        db = sqlite3.connect(':memory:')
        db.execute('PRAGMA foreign_keys=ON')
        apply_before_0010(db)
        add_user(db, 'user-a'); add_user(db, 'user-b'); add_user(db, 'manager-1', 'manager')
        rows = [
            ('s-pc-tie-b','k-pc-tie-b','user-a','petty_cash','approved',1200,'2028-01-02','pc tie b','2028-01-01T17:00:00Z'),
            ('s-pc-tie-a','k-pc-tie-a','user-a','petty_cash','pending',1300,'2028-01-03','pc tie a','2028-01-01T17:00:00Z'),
            ('s-pc-boundary','k-pc-boundary','user-b','petty_cash','pending',1400,'2028-02-01','pc boundary','2028-01-31T17:00:00Z'),
            ('s-rf-boundary','k-rf-boundary','user-a','finance_request','sent',2200,'2028-02-01','rf boundary','2028-01-31T17:00:00Z'),
            ('s-rf-feb','k-rf-feb','user-a','finance_request','pending',2300,'2028-02-02','rf feb','2028-02-01T00:00:00Z'),
            ('s-rf-year','k-rf-year','user-b','finance_request','rejected',2400,'2029-01-01','rf year','2028-12-31T17:00:00Z'),
            ('s-pc-year','k-pc-year','user-b','petty_cash','pending',1500,'2029-01-01','pc year','2028-12-31T16:59:59Z'),
            ('s-rf-later','k-rf-later','manager-1','finance_request','approved',2500,'2029-03-01','rf later','2029-02-28T17:00:00Z'),
            ('s-pc-later','k-pc-later','user-a','petty_cash','pending',1600,'2029-03-02','pc later','2029-03-01T00:00:00Z'),
        ]
        for row in rows:
            db.execute('INSERT INTO submissions(id,idempotency_key,created_by,type,status,amount_idr,date,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', row + (row[-1],))
        # Existing financial state and receipt/dropbox metadata must remain byte-for-byte unchanged.
        db.execute("UPDATE cash_accounts SET balance_idr=777700,updated_at='2028-02-02T00:00:00Z'")
        db.execute("INSERT INTO cash_ledger(event_type,direction,amount_idr,balance_after_idr,actor_id,note,created_at) VALUES ('cash_topup','credit',777700,777700,'manager-1','seed','2028-02-02T00:00:00Z')")
        db.execute("INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details_json,created_at) VALUES ('user-a','submission.created','submission','s-pc-tie-a','{\"seed\":true}','2028-01-01T17:00:00Z')")
        receipt = ('receipt-1','s-pc-tie-a','user-a','seed.png','image/png',b'png',3,1,1,'a'*64,'2028-01-01T17:01:00Z','receipt-key','b'*64)
        db.execute('INSERT INTO submission_receipts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', receipt)
        db.execute("INSERT INTO receipt_dropbox_metadata(receipt_id,dropbox_path,state,created_at) VALUES ('receipt-1','/Pengajuan Pangsuma/receipt-1.png','pending','2028-01-01T17:01:00Z')")
        db.commit()
        return db, rows

    def snapshot(self, db):
        tables = ['submissions','cash_accounts','cash_ledger','audit_events','submission_receipts','receipt_dropbox_metadata']
        result = {}
        for table in tables:
            result[table] = [list(r) for r in db.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall()]
        return result

    def test_0010_0011_only_add_numbering_and_preserve_legacy_state(self):
        db, rows = self.make_legacy(); before = self.snapshot(db)
        db.executescript((ROOT/'migrations/0010_request_numbers.sql').read_text())
        db.executescript((ROOT/'migrations/0011_request_number_receipts.sql').read_text())
        after = self.snapshot(db)
        self.assertEqual(before, {k: ([r[:-1] for r in v] if k == 'submissions' else v) for k,v in after.items() if k in before})
        mapped = {r[0]: r[1] for r in db.execute('SELECT id,request_number FROM submissions')}
        expected = {r['id']: r['request_number'] for r in json.loads(REPORT.read_text())['mapping']}
        self.assertEqual(mapped, expected)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM request_number_reservations').fetchone()[0], 9)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM request_number_sequences').fetchone()[0], 7)
        # Migration's immutable guards protect both newly assigned values and reservation identity.
        with self.assertRaises(sqlite3.IntegrityError): db.execute("UPDATE submissions SET request_number='RF012028999999' WHERE id='s-pc-tie-a'")
        with self.assertRaises(sqlite3.IntegrityError): db.execute("UPDATE request_number_reservations SET sequence=99 WHERE submission_id='s-pc-tie-a'")
        with self.assertRaises(sqlite3.IntegrityError): db.execute("DELETE FROM request_number_reservations WHERE submission_id='s-pc-tie-a'")

    def test_local_sqlite_copy_without_number_column_is_read_only_and_fully_mapped(self):
        db, _ = self.make_legacy()
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'legacy?mode=rw.db'
            saved = sqlite3.connect(str(path)); db.backup(saved); saved.close()
            before = path.read_bytes()
            run = subprocess.run(['python3', str(ROOT/'scripts/map-legacy-request-numbers.py'), '--db', str(path)], text=True, capture_output=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            report = json.loads(run.stdout)
            self.assertEqual(report['total'], 9); self.assertEqual(report['mapped'], 9)
            self.assertEqual(report['collision_count'], 0); self.assertFalse(report['refusal'])
            self.assertEqual(report, json.loads(REPORT.read_text()))
            self.assertEqual(path.read_bytes(), before)
        db.close()

    def test_dry_run_artifacts_are_deterministic_and_collision_report_refuses(self):
        cmd = ['python3', str(ROOT/'scripts/map-legacy-request-numbers.py'), '--input', str(LEGACY)]
        run = subprocess.run(cmd, text=True, capture_output=True, check=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        report = json.loads(run.stdout); self.assertEqual(report['collision_count'], 0); self.assertFalse(report['refusal'])
        self.assertEqual(json.loads(REPORT.read_text()), report)
        collision_cmd = ['python3', str(ROOT/'scripts/map-legacy-request-numbers.py'), '--input', str(COLLISION)]
        collision = subprocess.run(collision_cmd, text=True, capture_output=True, check=False)
        self.assertEqual(collision.returncode, 2)
        collision_report = json.loads(collision.stdout)
        self.assertGreater(collision_report['collision_count'], 0); self.assertTrue(collision_report['refusal'])
        self.assertEqual(json.loads(COLLISION_REPORT.read_text()), collision_report)


if __name__ == '__main__': unittest.main()
