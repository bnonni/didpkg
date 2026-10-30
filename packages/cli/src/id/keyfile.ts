// The encrypted key: AES-256-GCM with a PBKDF2-SHA256 key at 600,000 iterations.
// Source: drpm.tools/src/lib/profile.ts:128-140 and :208-251, with 600,000 iterations, not 100,000.
// The header fields are the AES-GCM additional data. Thus a changed DID, key id, key or KDF field fails to decrypt.
import * as ed from '@noble/ed25519';
import { base64urlnopad } from '@scure/base';

export const KEY_FORMAT = 'didpkg-key-1';
export const PBKDF2_ITERATIONS = 600_000;
/** The upper limit for the iterations in a keyfile, so a changed file cannot stop the CLI for a long time. */
const MAX_ITERATIONS = 10_000_000;

export interface Ed25519Jwk { kty: 'OKP'; crv: 'Ed25519'; x: string }

export interface EncryptedKey {
  format: typeof KEY_FORMAT;
  did: string;
  /** The verification method id, for example `did:dht:...#didpkg-1`. */
  keyId: string;
  publicKeyJwk: Ed25519Jwk;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-256-GCM'; iv: string };
  /** The AES-GCM output (base64url, no padding) for the 32-byte Ed25519 seed. */
  ciphertext: string;
}

export class KeyfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyfileError';
  }
}

const te = new TextEncoder();
/** WebCrypto in lib.dom wants an ArrayBuffer view. These views come from the CLI, not from a SharedArrayBuffer. */
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

const additionalData = (k: Omit<EncryptedKey, 'ciphertext'>) => te.encode(JSON.stringify([
  k.format, k.did, k.keyId, k.publicKeyJwk.kty, k.publicKeyJwk.crv, k.publicKeyJwk.x,
  k.kdf.name, k.kdf.hash, k.kdf.iterations, k.kdf.salt, k.cipher.name, k.cipher.iv,
]));

async function aesKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** Encrypts an Ed25519 seed. `iterations` is for tests only: a keyfile on disk uses PBKDF2_ITERATIONS. */
export async function encryptKey(o: {
  did: string; keyId: string; seed: Uint8Array; passphrase: string; iterations?: number;
}): Promise<EncryptedKey> {
  if (o.seed.length !== 32) throw new KeyfileError(`an Ed25519 seed has 32 bytes, not ${o.seed.length}`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = o.iterations ?? PBKDF2_ITERATIONS;
  const header: Omit<EncryptedKey, 'ciphertext'> = {
    format: KEY_FORMAT, did: o.did, keyId: o.keyId,
    publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: base64urlnopad.encode(await ed.getPublicKeyAsync(o.seed)) },
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: base64urlnopad.encode(salt) },
    cipher: { name: 'AES-256-GCM', iv: base64urlnopad.encode(iv) },
  };
  const key = await aesKey(o.passphrase, salt, iterations);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(header) }, key, buf(o.seed));
  return { ...header, ciphertext: base64urlnopad.encode(new Uint8Array(sealed)) };
}

/** The Ed25519 seed of `publicKeyJwk` (the additional data binds it). A wrong passphrase or a changed field gives a KeyfileError. */
export async function decryptKey(k: EncryptedKey, passphrase: string): Promise<Uint8Array> {
  const fail = (why: string) => new KeyfileError(`${String(k?.keyId)}: ${why}`);
  if (k?.format !== KEY_FORMAT) throw fail(`the format is not ${KEY_FORMAT}`);
  if (typeof k.publicKeyJwk?.x !== 'string') throw fail('no public key');
  if (k.kdf?.name !== 'PBKDF2' || k.kdf.hash !== 'SHA-256' || k.cipher?.name !== 'AES-256-GCM') throw fail('unknown KDF or cipher');
  const { iterations } = k.kdf;
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) throw fail(`bad iterations ${iterations}`);
  let salt: Uint8Array, iv: Uint8Array, sealed: Uint8Array;
  try {
    [salt, iv, sealed] = [base64urlnopad.decode(k.kdf.salt), base64urlnopad.decode(k.cipher.iv), base64urlnopad.decode(k.ciphertext)];
  } catch {
    throw fail('bad base64url');
  }
  try {
    const key = await aesKey(passphrase, salt, iterations);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: additionalData(k) }, key, buf(sealed)));
  } catch {
    throw fail('wrong passphrase, or the keyfile changed');
  }
}
