// Release records and indexes of a XID publisher, as Gordian Envelopes (docs/spec/release-records.md
// section 6). The members are the members of the JSON objects. The trust policy is the policy of
// trust/verify.ts. Only the key document, the signatures and the digests are different.
import { hexToBytes, PublicKeys, XID, type Signer as GordianSigner } from '@blockchaincommons/components';
import { cbor, decodeCbor, extractCbor, MajorType, type Cbor } from '@blockchaincommons/dcbor';
import { Envelope } from '@blockchaincommons/envelope';
import { addSignatures, hasSignatureFrom } from '@blockchaincommons/envelope/signature';
import { XID_RE } from '../name/grammar.ts';
import { indexFields, releaseFields, type IndexInput, type ReleaseInput } from '../trust/build.ts';
import { PolicyError, type PolicyCode } from '../trust/errors.ts';
import { checkIndexFields, checkReleaseFields, type IndexFields, type ReleaseFields } from '../trust/release.ts';
import {
  policyIndex, policyRelease, releaseOf, type ManifestKey, type PolicyIndex, type PolicyOptions, type PolicyRelease, type PublisherKind,
} from '../trust/verify.ts';
import { keysWith, XidError, type XidDocumentInfo, type XidKeyInfo } from './document.ts';

export type { GordianSigner };

/** A release record of a XID publisher. `publisher` is the XID in hex. */
export interface XidPkgRelease extends ReleaseFields {
  /** The signed envelope: the wrapped record and one or more signatures. */
  envelope: Envelope;
}

/** An index of a XID publisher. `publisher` is the XID in hex. */
export interface XidPkgIndex extends IndexFields {
  /** The signed envelope: the wrapped index and one or more signatures. */
  envelope: Envelope;
}

/** Gives the current verified XID document of a XID, for example with resolveXid. */
export interface XidDocumentResolver {
  resolve(xid: string): Promise<XidDocumentInfo>;
}

export interface VerifyXidIndexOptions extends Omit<PolicyOptions, 'publisher' | 'version' | 'exactPin'> {
  /** The XID in hex. */
  xid: string;
  resolver: XidDocumentResolver;
}

export interface VerifyXidReleaseOptions extends VerifyXidIndexOptions {
  version: string;
  /** true if a lockfile pins this exact version. Then a yanked version installs. */
  exactPin?: boolean;
}

export interface VerifiedXidIndex extends PolicyIndex<XidPkgIndex> {
  xidDocument: XidDocumentInfo;
}

export interface VerifiedXidRelease extends VerifiedXidIndex, PolicyRelease<XidPkgIndex, XidPkgRelease> {}

const isXid = (v: unknown) => typeof v === 'string' && XID_RE.test(v);

// --- The envelope form ---

/** A JSON value as a dCBOR leaf. JSON has no undefined, so a member with the value undefined is not in the map. */
const toLeaf = (value: unknown): Envelope => Envelope.leaf(cbor(JSON.parse(JSON.stringify(value))));

/** A dCBOR value as JSON. Byte strings and tagged values have no JSON form. */
function toJson(c: Cbor): unknown {
  switch (c.type) {
    case MajorType.Array:
      return c.value.map(toJson);
    case MajorType.Map: {
      const object: Record<string, unknown> = {};
      for (const [k, v] of c.value.entries()) {
        if (k.type !== MajorType.Text) throw new TypeError('a map key is not text');
        object[k.value] = toJson(v);
      }
      return object;
    }
    case MajorType.Unsigned:
    case MajorType.Negative:
    case MajorType.Text:
    case MajorType.Simple: {
      const value = extractCbor(c);
      if (typeof value === 'bigint') throw new TypeError('an integer is too large for JSON');
      return value;
    }
    default:
      throw new TypeError('a value has no JSON form');
  }
}

/**
 * The unsigned envelope of a record or an index. The subject is the `type` text. Each other member is an
 * assertion with the member name as a text predicate. `publisher` is a XID. `releases` of an index is
 * an array in publish order, and each item has the `version` member. Each other value is the JSON value as dCBOR.
 */
