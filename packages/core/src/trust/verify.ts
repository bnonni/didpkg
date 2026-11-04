// The reference verifier, trust policy v1. Trust comes only from DID resolution and signatures.
// The storage host (DWN, HTTPS mirror, disk) is not trusted.
// Tiers: L1 (a current assertionMethod key signed it, or the current index vouches for it) and
// L2 (a pinned key co-signs the first index of a new key). This verifier has no L3 tier (method
// history and the DidPkgCheckpoint service), so a key change needs a co-signature.
import type { DidResolver } from '../did/resolver.ts';
import type { DidDocument } from '../did/types.ts';
import { contentDigest, sri } from './digest.ts';
import { PolicyError, TrustError, type PolicyCode } from './errors.ts';
import { keyForRelationship, publicKeyOf, toMultikey } from './keys.ts';
import { verifyProof, type DataIntegrityProof } from './proof.ts';
import {
  parseIndex, parseRelease, proofsOf, type DidPkgIndex, type DidPkgRelease, type IndexFields, type ReleaseFields,
} from './release.ts';

/**
 * The reads that the verifier needs. Each value is untrusted. `null` means absent.
 * `PackageSource` (source/) implements it over every storage endpoint of the publisher.
 */
export interface ReleaseReader {
  /** Every index copy from every endpoint. Empty if no endpoint has one. A XID publisher is the XID in hex. */
  getIndexes(publisher: string, name: string): Promise<unknown[]>;
  /** A release copy whose content digest is `digest`. */
  getRelease(publisher: string, name: string, version: string, digest: string): Promise<unknown>;
  /** A tarball copy with the size and the sha512 of `dist`. */
  getTarball(publisher: string, name: string, version: string, dist: { integrity: string; size: number }): Promise<Uint8Array | null>;
}

/** The TOFU pin of one publisher and package, like a line in the SSH known_hosts file. */
export interface Pin {
  /** The key id (a Multikey for a DID publisher) of each key that signed an accepted index. */
  keys: string[];
  /** The key that signed the pinned index. */
  epochKey: string;
  sequence: number;
  indexDigest: string;
  /** The version to the manifest digest, at first use. */
  releases: Record<string, string>;
}

/** The pins, with the key `<publisher>/<name>`. didpkg 0.1.0 keeps them in memory only. */
export type TrustStore = Map<string, Pin>;
export type PolicyMode = 'enforce' | 'warn';

export interface VerifyIndexOptions {
  did: string;
  name: string;
  resolver: Pick<DidResolver, 'resolve'>;
  reader: ReleaseReader;
  trust: TrustStore;
  /** The mode of the TOFU events KEY_CHANGED and HISTORY_CHANGED. Default: enforce. */
  mode?: PolicyMode;
}

export interface VerifyReleaseOptions extends VerifyIndexOptions {
  version: string;
  /** true if a lockfile pins this exact version. Then a yanked version installs. */
  exactPin?: boolean;
}

export interface PolicyWarning {
  code: PolicyCode;
  message: string;
}

/** How the index key relates to the pin. */
export type Continuity = 'first-use' | 'pinned' | 'co-signed' | 'accepted-in-warn-mode';

/** The result of the shared policy, for any identifier kind. */
export interface PolicyIndex<I extends IndexFields> {
  index: I;
  indexDigest: string;
  /** The key id of the current key that signed the index. */
  epochKey: string;
  continuity: Continuity;
  warnings: PolicyWarning[];
}

/** current-key: a current release key signed the manifest. index: only the current index vouches for it. */
export type ManifestKey = 'current-key' | 'index';

export interface PolicyRelease<I extends IndexFields, R extends ReleaseFields> extends PolicyIndex<I> {
  release: R;
  tarball: Uint8Array;
  manifestKey: ManifestKey;
}

export interface VerifiedIndex extends PolicyIndex<DidPkgIndex> {
  didDocument: DidDocument;
}

export interface VerifiedRelease extends VerifiedIndex, PolicyRelease<DidPkgIndex, DidPkgRelease> {}

/**
 * The parts of the verifier that depend on the identifier kind of the publisher: the key document,
 * the signatures and the digests. The trust policy (index chain, pins, status, tarball) is the same for each kind.
 */
