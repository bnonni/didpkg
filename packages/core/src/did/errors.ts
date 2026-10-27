// W3C DID Resolution v1 errors (CRD 2026-10-26, section 10) and the map from library error styles.
import type { DidProblem, DidResolutionMetadata, DidResolutionResult } from './types.ts';

export const DID_ERROR_NS = 'https://www.w3.org/ns/did#';

export const DID_ERROR_CODES = [
  'INVALID_DID',
  'INVALID_DID_DOCUMENT',
  'NOT_FOUND',
  'REPRESENTATION_NOT_SUPPORTED',
  'METHOD_NOT_SUPPORTED',
  'INVALID_OPTIONS',
  'INTERNAL_ERROR',
  'FEATURE_NOT_SUPPORTED',
] as const;
export type DidErrorCode = (typeof DID_ERROR_CODES)[number];

const CODES: ReadonlySet<string> = new Set(DID_ERROR_CODES);

export function problem(code: DidErrorCode, detail?: string): DidProblem {
  return detail ? { type: DID_ERROR_NS + code, title: code, detail } : { type: DID_ERROR_NS + code, title: code };
}

export function failure(code: DidErrorCode, detail?: string, extra: Partial<DidResolutionMetadata> = {}): DidResolutionResult {
  return { didResolutionMetadata: { ...extra, error: problem(code, detail) }, didDocument: null, didDocumentMetadata: {} };
}

/** The W3C code of a failed result, or undefined for a success. */
export function errorCode(result: DidResolutionResult): DidErrorCode | undefined {
  const type = result.didResolutionMetadata.error?.type;
  if (type === undefined) return undefined;
  const code = type.startsWith(DID_ERROR_NS) ? type.slice(DID_ERROR_NS.length) : '';
  return CODES.has(code) ? (code as DidErrorCode) : 'INTERNAL_ERROR';
}

// Style 1: legacy camelCase codes (did-resolver, web-did-resolver, the did:key spec, @enbox/dids DidError).
const LEGACY: Record<string, DidErrorCode> = {
  invalidDid: 'INVALID_DID',
  invalidPublicKey: 'INVALID_DID',
  invalidPublicKeyLength: 'INVALID_DID',
  invalidPublicKeyType: 'INVALID_DID',
  unsupportedPublicKeyType: 'INVALID_DID',
  invalidDidDocument: 'INVALID_DID_DOCUMENT',
  invalidDidDocumentLength: 'INVALID_DID_DOCUMENT',
  invalidSignature: 'INVALID_DID_DOCUMENT',
  notFound: 'NOT_FOUND',
  representationNotSupported: 'REPRESENTATION_NOT_SUPPORTED',
  methodNotSupported: 'METHOD_NOT_SUPPORTED',
  unsupportedDidMethod: 'METHOD_NOT_SUPPORTED',
  invalidOptions: 'INVALID_OPTIONS',
  featureNotSupported: 'FEATURE_NOT_SUPPORTED',
  internalError: 'INTERNAL_ERROR',
  // web-did-resolver uses it for a network failure, an HTTP failure and bad JSON.
  resolutionError: 'INTERNAL_ERROR',
};

function codeOf(error: unknown): DidErrorCode {
  if (typeof error === 'string') {
    if (CODES.has(error)) return error as DidErrorCode; // style 2: W3C codes as plain strings
    return LEGACY[error] ?? 'INTERNAL_ERROR';
  }
  if (error && typeof error === 'object' && typeof (error as DidProblem).type === 'string') {
    const type = (error as DidProblem).type; // style 3: RFC 9457 objects
    const code = type.startsWith(DID_ERROR_NS) ? type.slice(DID_ERROR_NS.length) : '';
    return CODES.has(code) ? (code as DidErrorCode) : 'INTERNAL_ERROR';
  }
  return 'INTERNAL_ERROR';
}

/**
 * Converts a library result to the W3C shape. The library error can be a camelCase code,
 * a W3C code string, or an RFC 9457 object. The caller sets `transient`.
 */
export function fromLibraryResult(raw: unknown): DidResolutionResult {
  const r = (raw ?? {}) as { didResolutionMetadata?: Record<string, unknown>; didDocument?: unknown; didDocumentMetadata?: unknown };
  const m = r.didResolutionMetadata ?? {};
  if (m.error !== undefined && m.error !== null) {
    const nested = typeof m.error === 'object' ? (m.error as DidProblem).detail : undefined;
    const detail = [m.errorMessage, m.message, nested].find((x) => typeof x === 'string' && x) as string | undefined;
    const original = typeof m.error === 'string' ? m.error : (m.error as DidProblem).type;
    return failure(codeOf(m.error), detail ?? String(original));
  }
  return {
    didResolutionMetadata: {},
    didDocument: (r.didDocument ?? null) as DidResolutionResult['didDocument'],
    didDocumentMetadata: (r.didDocumentMetadata ?? {}) as DidResolutionResult['didDocumentMetadata'],
  };
}

/** Converts a thrown value (for example an @enbox/dids DidError with a camelCase `code`) to a failed result. */
export function fromLibraryError(e: unknown): DidResolutionResult {
  const code = e && typeof e === 'object' && 'code' in e ? codeOf((e as { code: unknown }).code) : 'INTERNAL_ERROR';
  const detail = e instanceof Error ? e.message : String(e);
  return failure(code, detail);
}