function toEnvelope(fields: ReleaseFields | IndexFields): Envelope {
  let envelope = Envelope.from(fields.type);
  for (const [member, value] of Object.entries(fields)) {
    if (member === 'type' || member === 'envelope' || value === undefined) continue;
    let object: Envelope | XID;
    if (member === 'publisher') object = XID.fromHex(value as string);
    else if (member === 'releases' && fields.type === 'DidPkgIndex') {
      object = toLeaf(Object.entries(fields.releases).map(([version, entry]) => ({ version, ...entry })));
    } else object = toLeaf(value);
    envelope = envelope.addAssertion(member, object);
  }
  return envelope;
}

/**
 * The members of a signed envelope, as JSON. A host can elide an assertion and the digest stays the same.
 * An elided or other obscured assertion, and an assertion with a predicate that is not text, is not a member.
 * The schema check then refuses an object with a missing member.
 */
function fromEnvelope(raw: unknown, code: PolicyCode, type: string): { members: Record<string, unknown>; envelope: Envelope } {
  const fail = (why: string): never => {
    throw new PolicyError(code, `${type}: ${why}`);
  };
  if (!(raw instanceof Uint8Array)) fail('not envelope bytes');
  let envelope: Envelope;
  let inner: Envelope;
  try {
    envelope = Envelope.fromBytes(raw as Uint8Array);
    inner = envelope.subject().isWrapped() ? envelope.unwrap() : fail('the envelope is not wrapped');
  } catch (e) {
    if (e instanceof PolicyError) throw e;
    return fail(`not a valid envelope: ${e instanceof Error ? e.message : String(e)}`);
  }
  const members: Record<string, unknown> = { type: inner.subject().asText() };
  const seen = new Set<string>();
  for (const assertion of inner.assertions()) {
    if (assertion.isObscured()) continue;
    const member = assertion.predicate().asText();
    const leaf = assertion.object().asLeaf();
    if (member === undefined || member === 'type') continue;
    if (seen.has(member)) fail(`two assertions have the predicate ${member}`);
    seen.add(member);
    if (leaf === undefined) continue;
    try {
      members[member] = member === 'publisher' ? XID.fromCbor(leaf).toHex() : toJson(leaf);
    } catch {
      fail(`${member} is not valid`);
    }
  }
  if (type === 'DidPkgIndex' && Array.isArray(members.releases)) members.releases = releaseMap(members.releases, fail);
  return { members, envelope: envelope! };
}

function releaseMap(items: unknown[], fail: (why: string) => never): Record<string, unknown> {
  const releases: Record<string, unknown> = {};
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail('a releases item is not a map');
    const { version, ...entry } = item as Record<string, unknown>;
    if (typeof version !== 'string' || Object.hasOwn(releases, version)) fail('a releases item has no version or a second copy');
    releases[version as string] = entry;
  }
  return releases;
}

/** The tagged CBOR bytes (tag 200) of the signed envelope. A host stores and serves these bytes. */
export const envelopeBytes = (object: { envelope: Envelope }): Uint8Array => object.envelope.toCbor().toData();

/** The content digest: `sha256-` and the base64 of the envelope digest of the unsigned object. Elision keeps it. */
export const xidContentDigest = (object: { envelope: Envelope }): string => `sha256-${object.envelope.unwrap().digest().toBase64()}`;

/** Signed envelope bytes as a XidPkgRelease. The signature is not checked. */
export function parseXidRelease(raw: unknown): XidPkgRelease {
  const { members, envelope } = fromEnvelope(raw, 'MANIFEST_SCHEMA', 'DidPkgRelease');
  return { ...checkReleaseFields(members, isXid), envelope };
}

/** Signed envelope bytes as a XidPkgIndex. The signature is not checked. */
export function parseXidIndex(raw: unknown): XidPkgIndex {
  const { members, envelope } = fromEnvelope(raw, 'INDEX_SCHEMA', 'DidPkgIndex');
  return { ...checkIndexFields(members, isXid), envelope };
}

// --- The publisher side ---

/** Wrap the envelope of the members, then sign it with each signer. Each signature covers the same digest. */
export function signXidObject<T extends ReleaseFields | IndexFields>(fields: T, signers: GordianSigner[]): T & { envelope: Envelope } {
  if (signers.length === 0) throw new TypeError('no signer');
  const envelope = addSignatures(toEnvelope(fields).wrap(), signers);
  return { ...fields, envelope };
}

