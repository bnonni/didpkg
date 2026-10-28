// @didpkg/core/trust: JCS, DID verification method keys, Data Integrity proofs, digests,
// the signed release objects and the release verifier.
export { TrustError, PolicyError } from './errors.ts';
export type { TrustErrorCode, TrustReason, PolicyCode } from './errors.ts';
export { jcs, jcsBytes } from './jcs.ts';
export { toMultikey, fromMultikey, fromJwk, publicKeyOf, keyForRelationship } from './keys.ts';
export type { KeyAlg, PublicKey, VerificationRelationship } from './keys.ts';
export { CRYPTOSUITES, ed25519Signer, bip340Signer, addProof, verifyProof } from './proof.ts';
export type { Cryptosuite, DataIntegrityProof, Signer, VerifiedProof } from './proof.ts';
export { sri, contentDigest } from './digest.ts';
export type { SriAlgorithm } from './digest.ts';
export { RELEASE_STATUSES, parseRelease, parseIndex, proofsOf, signObject } from './release.ts';
export type { DidPkgRelease, DidPkgIndex, IndexEntry, ReleaseStatus } from './release.ts';
export { verifyIndex, verifyRelease } from './verify.ts';
export type {
  ReleaseReader, Pin, TrustStore, PolicyMode, VerifyIndexOptions, VerifyReleaseOptions,
  PolicyWarning, Continuity, VerifiedIndex, VerifiedRelease,
} from './verify.ts';
