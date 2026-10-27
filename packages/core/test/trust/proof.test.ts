// Data Integrity proofs (eddsa-jcs-2022, bip340-jcs-2025), JCS and digests.
import { expect, test } from 'bun:test';
import * as ed from '@noble/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base64urlnopad } from '@scure/base';
import type { DidDocument } from '../../src/did/types.ts';
import {
  addProof,
  bip340Signer,
  contentDigest,
  ed25519Signer,
  jcs,
  sri,
  toMultikey,
  verifyProof,
  type Signer,
} from '../../src/trust/index.ts';
import { failure } from './helpers.ts';

const VERIFY = 'PROOF_VERIFICATION_ERROR';
const DID = 'did:example:alice';
const ED_SEED = new Uint8Array(32).fill(1);
const K1_SECRET = new Uint8Array(32).fill(2);
const CREATED = '2026-10-27T22:00:00Z';
const manifest = { name: '@alice/hello', version: '1.0.0', dist: { integrity: 'sha512-AAAA' } };

// A DID document with an Ed25519 JWK key (#ed), a secp256k1 Multikey key (#k1) and an Ed25519 key only for authentication (#auth).
async function aliceDoc(): Promise<DidDocument> {
  const x = base64urlnopad.encode(await ed.getPublicKeyAsync(ED_SEED));
  const k1 = toMultikey({ alg: 'secp256k1', bytes: secp256k1.getPublicKey(K1_SECRET, true) });
  return {
    id: DID,
    verificationMethod: [
      { id: `${DID}#ed`, type: 'JsonWebKey', controller: DID, publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x } },
      { id: `${DID}#k1`, type: 'Multikey', controller: DID, publicKeyMultibase: k1 },
      { id: `${DID}#auth`, type: 'JsonWebKey', controller: DID, publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x } },
    ],
    assertionMethod: [`${DID}#ed`, `${DID}#k1`],
    authentication: [`${DID}#auth`],
  };
}

const edSigner = (vm = `${DID}#ed`): Signer => ed25519Signer(ED_SEED, vm);

test('eddsa-jcs-2022 and bip340-jcs-2025: sign and verify', async () => {
  const doc = await aliceDoc();
  for (const signer of [edSigner(), bip340Signer(K1_SECRET, `${DID}#k1`)]) {
    const signed = await addProof(manifest, signer, { created: CREATED });
    expect(signed.proof.cryptosuite).toBe(signer.cryptosuite);
    expect(await verifyProof(signed, doc)).toEqual({ verificationMethod: signer.verificationMethod, created: CREATED });
    expect(await failure(() => verifyProof({ ...signed, version: '1.0.1' }, doc))).toBe(`${VERIFY} signature`);
  }
});

