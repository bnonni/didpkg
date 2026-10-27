// JSON Canonicalization Scheme (RFC 8785). canonicalize 5.1.0 throws for NaN, Infinity,
// a lone surrogate and a cycle, and gives undefined for a value with no JSON form.
import canonicalize from 'canonicalize';
import { TrustError } from './errors.ts';

const utf8 = new TextEncoder();

/** The JCS string of a JSON value. */
export function jcs(value: unknown): string {
  let text: string | undefined;
  try {
    text = canonicalize(value);
  } catch (e) {
    throw new TrustError('PROOF_TRANSFORMATION_ERROR', 'jcs', `JCS: ${(e as Error).message}`);
  }
  if (text === undefined) throw new TrustError('PROOF_TRANSFORMATION_ERROR', 'jcs', 'JCS: the value has no JSON form');
  return text;
}

/** The UTF-8 bytes of the JCS string. */
export const jcsBytes = (value: unknown): Uint8Array => utf8.encode(jcs(value));
