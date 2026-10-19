import json, pathlib, sqlite3, subprocess, tempfile, threading, unittest

ROOT = pathlib.Path(__file__).parents[1]

def schema(db):
    db.executescript((ROOT/'migrations/0001_initial.sql').read_text())
    db.executescript((ROOT/'migrations/0010_request_numbers.sql').read_text())
    db.execute("INSERT INTO users(id,name,email,position,role,created_at,updated_at) VALUES ('u','User','u@test','Staff','user','2028-01-01','2028-01-01')")
    db.commit()

def reserve(path, i):
    con = sqlite3.connect(path, timeout=10, isolation_level='IMMEDIATE')
    try:
        con.execute("INSERT OR IGNORE INTO request_number_sequences(type,year,month,next_value) VALUES ('petty_cash',2028,1,1)")
        con.execute("UPDATE request_number_sequences SET next_value=next_value+1 WHERE type='petty_cash' AND year=2028 AND month=1")
        seq = con.execute("SELECT next_value-1 FROM request_number_sequences WHERE type='petty_cash' AND year=2028 AND month=1").fetchone()[0]
        number = f'PC012028{seq:06d}'
        con.execute("INSERT INTO request_number_reservations(submission_id,request_number,type,created_by,created_at,idempotency_key,payload_hash,year,month,sequence) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (f'id-{i}', number, 'petty_cash', 'u', '2028-01-31T18:00:00.000Z', f'k-{i}', None, 2028, 1, seq))
        con.commit(); return number
    finally: con.close()

class RequestNumbers(unittest.TestCase):
    def test_concurrent_reservations_are_unique_and_abandoned_number_is_not_reused(self):
        with tempfile.NamedTemporaryFile(suffix='.db') as f:
            con = sqlite3.connect(f.name); schema(con); con.close()
            results, errors = [], []
            def run(i):
                try: results.append(reserve(f.name, i))
                except Exception as e: errors.append(e)
            threads = [threading.Thread(target=run, args=(i,)) for i in range(24)]
            for t in threads: t.start()
            for t in threads: t.join()
            self.assertFalse(errors)
            self.assertEqual(len(set(results)), 24)
            con = sqlite3.connect(f.name)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM request_number_reservations').fetchone()[0], 24)
            # A reservation exists before a submission and is intentionally retained.
            self.assertEqual({r[0] for r in con.execute('SELECT sequence FROM request_number_reservations')}, set(range(1, 25)))
            con.close()

    def test_linkage_and_immutability_guards(self):
        con = sqlite3.connect(':memory:'); schema(con)
        con.execute("INSERT INTO request_number_reservations VALUES ('s1','RF022028000001','finance_request','u','2028-02-01T00:00:00Z','key',NULL,2028,2,1)")
        con.execute("INSERT INTO submissions(id,idempotency_key,created_by,type,amount_idr,date,description,created_at,updated_at,request_number) VALUES ('s1','key','u','finance_request',10,'2028-02-01','abc','2028-02-01T00:00:00Z','2028-02-01T00:00:00Z','RF022028000001')")
        with self.assertRaises(sqlite3.IntegrityError): con.execute("UPDATE submissions SET request_number='RF022028000002' WHERE id='s1'")
        with self.assertRaises(sqlite3.IntegrityError): con.execute("DELETE FROM request_number_reservations WHERE submission_id='s1'")
        with self.assertRaises(sqlite3.IntegrityError): con.execute("INSERT INTO submissions(id,idempotency_key,created_by,type,amount_idr,date,description,created_at,updated_at,request_number) VALUES ('s2','key2','u','finance_request',10,'2028-02-01','abc','2028-02-01T00:00:00Z','2028-02-01T00:00:00Z',NULL)")

    def test_mapping_is_deterministic_and_refuses_existing_collision(self):
        rows = [
          {'id':'b','type':'petty_cash','created_at':'2028-01-01T17:00:00Z'},
          {'id':'a','type':'petty_cash','created_at':'2028-01-01T17:00:00Z'},
          {'id':'old','type':'petty_cash','created_at':'2028-01-01T17:00:00Z','request_number':'PC012028000001'},
          {'id':'old-duplicate','type':'petty_cash','created_at':'2028-01-01T17:00:00Z','request_number':'PC012028000001'},
        ]
        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl') as f:
            for row in rows: f.write(json.dumps(row)+'\n')
            f.flush()
            cmd = ['python3', str(ROOT/'scripts/map-legacy-request-numbers.py'), '--input', f.name]
            run = subprocess.run(cmd, text=True, capture_output=True)
            report = json.loads(run.stdout)
            self.assertEqual(run.returncode, 2)
            self.assertTrue(report['refusal'])
            self.assertEqual(report['collision_count'], 1)
            self.assertEqual([x['request_number'] for x in report['mapping']], ['PC012028000002','PC012028000003'])
            self.assertEqual(subprocess.run(cmd, text=True, capture_output=True).stdout, run.stdout)

if __name__ == '__main__': unittest.main()
