import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { LocalD1 } from './local_financial_db.mjs';
const workflow = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const step = workflow.split('      - name: Require approved financial-control migrations')[1].split('      - name:')[0];
const sql = step.match(/--command "([^"]+)"/)[1];
const expected = JSON.parse(step.match(/map\(\.name\) \| sort\) == (\[[^\]]+\])/)[1]);
const statements = sql.split(';').map(value => value.trim()).filter(Boolean);
const base = ['0001_initial.sql','0002_passkey_auth.sql','0003_user_profiles.sql','0004_manager_submissions.sql'];
const migrations = ['0005_cash_topups.sql','0006_financial_controls.sql','0007_submission_receipts.sql','0008_financial_alert_settings.sql'];
const state = db => JSON.stringify(db.db.prepare('SELECT (SELECT COUNT(*) FROM submissions) AS reports,(SELECT COUNT(*) FROM cash_ledger) AS ledger,(SELECT COUNT(*) FROM audit_events) AS audit,(SELECT balance_idr FROM cash_accounts LIMIT 1) AS balance').get());
test('actual deployment probe is read-only and accepts all required tables and twelve triggers', () => {
  const db = new LocalD1([...base, ...migrations]); const before = state(db);
  assert.ok(statements.every(value => /^SELECT\s/i.test(value)));
  assert.equal(statements.length, 2); assert.equal(expected.length, 12);
  assert.deepEqual(db.db.prepare(statements[0]).all(), []);
  assert.deepEqual(db.db.prepare(statements[1]).all().map(row => row.name).sort(), expected);
  assert.equal(state(db), before); db.db.close();
});
test('deployment probe rejects a partial financial schema', () => {
  const db = new LocalD1([...base, ...migrations.slice(0, 3)]);
  assert.throws(() => db.db.prepare(statements[0]), /no such table: financial_alert_settings/);
  db.db.close();
});
test('deployment guard set fails when even one mandatory trigger is missing', () => {
  const db = new LocalD1([...base, ...migrations]);
  db.db.exec('DROP TRIGGER financial_settings_manager_guard');
  assert.notDeepEqual(db.db.prepare(statements[1]).all().map(row => row.name).sort(), expected);
  db.db.close();
});
