// DID Core 1.0 documents and W3C DID Resolution v1 (CRD 2026-10-26, section 4) result shapes.

export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  use?: string;
  [member: string]: unknown;
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase?: string;
  publicKeyJwk?: Jwk;
  [property: string]: unknown;
}

export interface Service {
  id: string;
  type: string | string[];
  serviceEndpoint: unknown;
  [property: string]: unknown;
}

export type Relationship = (string | VerificationMethod)[];

export interface DidDocument {
  '@context'?: unknown;
  id: string;
  controller?: string | string[];
  alsoKnownAs?: string[];
  verificationMethod?: VerificationMethod[];
  authentication?: Relationship;
  assertionMethod?: Relationship;
  keyAgreement?: Relationship;
  capabilityInvocation?: Relationship;
  capabilityDelegation?: Relationship;
  service?: Service[];
  [property: string]: unknown;
}

/** An RFC 9457 problem object. `type` is `https://www.w3.org/ns/did#<CODE>`. */
export interface DidProblem {
  type: string;
  title?: string;
  detail?: string;
}

/**
 * How the driver knows that the document is correct (didpkg extension):
 * - deterministic: the DID holds the key (did:key, did:jwk).
 * - cryptographic: a signature by the DID key covers the document (did:dht).
 * - partial: some history is not checked.
 * - tofu: the host is the only authority (did:web).
 */
export type Verification = 'deterministic' | 'cryptographic' | 'partial' | 'tofu';

export interface DidResolutionMetadata {
  contentType?: string;
  error?: DidProblem;
  // didpkg extensions:
  /** Where the document came from, for example the relay URL. */
  source?: string;
  /** The time of the driver call (ISO 8601, seconds). */
  retrieved?: string;
  /** The result came from the cache after a transient failure. */
  stale?: boolean;
  /** The failure can go away on a retry (network, timeout, HTTP 429 or 5xx). */
  transient?: boolean;
  verification?: Verification;
}

export interface DidDocumentMetadata {
  created?: string;
  updated?: string;
  deactivated?: boolean;
  versionId?: string;
  [property: string]: unknown;
}

export interface DidResolutionResult {
  didResolutionMetadata: DidResolutionMetadata;
  didDocument: DidDocument | null;
  didDocumentMetadata: DidDocumentMetadata;
}

export interface DidResolutionOptions {
  accept?: string;
  versionId?: string;
  versionTime?: string;
  /** Do not read the cache. The fresh result goes into the cache. */
  noCache?: boolean;
}

export interface DriverContext {
  /** Aborts when the per-DID time limit ends. */
  signal: AbortSignal;
}

/**
 * One driver per DID method. A driver returns a result and does not throw.
 * `DidResolver` does the checks that apply to all methods (syntax, options, `didDocument.id`).
 */
export interface DidMethodDriver {
  readonly method: string;
  readonly verification: Verification;
  /** true if the method has a verifiable history (versionId, versionTime). */
  readonly history: boolean;
  /** How long a result stays fresh in the cache, in milliseconds. */
  readonly freshMs: number;
  resolve(did: string, options: DidResolutionOptions, ctx: DriverContext): Promise<DidResolutionResult>;
}
