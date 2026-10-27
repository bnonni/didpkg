// Public keys of DID Core 1.0 verification methods (section 5.2). The resolver returns each
// document unchanged: did:dht and did:jwk give publicKeyJwk (RFC 7517, RFC 8037), and did:key
// and did:web give publicKeyMultibase (Multikey, W3C Controlled Identifiers 1.0).
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base58, base64urlnopad } from '@scure/base';
import type { DidDocument, Jwk, VerificationMethod } from '../did/types.ts';
import { TrustError } from './errors.ts';

export type KeyAlg = 'Ed25519' | 'secp256k1';

/** A public key. Ed25519: 32 bytes. secp256k1: 33 bytes, compressed (SEC 1). */
export interface PublicKey {
  alg: KeyAlg;
  bytes: Uint8Array;
}

export type VerificationRelationship =
  | 'authentication'
  | 'assertionMethod'
  | 'keyAgreement'
  | 'capabilityInvocation'
  | 'capabilityDelegation';

// Multicodec headers (varint): ed25519-pub 0xed, secp256k1-pub 0xe7.
const HEADER: Record<KeyAlg, readonly [number, number]> = { Ed25519: [0xed, 0x01], secp256k1: [0xe7, 0x01] };
const LENGTH: Record<KeyAlg, number> = { Ed25519: 32, secp256k1: 33 };
// RFC 7518 section 6: the private members of EC, RSA and oct keys. RFC 8037 uses "d" for OKP.
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

const keyError = (message: string) => new TrustError('PROOF_VERIFICATION_ERROR', 'key', message);

function checked(alg: KeyAlg, bytes: Uint8Array): PublicKey {
  if (bytes.length !== LENGTH[alg]) throw keyError(`${alg} key: ${bytes.length} bytes, expected ${LENGTH[alg]}`);
  if (alg === 'secp256k1') {
    try {
      secp256k1.Point.fromBytes(bytes);
    } catch {
      throw keyError('secp256k1 key: not a point on the curve');
    }
  }
  return { alg, bytes };
}

export function toMultikey(key: PublicKey): string {
  const { alg, bytes } = checked(key.alg, key.bytes);
  return 'z' + base58.encode(Uint8Array.from([...HEADER[alg], ...bytes]));
}

export function fromMultikey(multibase: string): PublicKey {
  if (!multibase.startsWith('z')) throw keyError('Multikey: not base58-btc');
  let b: Uint8Array;
  try {
    b = base58.decode(multibase.slice(1));
  } catch {
    throw keyError('Multikey: not base58-btc');
  }
  for (const alg of ['Ed25519', 'secp256k1'] as const) {
    if (b[0] === HEADER[alg][0] && b[1] === HEADER[alg][1]) return checked(alg, b.slice(2));
  }
  throw keyError('Multikey: unsupported key type');
}

function member(jwk: Jwk, name: 'x' | 'y'): Uint8Array {
  const value = jwk[name];
  if (typeof value !== 'string') throw keyError(`JWK: no ${name}`);
  try {
    return base64urlnopad.decode(value);
  } catch {
    throw keyError(`JWK: ${name} is not base64url`);
  }
}

/** DID Core 1.0 section 5.2.1: publicKeyJwk must not hold a private member. */
export function fromJwk(jwk: Jwk): PublicKey {
  const found = PRIVATE_MEMBERS.filter((m) => m in jwk);
  if (found.length > 0) throw keyError(`JWK: private member ${found.join(', ')}`);
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return checked('Ed25519', member(jwk, 'x'));
  if (jwk.kty === 'EC' && jwk.crv === 'secp256k1') {
    const x = member(jwk, 'x');
    const y = member(jwk, 'y');
    if (x.length !== 32 || y.length !== 32) throw keyError('JWK: secp256k1 x and y must be 32 bytes');
    try {
      return { alg: 'secp256k1', bytes: secp256k1.Point.fromBytes(Uint8Array.from([0x04, ...x, ...y])).toBytes(true) };
    } catch {
      throw keyError('JWK: secp256k1 x and y are not a point on the curve');
    }
  }
  throw keyError(`JWK: unsupported key (kty ${String(jwk.kty)}, crv ${String(jwk.crv)})`);
}

/** DID Core 1.0 section 5.2.1: a method has one form of key material. */
export function publicKeyOf(vm: VerificationMethod): PublicKey {
  const { publicKeyMultibase: mb, publicKeyJwk: jwk } = vm;
  if (mb !== undefined && jwk !== undefined) throw keyError(`${vm.id}: both publicKeyMultibase and publicKeyJwk`);
  if (typeof mb === 'string') return fromMultikey(mb);
  if (jwk !== null && typeof jwk === 'object') return fromJwk(jwk);
  throw keyError(`${vm.id}: no publicKeyMultibase or publicKeyJwk`);
}

const absolute = (doc: DidDocument, ref: string) => (ref.startsWith('#') ? doc.id + ref : ref);

/**
 * The method `vmId` if the DID document binds it to `relationship` (DID Core 1.0 section 5.3).
 * The method must be a fragment of the document `id`, and its controller must be the document `id`
 * (VC Data Integrity 1.0 section 2.6).
 */
export function keyForRelationship(
  doc: DidDocument,
  vmId: string,
  relationship: VerificationRelationship = 'assertionMethod',
): VerificationMethod {
  const fail = (message: string) => new TrustError('PROOF_VERIFICATION_ERROR', 'verification-method', message);
  if (!vmId.startsWith(doc.id + '#')) throw fail(`${vmId} is not a fragment of ${doc.id}`);
  const refs = doc[relationship];
  let vm: VerificationMethod | undefined;
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (typeof ref === 'string') {
      if (absolute(doc, ref) === vmId) vm = doc.verificationMethod?.find((v) => absolute(doc, v.id) === vmId);
    } else if (ref !== null && typeof ref === 'object' && absolute(doc, ref.id) === vmId) {
      vm = ref;
    }
    if (vm) break;
  }
  if (!vm) throw fail(`${vmId} is not in ${relationship}`);
  if (vm.controller !== doc.id) throw fail(`${vmId}: controller ${vm.controller} is not ${doc.id}`);
  return vm;
}