/** A new signed release record. Sign with a key that has the Sign privilege, never with the inception key. */
export async function signXidRelease(o: ReleaseInput, signers: GordianSigner[]): Promise<XidPkgRelease> {
  return signXidObject(await releaseFields(o), signers);
}

/** The next signed index head. On a key rotation, sign with the new key and the old key. */
export function signXidIndex(o: IndexInput & { head: XidPkgIndex | null }, signers: GordianSigner[]): XidPkgIndex {
  return signXidObject(indexFields(o, o.head ? xidContentDigest(o.head) : null), signers);
}

// --- The verifier ---

/** The key id in a pin: the tagged CBOR of the public keys, in hex. */
const keyId = (k: XidKeyInfo): string => k.key.publicKeys.toCbor().toHex();
const inceptionOf = (doc: XidDocumentInfo) => doc.keys.find((k) => k.inception);
// The inception key has the All privilege, but it is the key that controls the XID document. A
// signature by it shows a hot inception key, as the did:dht update key #0 does. Thus it fails.
const releaseKeys = (doc: XidDocumentInfo) => keysWith(doc, 'Sign').filter((k) => !k.inception);
const signedBy = (object: { envelope: Envelope }, k: XidKeyInfo | undefined) => k !== undefined && hasSignatureFrom(object.envelope, k.key.publicKeys);

function xidKind(resolver: XidDocumentResolver): PublisherKind<XidDocumentInfo, XidPkgIndex, XidPkgRelease> {
  return {
    async resolve(xid) {
      const doc = await resolver.resolve(xid);
      if (doc.xid !== xid) throw new XidError('XID_MISMATCH', `the resolver returned XID ${doc.xid}, not ${xid}`);
      return doc;
    },
    parseIndex: parseXidIndex,
    async indexKey(index, doc) {
      if (signedBy(index, inceptionOf(doc))) throw new PolicyError('INDEX_SIGNATURE', 'the XID inception key signed the index');
      const key = releaseKeys(doc).find((k) => signedBy(index, k));
      if (!key) throw new PolicyError('INDEX_SIGNATURE', 'no index signature by a current XID key with the Sign privilege');
      return keyId(key);
    },
    async coSigned(index, pinnedKeys) {
      return pinnedKeys.some((id) => {
        try {
          return hasSignatureFrom(index.envelope, PublicKeys.fromCbor(decodeCbor(hexToBytes(id))));
        } catch {
          return false;
        }
      });
    },
    parseRelease: parseXidRelease,
    digest: xidContentDigest,
    async manifestKey(release, doc): Promise<ManifestKey> {
      if (signedBy(release, inceptionOf(doc))) throw new PolicyError('MANIFEST_SIGNATURE', 'the XID inception key signed the manifest');
      return releaseKeys(doc).some((k) => signedBy(release, k)) ? 'current-key' : 'index';
    },
  };
}

/** Steps 1-3 for a XID publisher: resolve the XID document, verify the index, then check the pin. */
export async function verifyXidIndex(o: VerifyXidIndexOptions): Promise<VerifiedXidIndex> {
  const { document, ...verified } = await policyIndex(xidKind(o.resolver), { ...o, publisher: o.xid });
  return { xidDocument: document, ...verified };
}

/** Steps 1-7 for a XID publisher: the index, the status, the release record and the tarball, then the pin. */
export async function verifyXidRelease(o: VerifyXidReleaseOptions): Promise<VerifiedXidRelease> {
  const { document, ...verified } = await policyRelease(xidKind(o.resolver), { ...o, publisher: o.xid });
  return { xidDocument: document, ...verified };
}

/** Step 5 for one version of a verified XID index. The packument uses it, as checkRelease for a DID. */
export async function checkXidRelease(
  reader: Parameters<typeof releaseOf>[1],
  verified: Pick<VerifiedXidIndex, 'xidDocument' | 'index'>,
  version: string,
): Promise<{ release: XidPkgRelease; manifestKey: ManifestKey }> {
  const kind = xidKind({ resolve: () => Promise.reject(new Error('checkXidRelease does not resolve')) });
  return releaseOf(kind, reader, verified.xidDocument, verified.index, version);
}
