// Verification method keys: Multikey, JWK and the DID Core relationship check.
import { expect, test } from 'bun:test';
import * as ed from '@noble/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base64urlnopad } from '@scure/base';
import type { DidDocument, VerificationMethod } from '../../src/did/types.ts';
import { fromJwk, fromMultikey, keyForRelationship, publicKeyOf, toMultikey } from '../../src/trust/index.ts';
import { failure } from './helpers.ts';

const KEY = 'PROOF_VERIFICATION_ERROR key';
const VM_ERROR = 'PROOF_VERIFICATION_ERROR verification-method';
const ED_SEED = new Uint8Array(32).fill(1);
const K1_SECRET = new Uint8Array(32).fill(2);

// Test vectors from the did:key spec (https://w3c-ccg.github.io/did-key-spec/).
test('Multikey: the did:key spec keys decode and encode again to the same string', () => {
  for (const [mb, alg, length] of [
    ['z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', 'Ed25519', 32],
    ['zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme', 'secp256k1', 33],
  ] as const) {
    const key = fromMultikey(mb);
    expect([key.alg, key.bytes.length, toMultikey(key)]).toEqual([alg, length, mb]);
  }
});

test('Multikey: other key types, other bases, bad lengths and bad points fail', async () => {
  expect(await failure(() => fromMultikey('zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169'))).toBe(KEY); // P-256
  expect(await failure(() => fromMultikey('u7QE'))).toBe(KEY);
  expect(await failure(() => fromMultikey('z0OIl'))).toBe(KEY);
  expect(await failure(() => toMultikey({ alg: 'Ed25519', bytes: new Uint8Array(31) }))).toBe(KEY);
  expect(await failure(() => toMultikey({ alg: 'secp256k1', bytes: Uint8Array.from([2, ...new Uint8Array(32).fill(0xff)]) }))).toBe(KEY);
});

test('JWK: Ed25519 and secp256k1 keys give the same bytes as Multikey', async () => {
  const edPub = await ed.getPublicKeyAsync(ED_SEED);
  expect(fromJwk({ kty: 'OKP', crv: 'Ed25519', x: base64urlnopad.encode(edPub) })).toEqual({ alg: 'Ed25519', bytes: edPub });
  const point = secp256k1.getPublicKey(K1_SECRET, false);
  const jwk = { kty: 'EC', crv: 'secp256k1', x: base64urlnopad.encode(point.slice(1, 33)), y: base64urlnopad.encode(point.slice(33)) };
  expect(fromJwk(jwk)).toEqual({ alg: 'secp256k1', bytes: secp256k1.getPublicKey(K1_SECRET, true) });
});

test('JWK: private members, other key types, bad base64url and bad points fail', async () => {
  const x = base64urlnopad.encode(await ed.getPublicKeyAsync(ED_SEED));
  expect(await failure(() => fromJwk({ kty: 'OKP', crv: 'Ed25519', x, d: x }))).toBe(KEY);
  expect(await failure(() => fromJwk({ kty: 'OKP', crv: 'X25519', x }))).toBe(KEY);
  expect(await failure(() => fromJwk({ kty: 'RSA', n: 'AQAB', e: 'AQAB' }))).toBe(KEY);
  expect(await failure(() => fromJwk({ kty: 'OKP', crv: 'Ed25519', x: x + '=' }))).toBe(KEY);
  expect(await failure(() => fromJwk({ kty: 'OKP', crv: 'Ed25519' }))).toBe(KEY);
  const point = secp256k1.getPublicKey(K1_SECRET, false);
  const y = point.slice(33);
  y[31]! ^= 1;
  const bad = { kty: 'EC', crv: 'secp256k1', x: base64urlnopad.encode(point.slice(1, 33)), y: base64urlnopad.encode(y) };
  expect(await failure(() => fromJwk(bad))).toBe(KEY);
});

test('publicKeyOf: a method has exactly one form of key material', async () => {
  const mb = 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: base64urlnopad.encode(fromMultikey(mb).bytes) };
  const vm = { id: 'did:example:a#1', type: 'Multikey', controller: 'did:example:a' };
  expect(publicKeyOf({ ...vm, publicKeyMultibase: mb })).toEqual(publicKeyOf({ ...vm, type: 'JsonWebKey', publicKeyJwk: jwk }));
  expect(await failure(() => publicKeyOf({ ...vm, publicKeyMultibase: mb, publicKeyJwk: jwk }))).toBe(KEY);
  expect(await failure(() => publicKeyOf(vm))).toBe(KEY);
});

const DID = 'did:example:alice';
const method = (fragment: string, controller = DID): VerificationMethod => ({
  id: `#${fragment}`,
  type: 'Multikey',
  controller,
  publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
});
const doc: DidDocument = {
  id: DID,
  verificationMethod: [method('key-1'), method('key-2'), method('key-3', 'did:example:bob')],
  assertionMethod: ['#key-1', `${DID}#key-3`, { ...method('key-4'), id: `${DID}#key-4` }],
  authentication: ['#key-2'],
};

test('keyForRelationship: relative, absolute and embedded methods resolve', () => {
  expect(keyForRelationship(doc, `${DID}#key-1`).id).toBe('#key-1');
  expect(keyForRelationship(doc, `${DID}#key-4`).id).toBe(`${DID}#key-4`);
  expect(keyForRelationship(doc, `${DID}#key-2`, 'authentication').id).toBe('#key-2');
});

test('keyForRelationship: another relationship, another DID and another controller fail', async () => {
  expect(await failure(() => keyForRelationship(doc, `${DID}#key-2`))).toBe(VM_ERROR);
  expect(await failure(() => keyForRelationship(doc, `${DID}#key-9`))).toBe(VM_ERROR);
  expect(await failure(() => keyForRelationship(doc, 'did:example:bob#key-1'))).toBe(VM_ERROR);
  expect(await failure(() => keyForRelationship(doc, `${DID}#key-3`))).toBe(VM_ERROR);
  expect(await failure(() => keyForRelationship({ id: DID }, `${DID}#key-1`))).toBe(VM_ERROR);
});
