// XID documents (BCR-2024-010). This is the only file that imports a Gordian library.
// A XID document is a Gordian Envelope (draft-mcnally-envelope-12) that the inception key signs.
// didpkg rules where the XID spec has no rule: docs/spec/release-records.md section 6.
import { Envelope } from '@blockchaincommons/envelope';
import type { ProvenanceMark } from '@blockchaincommons/provenance-mark';
import { UR } from '@blockchaincommons/uniform-resources';
import { XIDDocument, type Key, type Privilege, type Service } from '@blockchaincommons/xid';
import { XID_RE } from '../name/grammar.ts';

export type { Privilege as XidPrivilege } from '@blockchaincommons/xid';

export type XidErrorCode =
  | 'XID_INVALID'
  | 'XID_MISMATCH'
  | 'XID_NO_PROVENANCE'
  | 'XID_CHAIN'
  | 'XID_ROLLBACK'
  | 'XID_FORK'
  | 'XID_NOT_FOUND'
  | 'XID_UNAVAILABLE';

/** The message starts with the code, as in a GrammarError. */
export class XidError extends Error {
  constructor(readonly code: XidErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'XidError';
  }
}

export interface XidKeyInfo {
  /** The key reference in hex. A service and a `vm` query name a key by its reference. */
  reference: string;
  allow: readonly Privilege[];
  deny: readonly Privilege[];
  /** True for the key that makes the XID (the inception key). */
  inception: boolean;
  nickname: string;
  endpoints: readonly string[];
  /** The library key. The release verifier checks signatures with it. */
  key: Key;
}

export interface XidServiceInfo {
  uri: string;
  capability: string;
  name: string;
  /** The references (hex) of the keys that the service uses. */
  keyReferences: readonly string[];
  allow: readonly Privilege[];
  deny: readonly Privilege[];
}

export interface XidProvenanceInfo {
  /** The chain id of the provenance mark chain, in hex. */
  chainId: string;
  seq: number;
  /** The date of the mark, as an ISO 8601 string. */
  date: string;
  mark: ProvenanceMark;
}

export interface XidDocumentInfo {
  /** The XID as 64 lowercase hex characters. */
  xid: string;
  keys: readonly XidKeyInfo[];
  services: readonly XidServiceInfo[];
  /** The `dereferenceVia` URIs of the document. */
  dereferenceVia: readonly string[];
  provenance: XidProvenanceInfo;
  document: XIDDocument;
  /** The signed envelope, as tagged CBOR. */
  bytes: Uint8Array;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sorted = (s: ReadonlySet<Privilege>): Privilege[] => [...s].sort();

/**
 * Parse a signed XID document and verify it. The inception key must sign the wrapped document,
 * and the XID must be the XID of that key. If `expected` is given, the XID must be equal to it.
 * didpkg needs a provenance mark: without one, no rule can order two copies of a document.
 */
export function readXidDocument(bytes: Uint8Array, expected?: string): XidDocumentInfo {
  let doc: XIDDocument;
  try {
    doc = XIDDocument.fromEnvelope(Envelope.fromBytes(bytes), { verify: 'inception' });
  } catch (e) {
    throw new XidError('XID_INVALID', `not a signed XID document: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const xid = doc.xid.toHex();
  if (expected !== undefined && xid !== expected) throw new XidError('XID_MISMATCH', `the document is for XID ${xid}, not ${expected}`);
  const mark = doc.provenance;
  if (mark === undefined) throw new XidError('XID_NO_PROVENANCE', `the document for XID ${xid} has no provenance mark`);
  return {
    xid,
    keys: doc.keys.map((k) => keyInfo(doc, k)),
    services: doc.services.map(serviceInfo),
    dereferenceVia: [...doc.resolutionMethods].map(String),
    provenance: { chainId: hex(mark.chainId), seq: mark.seq, date: mark.date.toISOString(), mark },
    document: doc,
    bytes,
  };
}

function keyInfo(doc: XIDDocument, k: Key): XidKeyInfo {
  return {
    reference: k.reference.toHex(),
    allow: sorted(k.allow),
    deny: sorted(k.deny),
    inception: doc.isInceptionSigningKey(k.publicKeys.signingPublicKey),
    nickname: k.nickname,
    endpoints: [...k.endpoints].map(String),
    key: k,
  };
}

function serviceInfo(s: Service): XidServiceInfo {
  return {
    uri: String(s.uri),
    capability: s.capability,
    name: s.name,
    keyReferences: [...s.keyReferences].map((r) => r.toHex()),
    allow: sorted(s.allow),
    deny: sorted(s.deny),
  };
}

/**
 * True if the permissions grant the privilege. BCR-2024-010 is deny-first, and a deny overrides
 * any conflicting allow. didpkg reads this strictly: a deny of the privilege or of "All" removes it.
 */
export function grants(p: { allow: readonly Privilege[]; deny: readonly Privilege[] }, privilege: Privilege): boolean {
  if (p.deny.includes(privilege) || p.deny.includes('All')) return false;
  return p.allow.includes(privilege) || p.allow.includes('All');
}

/** The keys of the document that have the privilege. */
export function keysWith(info: XidDocumentInfo, privilege: Privilege): XidKeyInfo[] {
  return info.keys.filter((k) => grants(k, privilege));
}

/**
 * Check that `next` can replace `known` (the document with the highest seq that the client saw).
 * The chain id must be the same, and the seq must not go down. The same seq needs the same mark.
 * The next seq must follow the hash chain. A gap in seq checks only the chain id and the order,
 * because the marks between are not known.
 */
export function checkProvenance(known: XidProvenanceInfo, next: XidProvenanceInfo): void {
  if (next.chainId !== known.chainId) throw new XidError('XID_CHAIN', `the provenance chain id is ${next.chainId}, not ${known.chainId}`);
  if (next.seq < known.seq) throw new XidError('XID_ROLLBACK', `the document has seq ${next.seq}, but seq ${known.seq} is known`);
  if (next.seq === known.seq && !next.mark.equals(known.mark)) throw new XidError('XID_FORK', `two different provenance marks have seq ${next.seq}`);
  if (next.seq === known.seq + 1 && !known.mark.precedes(next.mark)) throw new XidError('XID_FORK', `the mark with seq ${next.seq} does not follow seq ${known.seq}`);
}

/**
 * The XID (64 lowercase hex characters) in a `ur:xid` string. BCR-2024-010: the UR holds a bare
 * XID (a CBOR byte string) or a XID document (a tag 200 envelope). This function does not verify a document.
 */
export function xidFromUr(s: string): string {
  let xid: string;
  try {
    const ur = UR.parse(s);
    ur.expectType('xid');
    xid = XIDDocument.fromUR(ur).xid.toHex();
  } catch (e) {
    throw new XidError('XID_INVALID', `not a ur:xid: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (!XID_RE.test(xid)) throw new XidError('XID_INVALID', `not a ur:xid: ${s}`);
  return xid;
}