export interface PublisherKind<D, I extends IndexFields, R extends ReleaseFields> {
  /** Step 1: the current key document of the publisher. */
  resolve(publisher: string): Promise<D>;
  /** The schema of one index copy. INDEX_SCHEMA if it is not valid. */
  parseIndex(raw: unknown): I;
  /** The key id of a current release key that signed the index. INDEX_SIGNATURE if there is none. */
  indexKey(index: I, doc: D): Promise<string>;
  /** L2: true if one of the pinned keys signed the index. */
  coSigned(index: I, pinnedKeys: string[]): Promise<boolean>;
  /** The schema of a release record. MANIFEST_SCHEMA if it is not valid. */
  parseRelease(raw: unknown): R;
  /** The content digest of an index or a release record. */
  digest(object: I | R): string;
  /** MANIFEST_SIGNATURE if a key that must not sign releases signed the record. */
  manifestKey(release: R, doc: D): Promise<ManifestKey>;
}

/** The options of the shared policy. `publisher` is the DID, or the XID in hex. */
export interface PolicyOptions {
  publisher: string;
  name: string;
  reader: ReleaseReader;
  trust: TrustStore;
  mode?: PolicyMode;
  version?: string;
  exactPin?: boolean;
}

const pinId = (publisher: string, name: string) => `${publisher}/${name}`;

// The did:dht identity key #0 is the DID update key. The did:dht spec puts #0 in
// assertionMethod (spec.md section "Identity Key Pair"), but only a release key signs releases. A proof by #0
// shows a hot update key, and a thief with #0 can sign with no DID document change. Thus a #0 proof fails.
const updateKeyOf = (did: string) => (did.startsWith('did:dht:') ? `${did}#0` : undefined);

/** The proof `proof` of the object, if it verifies against the document. A non-TrustError is a defect, so it escapes. */
async function verifies(object: { proof: unknown }, proof: DataIntegrityProof, doc: DidDocument): Promise<string | undefined> {
  try {
    return (await verifyProof({ ...object, proof }, doc)).verificationMethod;
  } catch (e) {
    if (e instanceof TrustError) return undefined;
    throw e;
  }
}

/** A DID publisher: the DID document, Data Integrity proofs and JCS digests. */
function didKind(resolver: Pick<DidResolver, 'resolve'>): PublisherKind<DidDocument, DidPkgIndex, DidPkgRelease> {
  return {
    async resolve(did) {
      const resolved = await resolver.resolve(did);
      const doc = resolved.didDocument;
      if (resolved.didDocumentMetadata.deactivated) throw new PolicyError('DID_DEACTIVATED', `${did} is deactivated`);
      if (!doc || resolved.didResolutionMetadata.error) {
        throw new PolicyError('DID_RESOLUTION', `${did}: ${resolved.didResolutionMetadata.error?.type ?? 'no DID document'}`);
      }
      if (doc.id !== did) throw new PolicyError('DID_RESOLUTION', `the resolver returned ${doc.id}, not ${did}`);
      return doc;
    },
    parseIndex,
    async indexKey(index, doc) {
      const proofs = proofsOf(index);
      const updateKey = updateKeyOf(index.publisher);
      if (updateKey && proofs.some((p) => p.verificationMethod === updateKey)) {
        throw new PolicyError('INDEX_SIGNATURE', `the did:dht update key ${updateKey} signed the index`);
      }
      for (const proof of proofs) {
        const method = await verifies(index, proof, doc);
        if (method) return toMultikey(publicKeyOf(keyForRelationship(doc, method)));
      }
      throw new PolicyError('INDEX_SIGNATURE', 'no index proof by a current assertionMethod key');
    },
    coSigned,
    parseRelease,
    digest: contentDigest,
    manifestKey: manifestKeyOf,
  };
}

/** Steps 1-3: resolve the DID, verify the index proof, then check key continuity and rollback against the pin. */
export async function verifyIndex(o: VerifyIndexOptions): Promise<VerifiedIndex> {
  const { document, ...verified } = await policyIndex(didKind(o.resolver), { ...o, publisher: o.did });
  return { didDocument: document, ...verified };
}

/** Steps 1-7: verify the index, the release status, the manifest and the tarball, then update the pin. */
export async function verifyRelease(o: VerifyReleaseOptions): Promise<VerifiedRelease> {
  const { document, ...verified } = await policyRelease(didKind(o.resolver), { ...o, publisher: o.did });
  return { didDocument: document, ...verified };
}

/**
 * Step 5 for one version of a verified index: the manifest with the digest in the index, the
 * publisher, name and version of the index, and a proof by a method of the publisher. The tarball
 * route (verifyRelease) and the packument (source/) both use it, so they accept the same manifests.
 */
