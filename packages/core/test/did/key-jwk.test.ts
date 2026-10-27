// did:key and did:jwk drivers. Enbox (@enbox/dids) is the second implementation for the key bytes.
import { expect, test } from 'bun:test';
import { DidJwk, DidKey } from '@enbox/dids';
import { base58, base64urlnopad } from '@scure/base';
import { DID_ERROR_NS } from '../../src/did/errors.ts';
import { jwkDriver } from '../../src/did/drivers/jwk.ts';
import { keyDriver } from '../../src/did/drivers/key.ts';
import type { DidResolutionResult } from '../../src/did/types.ts';

const ctx = { signal: new AbortController().signal };
const key = keyDriver();
const jwk = jwkDriver();
const code = (r: DidResolutionResult) => r.didResolutionMetadata.error?.type.slice(DID_ERROR_NS.length);

// Test vectors from the did:key spec (https://w3c-ccg.github.io/did-key-spec/).
const VECTORS: [string, string, number][] = [
  ['did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', 'Ed25519', 32],
  ['did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme', 'secp256k1', 33],
  ['did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169', 'P-256', 33],
  ['did:key:z82Lm1MpAkeJcix9K8TMiLd5NMAhnwkjjCBeWHXyu3U4oT2MVJJKXkcVBgjGhnLBn2Kaau9', 'P-384', 49],
];

test('did:key: the Ed25519 document has the Multikey shape of the spec', async () => {
  const did = VECTORS[0]![0];
  const mb = did.slice('did:key:'.length);
  const vm = `${did}#${mb}`;
  expect((await key.resolve(did, {}, ctx)).didDocument).toEqual({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [{ id: vm, type: 'Multikey', controller: did, publicKeyMultibase: mb }],
    authentication: [vm],
    assertionMethod: [vm],
    capabilityInvocation: [vm],
    capabilityDelegation: [vm],
  });
});

test('did:key: the spec vectors for 4 signing key types resolve', async () => {
  for (const [did, , length] of VECTORS) {
    const r = await key.resolve(did, {}, ctx);
    expect([did, code(r)]).toEqual([did, undefined]);
    expect(base58.decode(did.slice('did:key:z'.length)).length).toBe(length + 2);
    expect(r.didDocument?.assertionMethod).toHaveLength(1);
  }
});

test('did:key: an X25519 key is only a keyAgreement key', async () => {
  const x25519 = 'did:key:z' + base58.encode(Uint8Array.from([0xec, 0x01, ...new Uint8Array(32).fill(9)]));
  const doc = (await key.resolve(x25519, {}, ctx)).didDocument!;
  expect(doc.keyAgreement).toEqual([doc.verificationMethod![0]!.id]);
  expect(doc.assertionMethod).toBeUndefined();
});

test('did:key: the Ed25519 key bytes are the same as in Enbox, for 20 new keys', async () => {
  for (let i = 0; i < 20; i++) {
    const did = (await DidKey.create()).uri;
    const ours = (await key.resolve(did, {}, ctx)).didDocument!.verificationMethod![0]!;
    const theirs = (await DidKey.resolve(did)).didDocument!.verificationMethod![0]!;
    expect(base58.decode(ours.publicKeyMultibase!.slice(1)).subarray(2)).toEqual(base64urlnopad.decode(theirs.publicKeyJwk!.x!));
  }
});

test('did:key: invalid values give INVALID_DID', async () => {
  const enc = (bytes: number[]) => 'did:key:z' + base58.encode(Uint8Array.from(bytes));
  const ed = VECTORS[0]![0];
  const bad = [
    ed.replace('did:key:z', 'did:key:'), // no multibase prefix
    ed.slice(0, -1) + '0', // 0 is not base58
    'did:key:1:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', // version form, not in the ABNF
    enc([0xed, 0x01, ...new Uint8Array(31)]), // short Ed25519 key
    enc([0xe7, 0x01, 0x04, ...new Uint8Array(32)]), // secp256k1, not a compressed point
    enc([0x12, 0x00, ...new Uint8Array(32)]), // unknown multicodec
    'did:key:z',
  ];
  for (const did of bad) expect([did, code(await key.resolve(did, {}, ctx))]).toEqual([did, 'INVALID_DID']);
});

const didJwkOf = (k: object) => 'did:jwk:' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(k)));

test('did:jwk: the spec P-256 example', async () => {
  // https://github.com/quartzjer/did-jwk/blob/main/spec.md, "Examples".
  const did = 'did:jwk:eyJjcnYiOiJQLTI1NiIsImt0eSI6IkVDIiwieCI6ImFjYklRaXVNczNpOF91c3pFakoydHBUdFJNNEVVM3l6OTFQSDZDZEgyVjAiLCJ5IjoiX0tjeUxqOXZXTXB0bm1LdG00NkdxRHo4d2Y3NEk1TEtncmwyR3pIM25TRSJ9';
  const vm = `${did}#0`;
  expect((await jwk.resolve(did, {}, ctx)).didDocument).toEqual({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: did,
    verificationMethod: [{
      id: vm,
      type: 'JsonWebKey2020',
      controller: did,
      publicKeyJwk: { crv: 'P-256', kty: 'EC', x: 'acbIQiuMs3i8_uszEjJ2tpTtRM4EU3yz91PH6CdH2V0', y: '_KcyLj9vWMptnmKtm46GqDz8wf74I5LKgrl2GzH3nSE' },
    }],
    assertionMethod: [vm],
    authentication: [vm],
    capabilityInvocation: [vm],
    capabilityDelegation: [vm],
    keyAgreement: [vm],
  });
});

test('did:jwk: "use" limits the relationships', async () => {
  const x = base64urlnopad.encode(new Uint8Array(32));
  const sig = (await jwk.resolve(didJwkOf({ kty: 'OKP', crv: 'Ed25519', x, use: 'sig' }), {}, ctx)).didDocument!;
  expect([sig.keyAgreement, sig.assertionMethod?.length]).toEqual([undefined, 1]);
  const enc = (await jwk.resolve(didJwkOf({ kty: 'OKP', crv: 'X25519', x, use: 'enc' }), {}, ctx)).didDocument!;
  expect([enc.keyAgreement?.length, enc.assertionMethod]).toEqual([1, undefined]);
});

test('did:jwk: the key is the same as in Enbox, for 10 new keys', async () => {
  for (let i = 0; i < 10; i++) {
    const did = (await DidJwk.create()).uri;
    const ours = (await jwk.resolve(did, {}, ctx)).didDocument!.verificationMethod![0]!;
    const theirs = (await DidJwk.resolve(did)).didDocument!.verificationMethod![0]!;
    expect(ours.publicKeyJwk).toEqual(theirs.publicKeyJwk as never);
  }
});

test('did:jwk: a private key, a bad key and bad encoding give INVALID_DID', async () => {
  const x = base64urlnopad.encode(new Uint8Array(32));
  const bad = [
    didJwkOf({ kty: 'OKP', crv: 'Ed25519', x, d: x }), // private key
    didJwkOf({ kty: 'oct', k: x }), // symmetric key
    didJwkOf({ kty: 'EC', crv: 'P-256', x }), // no y
    didJwkOf({ crv: 'Ed25519', x }), // no kty
    didJwkOf([1, 2]),
    'did:jwk:' + base64urlnopad.encode(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d])), // not UTF-8
    'did:jwk:e30=', // padding
    'did:jwk:not.base64',
  ];
  for (const did of bad) expect([did, code(await jwk.resolve(did, {}, ctx))]).toEqual([did, 'INVALID_DID']);
});
