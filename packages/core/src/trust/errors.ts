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
