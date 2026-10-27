// did:key driver (W3C CCG did:key v0.9). No DID library: the DID holds the public key.
// The document uses the Multikey type. It has no keyAgreement key derived from Ed25519.
import { base58 } from '@scure/base';
import { failure } from '../errors.ts';
import type { DidDocument, DidMethodDriver, DidResolutionResult } from '../types.ts';

interface KeyType {
  name: string;
  prefix: readonly [number, number]; // the multicodec varint
  length: number;
  compressedPoint: boolean;
  signing: boolean;
}

const KEY_TYPES: readonly KeyType[] = [
  { name: 'Ed25519', prefix: [0xed, 0x01], length: 32, compressedPoint: false, signing: true },
  { name: 'X25519', prefix: [0xec, 0x01], length: 32, compressedPoint: false, signing: false },
  { name: 'secp256k1', prefix: [0xe7, 0x01], length: 33, compressedPoint: true, signing: true },
  { name: 'P-256', prefix: [0x80, 0x24], length: 33, compressedPoint: true, signing: true },
  { name: 'P-384', prefix: [0x81, 0x24], length: 49, compressedPoint: true, signing: true },
];

const MB_RE = /^z[1-9A-HJ-NP-Za-km-z]+$/;

export function keyDriver(): DidMethodDriver {
  return {
    method: 'key',
    verification: 'deterministic',
    history: false,
    freshMs: Number.POSITIVE_INFINITY,
    async resolve(did) {
      return resolveKey(did);
    },
  };
}

function resolveKey(did: string): DidResolutionResult {
  const mb = did.slice('did:key:'.length);
  if (!did.startsWith('did:key:') || !MB_RE.test(mb)) return failure('INVALID_DID', 'did:key needs one base58-btc multibase value (z...)');
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(mb.slice(1));
  } catch {
    return failure('INVALID_DID', 'the multibase value is not base58-btc');
  }
  const type = KEY_TYPES.find((t) => bytes[0] === t.prefix[0] && bytes[1] === t.prefix[1]);
  if (!type) return failure('INVALID_DID', 'the multicodec key type is not supported');
  const key = bytes.subarray(2);
  if (key.length !== type.length) return failure('INVALID_DID', `a ${type.name} key has ${type.length} bytes, not ${key.length}`);
  if (type.compressedPoint && key[0] !== 0x02 && key[0] !== 0x03) return failure('INVALID_DID', `the ${type.name} key is not a compressed point`);

  const vmId = `${did}#${mb}`;
  const doc: DidDocument = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [{ id: vmId, type: 'Multikey', controller: did, publicKeyMultibase: mb }],
  };
  if (type.signing) {
    doc.authentication = [vmId];
    doc.assertionMethod = [vmId];
    doc.capabilityInvocation = [vmId];
    doc.capabilityDelegation = [vmId];
  } else {
    doc.keyAgreement = [vmId];
  }
  return { didResolutionMetadata: { source: 'did', verification: 'deterministic' }, didDocument: doc, didDocumentMetadata: {} };
}
