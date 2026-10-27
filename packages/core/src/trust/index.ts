// @didpkg/core/trust: JCS, DID verification method keys, Data Integrity proofs, digests.
export { TrustError } from './errors.ts';
export type { TrustErrorCode, TrustReason } from './errors.ts';
export { jcs, jcsBytes } from './jcs.ts';
export { toMultikey, fromMultikey, fromJwk, publicKeyOf, keyForRelationship } from './keys.ts';
export type { KeyAlg, PublicKey, VerificationRelationship } from './keys.ts';
export { CRYPTOSUITES, ed25519Signer, bip340Signer, addProof, verifyProof } from './proof.ts';
export type { Cryptosuite, DataIntegrityProof, Signer, VerifiedProof } from './proof.ts';
export { sri, contentDigest } from './digest.ts';
export type { SriAlgorithm } from './digest.ts';
