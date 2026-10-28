// Data Integrity errors. `code` is a processing error of VC Data Integrity 1.0
// (W3C Recommendation 2025-05-15, section 4.7). `reason` is the didpkg detail.
// addProof gives PROOF_GENERATION_ERROR, verifyProof gives PROOF_VERIFICATION_ERROR,
// and a value with no JCS form gives PROOF_TRANSFORMATION_ERROR.

export type TrustErrorCode = 'PROOF_GENERATION_ERROR' | 'PROOF_VERIFICATION_ERROR' | 'PROOF_TRANSFORMATION_ERROR';

export type TrustReason =
  /** The value has no JCS form (RFC 8785). */
  | 'jcs'
  /** No proof, a proof set, or a bad proof member. */
  | 'malformed-proof'
  /** A cryptosuite other than eddsa-jcs-2022 and bip340-jcs-2025. */
  | 'cryptosuite'
  /** The proofPurpose is not the expected purpose. */
  | 'proof-purpose'
  /** The document @context does not start with the proof @context. */
  | 'context'
  /** The relationship does not hold the method, or the DID does not control it. */
  | 'verification-method'
  /** The key material is missing, private, not valid, or the wrong type for the cryptosuite. */
  | 'key'
  /** The signature does not verify. */
  | 'signature';

export class TrustError extends Error {
  constructor(readonly code: TrustErrorCode, readonly reason: TrustReason, message: string) {
    super(message);
    this.name = 'TrustError';
  }
}

/**
 * Release policy codes (trust policy v1). A PolicyError carries one of them.
 * KEY_CHANGED and HISTORY_CHANGED are TOFU events: they obey the mode. DEPRECATED is only a warning.
 * All other codes are hard failures, in each mode.
 */
export type PolicyCode =
  /** The DID did not resolve, or the resolver returned the document of another DID. */
  | 'DID_RESOLUTION'
  | 'DID_DEACTIVATED'
  | 'INDEX_MISSING'
  /** The index is not a valid DidPkgIndex. */
  | 'INDEX_SCHEMA'
  /** The index publisher or name is not the requested DID or name. */
  | 'INDEX_FIELDS'
  /** No index proof by a key that is in assertionMethod now. */
  | 'INDEX_SIGNATURE'
  /** The index key is new, and no pinned key co-signs the index. */
  | 'KEY_CHANGED'
  /** A pinned release changed or left the index. */
  | 'HISTORY_CHANGED'
  /** The index sequence is lower than the pinned sequence of the same key. */
  | 'ROLLBACK'
  /** The index sequence is the pinned sequence, but the index is different. */
  | 'EQUIVOCATION'
  | 'NOT_LISTED'
  | 'REVOKED'
  /** A yanked version installs only with an exact lockfile pin. */
  | 'YANKED'
  | 'DEPRECATED'
  | 'MANIFEST_MISSING'
  /** The manifest is not a valid DidPkgRelease. */
  | 'MANIFEST_SCHEMA'
  /** The manifest digest is not the digest in the signed index. */
  | 'MANIFEST_DIGEST'
  /** The manifest publisher, name or version is not the requested value. */
  | 'MANIFEST_FIELDS'
  /** A manifest proof names a method of another DID. */
  | 'MANIFEST_SIGNATURE'
  | 'TARBALL_MISSING'
  /** The tarball size or sha512 is not the value in the signed manifest. */
  | 'INTEGRITY';

export class PolicyError extends Error {
  constructor(readonly code: PolicyCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PolicyError';
  }
}