export async function checkRelease(
  reader: Pick<ReleaseReader, 'getRelease'>,
  verified: Pick<VerifiedIndex, 'didDocument' | 'index'>,
  version: string,
): Promise<{ release: DidPkgRelease; manifestKey: ManifestKey }> {
  const kind = didKind({ resolve: () => Promise.reject(new Error('checkRelease does not resolve')) });
  return releaseOf(kind, reader, verified.didDocument, verified.index, version);
}

/** Steps 1-3 for any identifier kind. */
export async function policyIndex<D, I extends IndexFields, R extends ReleaseFields>(
  kind: PublisherKind<D, I, R>,
  o: PolicyOptions,
): Promise<PolicyIndex<I> & { document: D }> {
  const warnings: PolicyWarning[] = [];
  const tofu = (code: PolicyCode, message: string) => {
    if ((o.mode ?? 'enforce') === 'enforce') throw new PolicyError(code, message);
    warnings.push({ code, message });
  };

  // 1. Resolve the publisher through its own method. The storage host is not involved.
  const doc = await kind.resolve(o.publisher);

  // 2. Every index copy. The highest sequence with a signature by a current release key wins.
  // If no copy is valid, the error of the first copy (the DWN first) is the result.
  const copies = await o.reader.getIndexes(o.publisher, o.name);
  if (copies.length === 0) throw new PolicyError('INDEX_MISSING', `no index for ${pinId(o.publisher, o.name)}`);
  let best: { index: I; epochKey: string } | undefined;
  let firstError: unknown;
  for (const raw of copies) {
    try {
      const copy = await checkIndex(kind, raw, o.publisher, o.name, doc);
      if (!best || copy.index.sequence > best.index.sequence) best = copy;
    } catch (e) {
      firstError ??= e;
    }
  }
  if (!best) throw firstError;
  const { index, epochKey } = best;
  const indexDigest = kind.digest(index);

  // 3. Key continuity and rollback, against the pin of this publisher and package.
  const pin = o.trust.get(pinId(o.publisher, o.name));
  let continuity: Continuity = pin ? 'pinned' : 'first-use';
  if (pin && !pin.keys.includes(epochKey)) {
    if (await kind.coSigned(index, pin.keys)) {
      continuity = 'co-signed';
    } else {
      tofu('KEY_CHANGED', `the index key ${epochKey} is new, and no pinned key co-signs the index`);
      continuity = 'accepted-in-warn-mode';
    }
  }
  if (pin && pin.epochKey === epochKey) {
    if (index.sequence < pin.sequence) throw new PolicyError('ROLLBACK', `index sequence ${index.sequence} is lower than the pinned ${pin.sequence}`);
    if (index.sequence === pin.sequence && indexDigest !== pin.indexDigest) {
      throw new PolicyError('EQUIVOCATION', `index sequence ${index.sequence} has two different indexes`);
    }
  }
  for (const [version, digest] of Object.entries(pin?.releases ?? {})) {
    if (index.releases[version]?.digest !== digest) tofu('HISTORY_CHANGED', `release ${version} changed or left the index`);
  }
  return { document: doc, index, indexDigest, epochKey, continuity, warnings };
}

/** Steps 1-7 for any identifier kind. `o.version` is required. */
export async function policyRelease<D, I extends IndexFields, R extends ReleaseFields>(
  kind: PublisherKind<D, I, R>,
  o: PolicyOptions & { version: string },
): Promise<PolicyRelease<I, R> & { document: D }> {
  const verified = await policyIndex(kind, o);
  const { index, indexDigest, epochKey, warnings } = verified;

  // 4. The release status from the signed index.
  const entry = Object.hasOwn(index.releases, o.version) ? index.releases[o.version] : undefined;
  const note = entry?.message ? `: ${entry.message}` : '';
  if (!entry) throw new PolicyError('NOT_LISTED', `${o.version} is not in the signed index`);
  if (entry.status === 'revoked') throw new PolicyError('REVOKED', `${o.version} is revoked${note}`);
  if (entry.status === 'yanked' && !o.exactPin) throw new PolicyError('YANKED', `${o.version} is yanked${note}. Only an exact lockfile pin installs it.`);
  if (entry.status === 'yanked') warnings.push({ code: 'YANKED', message: `${o.version} is yanked${note}` });
  if (entry.status === 'deprecated') warnings.push({ code: 'DEPRECATED', message: `${o.version} is deprecated${note}` });

  // 5. The manifest: the digest in the index, the fields, and the signature.
  const { release, manifestKey } = await releaseOf(kind, o.reader, verified.document, index, o.version);

  // 6. The tarball: hash all bytes before one byte goes to npm.
  const tarball = await o.reader.getTarball(o.publisher, o.name, o.version, release.dist);
  if (!tarball) throw new PolicyError('TARBALL_MISSING', `no tarball for ${o.version}`);
  if (tarball.length !== release.dist.size || (await sri('sha512', tarball)) !== release.dist.integrity) {
    throw new PolicyError('INTEGRITY', 'the tarball bytes are not the bytes in the signed manifest');
  }

  // 7. Update the pin only after all checks pass. Step 3 rejects a lower sequence of the same key,
  // so this index is the newest index that the pin knows.
  const pin = o.trust.get(pinId(o.publisher, o.name));
  o.trust.set(pinId(o.publisher, o.name), {
    keys: [...new Set([...(pin?.keys ?? []), epochKey])],
    epochKey,
    sequence: index.sequence,
    indexDigest,
    releases: { ...pin?.releases, [o.version]: entry.digest },
  });
  return { ...verified, release, tarball, manifestKey };
}

