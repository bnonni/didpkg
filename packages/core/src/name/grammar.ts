// didpkg install-name grammar, draft 1 (2026-10-23). The grammar can change before 1.0.
// Source: didpkg@0.0.1 (src/grammar.ts), with no change to the code.
//
//   install-name = "@didpkg/" pkg-name "_" method [ "." case-mask ] "_" enc-id   ; direct form
//                / "@didpkg/" pkg-name "__" did-hash                             ; hash form
//
// The direct form carries the full DID. The hash form carries sha256(DID) and is used
// only when the direct form is longer than 214 characters.
// No runtime dependencies. Runs on Node >= 18 and on Bun.

import { createHash } from 'node:crypto';

export const SCOPE = '@didpkg';
export const MAX_NPM_NAME = 214; // validate-npm-package-name: warning above 214, so not valid for new packages
export const MAX_PKG_NAME = 64;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC 4648 base32, lowercase, no padding

// pkg-name: the publisher's package name. No "_" (it is the field separator).
export const PKG_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
// DID Core 1.0 section 3.1 ABNF (same in DID 1.1 CR 2026-03-05).
const IDCHAR = String.raw`(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})`;
export const DID_RE = new RegExp(String.raw`^did:([a-z0-9]+):((?:${IDCHAR}*:)*${IDCHAR}+)$`);
const METHOD_RE = /^[a-z0-9]+$/;
const MASK_RE = /^[a-z2-7]*[b-z2-7]$/; // non-empty, must not end in "a" (zero group)
const HASH_RE = /^[a-z2-7]{52}$/;

export class GrammarError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

// ---------- id codec: fold + case-mask ----------
// Fold table (DID char -> name char, mask bit):
//   a-z -> same, 0      A-Z -> lowercase, 1
//   "-" -> "-", 0       "_" -> "-", 1
//   "." -> ".", 0       "%" -> ".", 1
//   0-9 -> same, no bit ":" -> "_", no bit
// The mask holds one bit per letter, "-" and "." in the folded id, MSB first,
// packed into base32 groups of 5 bits. Trailing zero groups ("a") are removed.
// An all-zero mask is empty, and then the method tag has no ".mask" part.

export function encodeId(msid: string): { enc: string; mask: string } {
  let enc = '';
  const bits: number[] = [];
  for (const ch of msid) {
    if (ch >= 'a' && ch <= 'z') { enc += ch; bits.push(0); }
    else if (ch >= 'A' && ch <= 'Z') { enc += ch.toLowerCase(); bits.push(1); }
    else if (ch >= '0' && ch <= '9') { enc += ch; }
    else if (ch === '-') { enc += '-'; bits.push(0); }
    else if (ch === '_') { enc += '-'; bits.push(1); }
    else if (ch === '.') { enc += '.'; bits.push(0); }
    else if (ch === '%') { enc += '.'; bits.push(1); }
    else if (ch === ':') { enc += '_'; }
    else throw new GrammarError('E_DID_CHAR', `character ${JSON.stringify(ch)} is not allowed in a DID`);
  }
  return { enc, mask: packMask(bits) };
}

export function decodeId(enc: string, mask: string): string {
  let n = 0;
  for (const ch of enc) if ((ch >= 'a' && ch <= 'z') || ch === '-' || ch === '.') n++;
  const bits = unpackMask(mask, n);
  let out = '';
  let k = 0;
  for (const ch of enc) {
    if (ch >= 'a' && ch <= 'z') out += bits[k++] ? ch.toUpperCase() : ch;
    else if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === '-') out += bits[k++] ? '_' : '-';
    else if (ch === '.') out += bits[k++] ? '%' : '.';
    else if (ch === '_') out += ':';
    else throw new GrammarError('E_ENC_CHAR', `character ${JSON.stringify(ch)} is not allowed in enc-id`);
  }
  return out;
}

function packMask(bits: number[]): string {
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    let v = 0;
    for (let j = 0; j < 5; j++) v = (v << 1) | (bits[i + j] ?? 0);
    out += B32[v];
  }
  return out.replace(/a+$/, '');
}

function unpackMask(mask: string, n: number): number[] {
  const bits: number[] = [];
  for (const c of mask) {
    const v = B32.indexOf(c);
    if (v < 0) throw new GrammarError('E_MASK', `bad mask character ${JSON.stringify(c)}`);
    for (let j = 4; j >= 0; j--) bits.push((v >> j) & 1);
  }
  for (let i = n; i < bits.length; i++) {
    if (bits[i]) throw new GrammarError('E_MASK', 'mask sets a bit past the last letter, "-" or "."');
  }
  while (bits.length < n) bits.push(0);
  return bits.slice(0, n);
}

