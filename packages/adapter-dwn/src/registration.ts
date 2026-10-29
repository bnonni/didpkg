// Tenant registration on a dwn-server 0.1.45: the terms of service and a proof of work. Entry point `@didpkg/adapter-dwn/registration`.
// The caller shows the terms text to the user. `register` agrees only to the hash of that text, so the server refuses
// the registration if its terms changed after the user read them.
// The registration does not prove control of the DID. The DWN still checks each write against the DID document.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const te = new TextEncoder();
const HEX64 = /^[0-9a-fA-F]{64}$/;

export interface Terms {
  text: string;
  /** The lowercase SHA-256 hex of the UTF-8 text, as the server computes it. */
  hash: string;
}

export interface Challenge {
  challengeNonce: string;
  maximumAllowedHashValue: string;
}

export interface RegisterOptions {
  /** The terms that the user agreed to. Omit them only for a server without terms. */
  terms?: Terms;
  signal?: AbortSignal;
  /** Gets the number of hashes so far, after each 65,536 hashes. */
  onProgress?: (hashes: number) => void;
}

const endpoint = (dwnUrl: string, path: string) => `${dwnUrl.replace(/\/+$/, '')}/registration${path}`;

async function fail(what: string, res: Response): Promise<never> {
  throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`.trim());
}

/** The terms of service of a DWN, or `undefined` if the server has none (404). */
export async function getTerms(dwnUrl: string, { signal }: { signal?: AbortSignal } = {}): Promise<Terms | undefined> {
  const res = await fetch(endpoint(dwnUrl, '/terms-of-service'), { signal });
  if (res.status === 404) return undefined;
  if (!res.ok) return fail('terms of service', res);
  const text = await res.text();
  return { text, hash: bytesToHex(sha256(te.encode(text))) };
}

/** Registers `did` as a tenant of the DWN. At the default server difficulty, this takes about 2^24 hashes. */
export async function register(dwnUrl: string, did: string, { terms, signal, onProgress }: RegisterOptions = {}): Promise<void> {
  const res = await fetch(endpoint(dwnUrl, '/proof-of-work'), { signal });
  if (!res.ok) return fail('proof-of-work challenge', res);
  const challenge = (await res.json()) as Challenge;
  // The server hashes JSON.stringify of the registrationData that it parsed, so the key order stays the same.
  const registrationData = terms ? { did, termsOfServiceHash: terms.hash } : { did };
  const responseNonce = await solve(challenge, JSON.stringify(registrationData), { signal, onProgress });
  const post = await fetch(endpoint(dwnUrl, ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ registrationData, proofOfWork: { challengeNonce: challenge.challengeNonce, responseNonce } }),
    signal,
  });
  if (!post.ok) return fail('registration', post);
}

/**
 * Finds a response nonce of 64 hex digits. The SHA-256 of challengeNonce + responseNonce + requestData,
 * as a 256-bit number, must not be more than maximumAllowedHashValue.
 */
export async function solve({ challengeNonce, maximumAllowedHashValue }: Challenge, requestData: string,
  { signal, onProgress }: Omit<RegisterOptions, 'terms'> = {}): Promise<string> {
  if (!HEX64.test(challengeNonce) || !HEX64.test(maximumAllowedHashValue)) throw new Error('proof-of-work challenge: not 64 hex digits');
  const max = hexToBytes(maximumAllowedHashValue);
  const head = sha256.create().update(te.encode(challengeNonce));
  const data = te.encode(requestData);
  // 48 random hex digits, then a counter of 16 hex digits. The counter changes in place.
  const nonce = te.encode(bytesToHex(crypto.getRandomValues(new Uint8Array(24))) + '0'.repeat(16));
  for (let n = 1; ; n++) {
    if (notMore(head.clone().update(nonce).update(data).digest(), max)) return new TextDecoder().decode(nonce);
    increment(nonce);
    if (n % 65536 === 0) {
      signal?.throwIfAborted();
      onProgress?.(n);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** a <= b, as big-endian numbers of the same length. */
function notMore(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return true;
}

/** Adds 1 to the ASCII hex number in the last 16 bytes. */
function increment(hex: Uint8Array): void {
  for (let i = hex.length - 1; i >= hex.length - 16; i--) {
    const c = hex[i]!;
    if (c === 0x66) { hex[i] = 0x30; continue; } // f -> 0, carry
    hex[i] = c === 0x39 ? 0x61 : c + 1; // 9 -> a
    return;
  }
}
