import assert from 'node:assert/strict';
import { isCounterAnomaly, parseAuthenticatorData } from '../functions/_lib/webauthn.js';

function authenticatorData(flags, signCount = 0) {
  const data = new Uint8Array(37);
  data.set(new Uint8Array(32).fill(0x5a), 0);
  data[32] = flags;
  new DataView(data.buffer).setUint32(33, signCount, false);
  return data;
}

assert.deepEqual(
  {
    userPresence: parseAuthenticatorData(authenticatorData(0x45), 'registration').userPresence,
    userVerification: parseAuthenticatorData(authenticatorData(0x45), 'registration').userVerification,
    backupEligible: parseAuthenticatorData(authenticatorData(0x45), 'registration').backupEligible,
  },
  { userPresence: true, userVerification: true, backupEligible: false },
);
assert.equal(parseAuthenticatorData(authenticatorData(0x1d, 9), 'authentication').backupEligible, true);
assert.equal(parseAuthenticatorData(authenticatorData(0x1d, 9), 'authentication').backupState, true);
assert.equal(parseAuthenticatorData(authenticatorData(0x05, 17), 'authentication').signCount, 17);

for (const flags of [0x00, 0x01, 0x41, 0x25, 0x15, 0x85]) {
  assert.throws(() => parseAuthenticatorData(authenticatorData(flags), 'authentication'), /invalid/i, `invalid assertion flags ${flags.toString(16)}`);
}
assert.throws(() => parseAuthenticatorData(authenticatorData(0x05), 'registration'), /invalid/i, 'registration requires AT data');
assert.throws(() => parseAuthenticatorData(authenticatorData(0x45), 'authentication'), /invalid/i, 'assertion must not contain AT data');
assert.throws(() => parseAuthenticatorData(new Uint8Array(36), 'authentication'), /invalid/i, 'authenticator data is at least 37 bytes');

assert.equal(isCounterAnomaly(0, 0), false, 'zero counters are allowed when an authenticator does not support counters');
assert.equal(isCounterAnomaly(0, 1), false, 'first counter increase is allowed');
assert.equal(isCounterAnomaly(4, 5), false, 'strictly increasing counters are allowed');
assert.equal(isCounterAnomaly(4, 4), true, 'a non-increasing non-zero counter is anomalous');
assert.equal(isCounterAnomaly(5, 4), true, 'a decreasing counter is anomalous');
assert.equal(isCounterAnomaly(1, 0), true, 'a non-zero counter resetting to zero is anomalous');

console.log('WEBAUTHN UNIT PASSED: authenticator flags, backup invariants, and signature-counter policy.');
