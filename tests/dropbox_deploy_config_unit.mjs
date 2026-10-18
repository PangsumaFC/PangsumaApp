import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const config = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const gate = fs.readFileSync(new URL('../scripts/check-dropbox-deploy.py', import.meta.url), 'utf8');
test('Wrangler keeps the enabled Dropbox feature flag in both default and production bindings', () => {
  for (const section of ['vars', 'env.production.vars']) {
    const heading = `[${section}]`;
    const start = config.indexOf(heading); assert.ok(start >= 0);
    const end = config.indexOf('\n[', start + heading.length);
    const body = config.slice(start, end < 0 ? undefined : end);
    assert.match(body, /DROPBOX_RECEIPTS_ENABLED\s*=\s*"true"/);
    assert.doesNotMatch(body, /DROPBOX_(?:APP_KEY|APP_SECRET|REFRESH_TOKEN)\s*=/, 'credentials must remain encrypted server secrets, not source vars');
  }
});
test('Dropbox schema/secrets/config gates run before and after deployment and never apply a migration', () => {
  const before = workflow.indexOf('Require approved Dropbox metadata and server configuration');
  const deploy = workflow.indexOf('run: npx --yes wrangler@4.151.1 pages deploy');
  const after = workflow.indexOf('Verify Dropbox configuration survived deployment');
  assert.ok(before > 0 && deploy > before && after > deploy);
  assert.equal((workflow.match(/run: python3 scripts\/check-dropbox-deploy\.py/g) || []).length, 2);
  assert.match(gate, /config\.get\('vars'/);
  assert.match(gate, /config\.get\('env'/);
  assert.doesNotMatch(gate, /(?:CREATE TABLE|DROP TABLE|ALTER TABLE|INSERT INTO|UPDATE receipt)/i);
});