/** Step 5 for any identifier kind. */
export async function releaseOf<D, I extends IndexFields, R extends ReleaseFields>(
  kind: PublisherKind<D, I, R>,
  reader: Pick<ReleaseReader, 'getRelease'>,
  doc: D,
  index: I,
  version: string,
): Promise<{ release: R; manifestKey: ManifestKey }> {
  if (!Object.hasOwn(index.releases, version)) throw new PolicyError('NOT_LISTED', `${version} is not in the signed index`);
  const { digest } = index.releases[version]!;
  const raw = await reader.getRelease(index.publisher, index.name, version, digest);
  if (raw === null || raw === undefined) throw new PolicyError('MANIFEST_MISSING', `no manifest for ${version}`);
  const release = kind.parseRelease(raw);
  if (kind.digest(release) !== digest) throw new PolicyError('MANIFEST_DIGEST', 'the manifest is not the manifest in the signed index');
  if (release.publisher !== index.publisher || release.name !== index.name || release.version !== version) {
    throw new PolicyError('MANIFEST_FIELDS', 'the manifest publisher, name or version is not the requested value');
  }
  return { release, manifestKey: await kind.manifestKey(release, doc) };
}

// Step 2 for one index copy: the schema, the fields, and a signature by a current release key.
async function checkIndex<D, I extends IndexFields, R extends ReleaseFields>(
  kind: PublisherKind<D, I, R>, raw: unknown, publisher: string, name: string, doc: D,
) {
  const index = kind.parseIndex(raw);
  if (index.publisher !== publisher || index.name !== name) {
    throw new PolicyError('INDEX_FIELDS', `the index is for ${pinId(index.publisher, index.name)}`);
  }
  return { index, epochKey: await kind.indexKey(index, doc) };
}

// L2: a proof by a pinned key. The DID document does not hold that key now, so a one-key document checks it.
async function coSigned(index: DidPkgIndex, pinnedKeys: string[]): Promise<boolean> {
  const did = index.publisher;
  for (const proof of proofsOf(index)) {
    for (const key of pinnedKeys) {
      const vm = { id: proof.verificationMethod, type: 'Multikey', controller: did, publicKeyMultibase: key };
      if (await verifies(index, proof, { id: did, verificationMethod: [vm], assertionMethod: [vm.id] })) return true;
    }
  }
  return false;
}

// L1: a current assertionMethod key signed the manifest. If that key rotated out, the current signed
// index vouches for the manifest digest. A proof by a method of another DID is a hard failure.
async function manifestKeyOf(release: DidPkgRelease, doc: DidDocument): Promise<ManifestKey> {
  const proofs = proofsOf(release);
  for (const proof of proofs) {
    const method = proof.verificationMethod;
    if (typeof method !== 'string' || !method.startsWith(`${doc.id}#`)) {
      throw new PolicyError('MANIFEST_SIGNATURE', `the manifest proof method ${String(method)} is not a method of ${doc.id}`);
    }
    if (method === updateKeyOf(doc.id)) throw new PolicyError('MANIFEST_SIGNATURE', `the did:dht update key ${method} signed the manifest`);
  }
  for (const proof of proofs) if (await verifies(release, proof, doc)) return 'current-key';
  return 'index';
}
