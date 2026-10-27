// Digests: Subresource Integrity strings (W3C SRI, `dist.integrity` in npm) and the content id of signed JSON.
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { jcsBytes } from './jcs.ts';

export type SriAlgorithm = 'sha256' | 'sha512';

/** The SRI string of the bytes, for example `sha512-<base64>`. */
export async function sri(algorithm: SriAlgorithm, bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm === 'sha256' ? 'SHA-256' : 'SHA-512', bytes as Uint8Array<ArrayBuffer>);
  return `${algorithm}-${base64.encode(new Uint8Array(digest))}`;
}

/** The content id of a signed JSON object: SHA-256 of JCS(object without `proof`). */
export function contentDigest(object: Record<string, unknown>): string {
  const { proof: _proof, ...rest } = object;
  return `sha256-${base64.encode(sha256(jcsBytes(rest)))}`;
}