test('addProof: replaces an old proof and gives created in seconds by default', async () => {
  const first = await addProof(manifest, edSigner(), { created: CREATED });
  const second = await addProof(first, edSigner());
  expect(second.proof.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(await verifyProof(second, await aliceDoc())).toEqual({ verificationMethod: `${DID}#ed`, created: second.proof.created! });
  expect(await failure(() => addProof(manifest, edSigner(), { created: '2026-10-27' }))).toBe('PROOF_GENERATION_ERROR malformed-proof');
});

test('verifyProof: the proof purpose and the relationship must match', async () => {
  const doc = await aliceDoc();
  const auth = await addProof(manifest, edSigner(`${DID}#auth`), { created: CREATED, proofPurpose: 'authentication' });
  expect(await verifyProof(auth, doc, 'authentication')).toEqual({ verificationMethod: `${DID}#auth`, created: CREATED });
  expect(await failure(() => verifyProof(auth, doc))).toBe(`${VERIFY} proof-purpose`);
  const wrongRelationship = await addProof(manifest, edSigner(`${DID}#auth`), { created: CREATED });
  expect(await failure(() => verifyProof(wrongRelationship, doc))).toBe(`${VERIFY} verification-method`);
});

test('verifyProof: a key of another DID fails', async () => {
  const signed = await addProof(manifest, ed25519Signer(ED_SEED, 'did:example:mallory#ed'), { created: CREATED });
  const doc = await aliceDoc();
  expect(await failure(() => verifyProof(signed, doc))).toBe(`${VERIFY} verification-method`);
});

test('verifyProof: the key type must match the cryptosuite', async () => {
  const signed = await addProof(manifest, edSigner(`${DID}#k1`), { created: CREATED });
  const doc = await aliceDoc();
  expect(await failure(() => verifyProof(signed, doc))).toBe(`${VERIFY} key`);
});

test('verifyProof: malformed proofs and other cryptosuites fail', async () => {
  const doc = await aliceDoc();
  const signed = await addProof(manifest, edSigner(), { created: CREATED });
  const withProof = (proof: unknown) => verifyProof({ ...signed, proof }, doc);
  expect(await failure(() => verifyProof(manifest, doc))).toBe(`${VERIFY} malformed-proof`);
  expect(await failure(() => withProof([signed.proof]))).toBe(`${VERIFY} malformed-proof`);
  expect(await failure(() => withProof({ ...signed.proof, type: 'Ed25519Signature2020' }))).toBe(`${VERIFY} malformed-proof`);
  expect(await failure(() => withProof({ ...signed.proof, cryptosuite: 'ecdsa-jcs-2019' }))).toBe(`${VERIFY} cryptosuite`);
  expect(await failure(() => withProof({ ...signed.proof, proofValue: 'u' + signed.proof.proofValue!.slice(1) }))).toBe(`${VERIFY} malformed-proof`);
  expect(await failure(() => withProof({ ...signed.proof, proofValue: 'z0OIl' }))).toBe(`${VERIFY} malformed-proof`);
  expect(await failure(() => withProof({ ...signed.proof, proofValue: 'z2' }))).toBe(`${VERIFY} signature`);
  expect(await failure(() => withProof({ ...signed.proof, created: 'yesterday' }))).toBe(`${VERIFY} malformed-proof`);
  expect(await failure(() => withProof({ ...signed.proof, verificationMethod: 7 }))).toBe(`${VERIFY} malformed-proof`);
});

// eddsa-jcs-2022 section 3.3.2 step 4: the document @context must start with the proof @context.
test('verifyProof: a document @context may grow at the end, but not change', async () => {
  const doc = await aliceDoc();
  const signed = await addProof({ '@context': ['https://didpkg.dev/ns/v1'], ...manifest }, edSigner(), { created: CREATED });
  expect(signed.proof['@context']).toEqual(['https://didpkg.dev/ns/v1']);
  const grown = { ...signed, '@context': ['https://didpkg.dev/ns/v1', 'https://example.com/ns'] };
  expect(await verifyProof(grown, doc)).toEqual({ verificationMethod: `${DID}#ed`, created: CREATED });
  const changed = { ...signed, '@context': ['https://example.com/ns'] };
  expect(await failure(() => verifyProof(changed, doc))).toBe(`${VERIFY} context`);
  const { '@context': _dropped, ...none } = signed;
  expect(await failure(() => verifyProof(none, doc))).toBe(`${VERIFY} context`);
});

test('jcs: RFC 8785 order, and no form for NaN, Infinity, undefined and lone surrogates', async () => {
  expect(jcs({ b: 1, a: [1, 'x', null], c: { z: true, y: 1e21 } })).toBe('{"a":[1,"x",null],"b":1,"c":{"y":1e+21,"z":true}}');
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, '\ud800']) {
    expect(await failure(() => jcs(value))).toBe('PROOF_TRANSFORMATION_ERROR jcs');
  }
  expect(await failure(() => addProof({ size: Number.NaN }, edSigner()))).toBe('PROOF_TRANSFORMATION_ERROR jcs');
});

test('sri and contentDigest', async () => {
  // Expected values from `openssl dgst -binary | base64`.
  expect(await sri('sha256', new TextEncoder().encode('abc'))).toBe('sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  expect(await sri('sha512', new Uint8Array(0))).toBe(
    'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
  );
  const signed = await addProof(manifest, edSigner(), { created: CREATED });
  expect(contentDigest(signed)).toBe(contentDigest(manifest));
  expect(contentDigest({ ...manifest, version: '1.0.1' })).not.toBe(contentDigest(manifest));
  expect(contentDigest({ b: 2, a: 1 })).toBe(await sri('sha256', new TextEncoder().encode('{"a":1,"b":2}')));
});
