// Data Integrity proofs, JCS family: eddsa-jcs-2022 (VC DI EdDSA 1.0, W3C Recommendation 2025-05-15,
// section 3.3) and bip340-jcs-2025 (Data Integrity BIP340 Cryptosuites v0.1, an Editor's Draft).
// One proof per document. A proof set (an array) is not supported.
import * as ed from '@noble/ed25519';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import type { DidDocument } from '../did/types.ts';
import { TrustError, type TrustErrorCode, type TrustReason } from './errors.ts';
import { jcs, jcsBytes } from './jcs.ts';
import { keyForRelationship, publicKeyOf, type KeyAlg, type VerificationRelationship } from './keys.ts';

export const CRYPTOSUITES = ['eddsa-jcs-2022', 'bip340-jcs-2025'] as const;
export type Cryptosuite = (typeof CRYPTOSUITES)[number];

const SUITE_ALG: Record<Cryptosuite, KeyAlg> = { 'eddsa-jcs-2022': 'Ed25519', 'bip340-jcs-2025': 'secp256k1' };
// XML Schema 1.1 dateTimeStamp (a time zone is necessary).
export const DATE_TIME_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export interface DataIntegrityProof {
  type: 'DataIntegrityProof';
  cryptosuite: Cryptosuite;
  created?: string;
  verificationMethod: string;
  proofPurpose: string;
  '@context'?: unknown;
  proofValue?: string;
  [property: string]: unknown;
}

