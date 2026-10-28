// The encrypted key: a round trip, the 600,000 default, and a failure for each changed field.
import { expect, test } from 'bun:test';
import * as ed from '@noble/ed25519';
import { base64urlnopad } from '@scure/base';
import { decryptKey, encryptKey, KEY_FORMAT, KeyfileError, PBKDF2_ITERATIONS, type EncryptedKey } from '../src/id/keyfile.ts';

const did = 'did:dht:df6h6n9zksp86p7d957xtmmu3w64mwb8mdcza6iu8p9ew8i9jq4o';
const keyId = `${did}#didpkg-1`;
const seed = ed.utils.randomSecretKey();
const fast = { did, keyId, seed, passphrase: 'correct horse battery', iterations: 1000 };

test('a round trip gives the seed, and the file holds the public key', async () => {
  const k = await encryptKey(fast);
  expect(await decryptKey(k, fast.passphrase)).toEqual(seed);
  expect(k.publicKeyJwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: base64urlnopad.encode(await ed.getPublicKeyAsync(seed)) });
  expect([k.format, k.did, k.keyId, k.kdf.name, k.kdf.hash, k.cipher.name]).toEqual([KEY_FORMAT, did, keyId, 'PBKDF2', 'SHA-256', 'AES-256-GCM']);
  expect([base64urlnopad.decode(k.kdf.salt).length, base64urlnopad.decode(k.cipher.iv).length, base64urlnopad.decode(k.ciphertext).length]).toEqual([16, 12, 48]);
  expect(JSON.stringify(k)).not.toContain(base64urlnopad.encode(seed));
});

test('the default is 600,000 iterations, and each file has a new salt and iv', async () => {
  const { iterations: _, ...slow } = fast;
  const [a, b] = [await encryptKey(slow), await encryptKey(fast)];
  expect(PBKDF2_ITERATIONS).toBe(600_000);
  expect(a.kdf.iterations).toBe(600_000);
  expect(await decryptKey(a, fast.passphrase)).toEqual(seed);
  expect([a.kdf.salt === b.kdf.salt, a.cipher.iv === b.cipher.iv]).toEqual([false, false]);
});

const fails = async (k: unknown, passphrase = fast.passphrase) => {
  try {
    await decryptKey(k as EncryptedKey, passphrase);
  } catch (e) {
    if (e instanceof KeyfileError) return e.message;
    throw e;
  }
  throw new Error('decryptKey passed');
};

test('a wrong passphrase fails', async () => {
  expect(await fails(await encryptKey(fast), 'correct horse battery!')).toContain('wrong passphrase');
});

test('a changed header field fails, because it is the additional data', async () => {
  const k = await encryptKey(fast);
  const other = await encryptKey({ ...fast, seed: ed.utils.randomSecretKey() });
  const flip = (s: string) => base64urlnopad.encode(base64urlnopad.decode(s).map((b, i) => (i === 0 ? b ^ 1 : b)));
  const changes: [string, (c: EncryptedKey) => void][] = [
    ['did', (c) => { c.did = 'did:dht:other'; }],
    ['keyId', (c) => { c.keyId = `${did}#0`; }],
    ['publicKeyJwk.x', (c) => { c.publicKeyJwk.x = other.publicKeyJwk.x; }],
    ['iterations', (c) => { c.kdf.iterations = 1001; }],
    ['salt', (c) => { c.kdf.salt = flip(c.kdf.salt); }],
    ['iv', (c) => { c.cipher.iv = flip(c.cipher.iv); }],
    ['ciphertext', (c) => { c.ciphertext = flip(c.ciphertext); }],
  ];
  for (const [field, change] of changes) {
    const c = structuredClone(k);
    change(c);
    expect([field, await fails(c)]).toEqual([field, expect.stringContaining('wrong passphrase')]);
  }
});

test('a bad format, KDF, cipher, iterations or encoding fails before the decrypt', async () => {
  const k = await encryptKey(fast);
  const bad: [Partial<Record<string, unknown>>, string][] = [
    [{ format: 'other' }, 'the format is not'],
    [{ publicKeyJwk: undefined }, 'no public key'],
    [{ kdf: { ...k.kdf, hash: 'SHA-1' } }, 'unknown KDF or cipher'],
    [{ cipher: { name: 'AES-128-GCM', iv: k.cipher.iv } }, 'unknown KDF or cipher'],
    [{ kdf: { ...k.kdf, iterations: 10_000_001 } }, 'bad iterations'],
    [{ kdf: { ...k.kdf, iterations: 0 } }, 'bad iterations'],
    [{ ciphertext: '!!' }, 'bad base64url'],
  ];
  for (const [patch, message] of bad) expect(await fails({ ...k, ...patch })).toContain(message);
  expect(await fails(null)).toContain('the format is not');
});

test('a seed that is not 32 bytes fails', async () => {
  await expect(encryptKey({ ...fast, seed: new Uint8Array(31) })).rejects.toThrow('32 bytes');
});