// ---------- hash form ----------
export function base32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let nbits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    nbits += 8;
    while (nbits >= 5) {
      out += B32[(acc >>> (nbits - 5)) & 31];
      nbits -= 5;
    }
    acc &= (1 << nbits) - 1;
  }
  if (nbits > 0) out += B32[(acc << (5 - nbits)) & 31];
  return out;
}

export function didHash(did: string): string {
  // node:crypto works on Node and on Bun. The bytes are the same as Bun.CryptoHasher('sha256').
  const h = createHash('sha256').update(did, 'utf8').digest();
  return base32(new Uint8Array(h)); // 52 characters
}

// ---------- format / parse ----------
export type Parsed =
  | { form: 'direct'; name: string; did: string; method: string; msid: string }
  | { form: 'hash'; name: string; hash: string };

export function splitDid(did: string): { method: string; msid: string } {
  const m = DID_RE.exec(did);
  if (!m) throw new GrammarError('E_DID', `not a DID Core DID: ${did}`);
  return { method: m[1], msid: m[2] };
}

export function formatDirect(did: string, name: string): string {
  if (!PKG_NAME_RE.test(name)) throw new GrammarError('E_NAME', `bad package name: ${name}`);
  const { method, msid } = splitDid(did);
  const { enc, mask } = encodeId(msid);
  return `${SCOPE}/${name}_${method}${mask ? '.' + mask : ''}_${enc}`;
}

// The canonical install name for (did, name). Exactly one name per pair.
export function format(did: string, name: string): string {
  const direct = formatDirect(did, name);
  if (direct.length <= MAX_NPM_NAME) return direct;
  return `${SCOPE}/${name}__${didHash(did)}`;
}

// Parse one install name. It never decodes percent escapes and never guesses.
export function parse(s: string): Parsed {
  if (typeof s !== 'string' || s.length > MAX_NPM_NAME) throw new GrammarError('E_LEN', 'name is longer than 214 characters');
  const prefix = `${SCOPE}/`;
  if (!s.startsWith(prefix)) throw new GrammarError('E_SCOPE', `name must start with ${prefix}`);
  const body = s.slice(prefix.length);
  const i = body.indexOf('_');
  if (i < 0) throw new GrammarError('E_SHAPE', 'no "_" separator');
  const name = body.slice(0, i);
  if (!PKG_NAME_RE.test(name)) throw new GrammarError('E_NAME', `bad package name: ${name}`);
  const rest = body.slice(i + 1);
  if (rest.startsWith('_')) {
    const hash = rest.slice(1);
    if (!HASH_RE.test(hash)) throw new GrammarError('E_HASH', 'hash form needs 52 base32 characters');
    return { form: 'hash', name, hash };
  }
  const j = rest.indexOf('_');
  if (j < 0) throw new GrammarError('E_SHAPE', 'no "_" after the method tag');
  const tag = rest.slice(0, j);
  const enc = rest.slice(j + 1);
  const dot = tag.indexOf('.');
  const method = dot < 0 ? tag : tag.slice(0, dot);
  const mask = dot < 0 ? '' : tag.slice(dot + 1);
  if (!METHOD_RE.test(method)) throw new GrammarError('E_METHOD', `bad method: ${method}`);
  if (dot >= 0 && !MASK_RE.test(mask)) throw new GrammarError('E_MASK', `bad or non-canonical mask: ${mask}`);
  if (!/^[a-z0-9._-]+$/.test(enc)) throw new GrammarError('E_ENC_CHAR', 'enc-id has a bad character');
  const msid = decodeId(enc, mask);
  const did = `did:${method}:${msid}`;
  if (!DID_RE.test(did)) throw new GrammarError('E_DID', `decoded value is not a DID: ${did}`);
  if (formatDirect(did, name) !== s) throw new GrammarError('E_CANONICAL', 'name is not in canonical form');
  return { form: 'direct', name, did, method, msid };
}

// The shim calls this after it gets a DID for a hash-form name (local alias store,
// lockfile tarball URL, or explorer lookup). The DID source is not trusted: the hash checks it.
export function bindHash(p: { name: string; hash: string }, did: string): string {
  const canonical = format(did, p.name);
  if (canonical !== `${SCOPE}/${p.name}__${p.hash}`) {
    throw new GrammarError('E_HASH_BIND', 'DID does not match the hash, or the direct form fits in 214 characters');
  }
  return did;
}