export interface Signer {
  verificationMethod: string;
  cryptosuite: Cryptosuite;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface VerifiedProof {
  verificationMethod: string;
  created?: string;
}

/** An eddsa-jcs-2022 signer. `secretKey` is the 32-byte Ed25519 seed (RFC 8032). */
export const ed25519Signer = (secretKey: Uint8Array, verificationMethod: string): Signer => ({
  verificationMethod,
  cryptosuite: 'eddsa-jcs-2022',
  sign: (data) => ed.signAsync(data, secretKey),
});

/** A bip340-jcs-2025 signer. `secretKey` is the 32-byte secp256k1 secret key. */
export const bip340Signer = (secretKey: Uint8Array, verificationMethod: string): Signer => ({
  verificationMethod,
  cryptosuite: 'bip340-jcs-2025',
  sign: async (data) => schnorr.sign(data, secretKey),
});

const isCryptosuite = (v: unknown): v is Cryptosuite => (CRYPTOSUITES as readonly unknown[]).includes(v);

// Proof configuration (eddsa-jcs-2022 section 3.3.5): the type, the cryptosuite and `created`.
function checkConfig(config: Record<string, unknown>, code: TrustErrorCode): void {
  const fail = (reason: TrustReason, message: string) => new TrustError(code, reason, message);
  if (config.type !== 'DataIntegrityProof') throw fail('malformed-proof', 'proof type is not DataIntegrityProof');
  if (!isCryptosuite(config.cryptosuite)) throw fail('cryptosuite', `cryptosuite ${String(config.cryptosuite)} is not allowed`);
  const created = config.created;
  if (created !== undefined && (typeof created !== 'string' || !DATE_TIME_STAMP.test(created) || Number.isNaN(Date.parse(created)))) {
    throw fail('malformed-proof', `created ${String(created)} is not an XML Schema dateTimeStamp`);
  }
}

// Hashing (eddsa-jcs-2022 section 3.3.4): SHA-256(JCS(proof config)) then SHA-256(JCS(document)).
// bip340-jcs-2025 hashes the 64 bytes once more with SHA-256.
function hashData(suite: Cryptosuite, config: object, document: object): Uint8Array {
  const both = new Uint8Array(64);
  both.set(sha256(jcsBytes(config)));
  both.set(sha256(jcsBytes(document)), 32);
  return suite === 'bip340-jcs-2025' ? sha256(both) : both;
}

/** Create Proof (section 3.3.1). An existing `proof` member is replaced. */
export async function addProof<T extends Record<string, unknown>>(
  document: T,
  signer: Signer,
  options: { created?: string; proofPurpose?: VerificationRelationship } = {},
): Promise<Omit<T, 'proof'> & { proof: DataIntegrityProof }> {
  const { proof: _replaced, ...unsecured } = document;
  const proof: DataIntegrityProof = {
    type: 'DataIntegrityProof',
    cryptosuite: signer.cryptosuite,
    created: options.created ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    verificationMethod: signer.verificationMethod,
    proofPurpose: options.proofPurpose ?? 'assertionMethod',
  };
  if (unsecured['@context'] !== undefined) proof['@context'] = unsecured['@context'];
  checkConfig(proof, 'PROOF_GENERATION_ERROR');
  const signature = await signer.sign(hashData(signer.cryptosuite, proof, unsecured));
  if (signature.length !== 64) throw new TrustError('PROOF_GENERATION_ERROR', 'signature', `signature is ${signature.length} bytes, expected 64`);
  return { ...unsecured, proof: { ...proof, proofValue: 'z' + base58.encode(signature) } } as Omit<T, 'proof'> & { proof: DataIntegrityProof };
}

/**
 * Verify Proof (section 3.3.2). `didDocument` must hold the key in the `expectedPurpose` relationship.
 * Throws a TrustError if the proof does not verify.
 */
export async function verifyProof(
  secured: Record<string, unknown>,
  didDocument: DidDocument,
  expectedPurpose: VerificationRelationship = 'assertionMethod',
): Promise<VerifiedProof> {
  const fail = (reason: TrustReason, message: string) => new TrustError('PROOF_VERIFICATION_ERROR', reason, message);
  const { proof, ...unsecured } = secured;
  if (Array.isArray(proof)) throw fail('malformed-proof', 'a proof set is not supported');
  if (proof === null || typeof proof !== 'object') throw fail('malformed-proof', 'no proof');
  const { proofValue, ...config } = proof as Record<string, unknown>;
  checkConfig(config, 'PROOF_VERIFICATION_ERROR');
  const { cryptosuite, verificationMethod, proofPurpose } = config as unknown as DataIntegrityProof;
  if (proofPurpose !== expectedPurpose) throw fail('proof-purpose', `proofPurpose ${String(proofPurpose)} is not ${expectedPurpose}`);
  if (typeof verificationMethod !== 'string') throw fail('malformed-proof', 'no verificationMethod');
  if (typeof proofValue !== 'string' || !proofValue.startsWith('z')) throw fail('malformed-proof', 'proofValue is not base58-btc');
  let signature: Uint8Array;
  try {
    signature = base58.decode(proofValue.slice(1));
  } catch {
    throw fail('malformed-proof', 'proofValue is not base58-btc');
  }
  // Step 4: the document @context must start with the proof @context. Then the proof @context replaces it.
  if (config['@context'] !== undefined) {
    const own = ([] as unknown[]).concat(config['@context']);
    const doc = ([] as unknown[]).concat(unsecured['@context'] ?? []);
    if (own.length > doc.length || !own.every((c, i) => jcs(c) === jcs(doc[i]))) {
      throw fail('context', 'the document @context does not start with the proof @context');
    }
    unsecured['@context'] = config['@context'];
  }
  const key = publicKeyOf(keyForRelationship(didDocument, verificationMethod, expectedPurpose));
  if (key.alg !== SUITE_ALG[cryptosuite]) throw fail('key', `${cryptosuite} needs an ${SUITE_ALG[cryptosuite]} key, not ${key.alg}`);
  const data = hashData(cryptosuite, config, unsecured);
  let ok = false;
  try {
    // zip215: false is the strict RFC 8032 check.
    ok = cryptosuite === 'eddsa-jcs-2022'
      ? await ed.verifyAsync(signature, data, key.bytes, { zip215: false })
      : schnorr.verify(signature, data, key.bytes.slice(1)); // BIP340 uses the x-only key
  } catch {
    ok = false;
  }
  if (!ok) throw fail('signature', 'the signature does not verify');
  return typeof config.created === 'string' ? { verificationMethod, created: config.created } : { verificationMethod };
}
