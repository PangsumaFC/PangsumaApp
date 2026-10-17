import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handlePasskeyApi } from '../functions/_lib/webauthn.js';

const enabledEnv = {
  PASSKEY_AUTH_ENABLED: 'true',
  WEBAUTHN_ORIGIN: 'https://app.pangsumafc.com',
  WEBAUTHN_RP_ID: 'app.pangsumafc.com'
};
const db = new Proxy({}, { get() { throw new Error('Disabled endpoint touched the database'); } });
const deferred = [
  '/passkeys/invitations',
  '/passkeys/invitation/options',
  '/passkeys/invitation/verify',
  '/passkeys/manager-registration/options',
  '/passkeys/manager-registration/verify'
];
const active = [
  '/passkeys/login/options', '/passkeys/login/verify',
  '/passkeys/manager-recovery/options', '/passkeys/manager-recovery/verify'
];
function context(path, env, method = 'POST') {
  return { env, request: new Request(`https://app.pangsumafc.com/api${path}`, {
    method, headers: { Origin: 'https://app.pangsumafc.com' }
  }) };
}
for (const path of deferred) {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    await assert.rejects(handlePasskeyApi(context(path, enabledEnv, method), db, path),
      error => error.status === 404 && error.code === 'not_found');
  }
}
for (const env of [{}, { ...enabledEnv, PASSKEY_AUTH_ENABLED: 'false' }]) {
  const response = await handlePasskeyApi(context('/passkeys/status', env, 'GET'), db, '/passkeys/status');
  assert.equal((await response.json()).enabled, false);
  for (const path of [...active, ...deferred]) {
    await assert.rejects(handlePasskeyApi(context(path, env), db, path),
      error => error.status === 404 && error.code === 'not_found');
  }
}
const enabled = await handlePasskeyApi(context('/passkeys/status', enabledEnv, 'GET'), db, '/passkeys/status');
assert.equal((await enabled.json()).enabled, true);
for (const path of ['/passkeys/manager-recovery/options', '/passkeys/manager-recovery/verify']) {
  for (const origin of ['https://attacker.invalid', null]) {
    const request = new Request(`https://app.pangsumafc.com/api${path}`, {
      method: 'POST', headers: origin ? { Origin: origin } : {}
    });
    await assert.rejects(handlePasskeyApi({ request, env: enabledEnv }, db, path),
      error => error.status === 403 && error.code === 'origin_not_allowed');
  }
}
assert.match(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'), /PASSKEY_AUTH_ENABLED\s*=\s*"false"/);
console.log('PASSKEY ROLLOUT UNIT PASSED: deferred endpoints return 404 before DB access for all methods; default-off, kill switch, and recovery origin checks preserved.');
