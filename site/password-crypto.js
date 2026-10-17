'use strict';

(function attachPasswordCrypto(global) {
  const VERSION = 'client-pbkdf2-hmac-v1';
  const ITERATIONS = 600000;
  const SALT_BYTES = 16;
  const DERIVED_BYTES = 32;
  const MIN_PASSWORD_LENGTH = 1;
  const MAX_PASSWORD_LENGTH = 128;

  function requireWebCrypto() {
    if (!global.crypto?.subtle || typeof global.crypto.getRandomValues !== 'function') {
      throw new Error('Browser ini tidak mendukung WebCrypto.');
    }
    return global.crypto;
  }

  function bytesToBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const text = String(value || '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) {
      throw new Error('Parameter password tidak valid.');
    }
    const binary = atob(text);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }

  function validatePassword(password, allowEmpty = false) {
    const value = String(password ?? '');
    const minimum = allowEmpty ? 0 : MIN_PASSWORD_LENGTH;
    if (value.length < minimum || value.length > MAX_PASSWORD_LENGTH) {
      throw new Error(`Password harus berisi ${allowEmpty ? 'maksimal' : '1–'}${MAX_PASSWORD_LENGTH} karakter.`);
    }
    return value;
  }

  function validateParameters(parameters) {
    if (!parameters || parameters.version !== VERSION || Number(parameters.iterations) !== ITERATIONS) {
      throw new Error('Parameter password dari server tidak kompatibel.');
    }
    const salt = base64ToBytes(parameters.salt);
    if (salt.length !== SALT_BYTES) throw new Error('Salt password dari server tidak valid.');
    return { version: VERSION, iterations: ITERATIONS, salt };
  }

  function randomSalt() {
    const salt = new Uint8Array(SALT_BYTES);
    requireWebCrypto().getRandomValues(salt);
    return salt;
  }

  async function derive(password, parameters) {
    const value = validatePassword(password);
    const normalized = validateParameters(parameters);
    const webCrypto = requireWebCrypto();
    const key = await webCrypto.subtle.importKey('raw', new TextEncoder().encode(value), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await webCrypto.subtle.deriveBits({
      name: 'PBKDF2',
      salt: normalized.salt,
      iterations: normalized.iterations,
      hash: 'SHA-256'
    }, key, DERIVED_BYTES * 8);
    return {
      version: VERSION,
      iterations: ITERATIONS,
      salt: bytesToBase64(normalized.salt),
      derived: bytesToBase64(bits),
      passwordLength: value.length
    };
  }

  async function deriveWithRandomSalt(password) {
    const salt = randomSalt();
    return derive(password, { version: VERSION, iterations: ITERATIONS, salt: bytesToBase64(salt) });
  }

  global.PasswordCrypto = Object.freeze({
    VERSION,
    ITERATIONS,
    derive,
    deriveWithRandomSalt,
    randomSaltBase64: () => bytesToBase64(randomSalt()),
    validatePassword
  });
})(window);
