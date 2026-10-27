// W3C eddsa-jcs-2022 test vector (VC DI EdDSA 1.0, W3C Recommendation 2025-05-15, appendix
// "Representation: eddsa-jcs-2022", Examples 29-39). Port of research script 01-di-jcs-testvector.ts.
import { expect, test } from 'bun:test';
import * as ed from '@noble/ed25519';
import { base58, base64urlnopad } from '@scure/base';
import { jwkDriver } from '../../src/did/drivers/jwk.ts';
import { keyDriver } from '../../src/did/drivers/key.ts';
import type { DidDocument } from '../../src/did/types.ts';
import { addProof, ed25519Signer, verifyProof } from '../../src/trust/index.ts';
import { failure } from './helpers.ts';

const PUBLIC_MB = 'z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
// The W3C spec publishes this test secret key. It is not a secret.
const SECRET_MB = 'z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq'; // gitleaks:allow
const PROOF_VALUE = 'z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX';
const CREATED = '2023-02-24T23:36:38Z';
const DID = `did:key:${PUBLIC_MB}`;
const VM = `${DID}#${PUBLIC_MB}`;
const credential = {
  '@context': ['https://www.w3.org/ns/credentials/v2', 'https://www.w3.org/ns/credentials/examples/v2'],
  id: 'urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33',
  type: ['VerifiableCredential', 'AlumniCredential'],
  name: 'Alumni Credential',
  description: 'A minimum viable example of an Alumni Credential.',
  issuer: 'https://vc.example/issuers/5678',
  validFrom: '2023-01-01T00:00:00Z',
  credentialSubject: { id: 'did:example:abcdefgh', alumniOf: 'The School of Examples' },
};
const ctx = { signal: new AbortController().signal };

// The secret key is a Multikey with the ed25519-priv header (0x1300, varint 0x80 0x26).
function seed(): Uint8Array {
  const bytes = base58.decode(SECRET_MB.slice(1));
  expect([bytes[0], bytes[1], bytes.length]).toEqual([0x80, 0x26, 34]);
  return bytes.slice(2);
}

const signVector = () => addProof(credential, ed25519Signer(seed(), VM), { created: CREATED });

test('eddsa-jcs-2022: addProof gives the proofValue of the W3C vector', async () => {
  const signed = await signVector();
  expect(signed.proof).toEqual({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: CREATED,
    verificationMethod: VM,
    proofPurpose: 'assertionMethod',
    '@context': credential['@context'],
    proofValue: PROOF_VALUE,
  });
});

test('eddsa-jcs-2022: the vector verifies against the did:key document of the resolver (Multikey)', async () => {
  const result = await keyDriver().resolve(DID, {}, ctx);
  const doc = result.didDocument!;
  expect(doc.verificationMethod?.[0]?.publicKeyMultibase).toBe(PUBLIC_MB);
  expect(await verifyProof(await signVector(), doc)).toEqual({ verificationMethod: VM, created: CREATED });
});

test('eddsa-jcs-2022: the same key verifies from a did:jwk document of the resolver (publicKeyJwk)', async () => {
  const x = base64urlnopad.encode(await ed.getPublicKeyAsync(seed()));
  const did = 'did:jwk:' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })));
  const doc = (await jwkDriver().resolve(did, {}, ctx)).didDocument as DidDocument;
  expect(doc.verificationMethod?.[0]?.publicKeyJwk?.x).toBe(x);
  const signed = await addProof(credential, ed25519Signer(seed(), `${did}#0`), { created: CREATED });
  expect(await verifyProof(signed, doc)).toEqual({ verificationMethod: `${did}#0`, created: CREATED });
});

test('eddsa-jcs-2022: a changed vector document fails', async () => {
  const doc = (await keyDriver().resolve(DID, {}, ctx)).didDocument!;
  const signed = await signVector();
  expect(await failure(() => verifyProof({ ...signed, name: 'Other Credential' }, doc))).toBe('PROOF_VERIFICATION_ERROR signature');
  const proof = { ...signed.proof, created: '2023-02-24T23:36:39Z' };
  expect(await failure(() => verifyProof({ ...signed, proof }, doc))).toBe('PROOF_VERIFICATION_ERROR signature');
});
