import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getPasswordParameters,
  hashClientCredential,
  verifyClientCredential
} from '../functions/_lib/auth.js';

const env = { PASSWORD_PEPPER: Buffer.alloc(32, 7).toString('base64') };
const credential = {
  version: 'client-pbkdf2-hmac-v1',
  iterations: 600000,
  salt: Buffer.alloc(16, 1).toString('base64'),
  derived: Buffer.alloc(32, 2).toString('base64'),
  passwordLength: 12
};

test('hash and verify binds normalized email, salt, and derived bytes', async () => {
  const encoded = await hashClientCredential(credential, 'User@Example.com', env);
  assert.match(encoded, /^client-pbkdf2-hmac-v1\$600000\$[^$]+\$[^$]+$/);
  assert.equal(await verifyClientCredential(credential, encoded, 'user@example.com', env), true);
  assert.equal(await verifyClientCredential({ ...credential, salt: Buffer.alloc(16, 3).toString('base64') }, encoded, 'user@example.com', env), false);
  assert.equal(await verifyClientCredential(credential, encoded, 'other@example.com', env), false);
});

test('malformed credentials and unsupported stored schemas fail closed', async () => {
  assert.equal(await verifyClientCredential({ ...credential, iterations: 1 }, 'legacy$hash', 'user@example.com', env), false);
  await assert.rejects(() => hashClientCredential({ ...credential, passwordLength: 11 }, 'user@example.com', env), /Kredensial/);
  assert.equal(await verifyClientCredential(credential, 'pbkdf2-sha256$600000$AAAA$AAAA', 'user@example.com', env), false);
});

test('unknown accounts receive deterministic-shaped dummy parameters without enumeration', async () => {
  const params = await getPasswordParameters(null, 'missing@example.com', env);
  assert.deepEqual(params.version, 'client-pbkdf2-hmac-v1');
  assert.equal(params.iterations, 600000);
  assert.equal(Buffer.from(params.salt, 'base64').length, 16);
});

test('missing pepper fails closed', async () => {
  await assert.rejects(() => hashClientCredential(credential, 'user@example.com', {}), /belum dikonfigurasi/);
  await assert.rejects(() => getPasswordParameters(null, 'user@example.com', {}), /belum dikonfigurasi/);
});
