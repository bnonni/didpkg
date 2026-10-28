// The reference verifier, trust policy v1. Trust comes only from DID resolution and signatures.
// The storage host (DWN, HTTPS mirror, disk) is not trusted.
// Tiers: L1 (a current assertionMethod key signed it, or the current index vouches for it) and
// L2 (a pinned key co-signs the first index of a new key). L3 (method history and the
// DidPkgCheckpoint service) is Phase 3, so a key change here needs a co-signature.
import type { DidResolver } from '../did/resolver.ts';
import type { DidDocument } from '../did/types.ts';
import { contentDigest, sri } from './digest.ts';
import { PolicyError, TrustError, type PolicyCode } from './errors.ts';
import { keyForRelationship, publicKeyOf, toMultikey } from './keys.ts';
import { verifyProof, type DataIntegrityProof } from './proof.ts';
import { parseIndex, parseRelease, proofsOf, type DidPkgIndex, type DidPkgRelease } from './release.ts';

/**
 * The reads that the verifier needs. Each value is untrusted. `null` means absent.
 * `PackageSource` (source/) implements it over every storage endpoint of the publisher.
 */
export interface ReleaseReader {
  /** Every index copy from every endpoint. Empty if no endpoint has one. */
  getIndexes(did: string, name: string): Promise<unknown[]>;
  /** A release copy whose contentDigest is `digest`. */
  getRelease(did: string, name: string, version: string, digest: string): Promise<unknown>;
  /** A tarball copy with the size and the sha512 of `dist`. */
  getTarball(did: string, name: string, version: string, dist: { integrity: string; size: number }): Promise<Uint8Array | null>;
}

/** The TOFU pin of one DID and package, like a line in the SSH known_hosts file. */
export interface Pin {
  /** The Multikey of each key that signed an accepted index. */
  keys: string[];
  /** The key that signed the pinned index. */
  epochKey: string;
  sequence: number;
  indexDigest: string;
  /** The version to the manifest digest, at first use. */
  releases: Record<string, string>;
}

/** The pins, with the key `<did>/<name>`. Phase 2 stores them in `~/.config/didpkg/trust.json`. */
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

export interface VerifiedIndex {
  didDocument: DidDocument;
  index: DidPkgIndex;
  indexDigest: string;
  /** The Multikey of the current key that signed the index. */
  epochKey: string;
  continuity: Continuity;
  warnings: PolicyWarning[];
}

export interface VerifiedRelease extends VerifiedIndex {
  release: DidPkgRelease;
  tarball: Uint8Array;
  /** current-key: a current assertionMethod key signed the manifest. index: only the current index vouches for it. */
  manifestKey: 'current-key' | 'index';
}

const pinId = (did: string, name: string) => `${did}/${name}`;

/** The proof `proof` of the object, if it verifies against the document. A non-TrustError is a defect, so it escapes. */
async function verifies(object: { proof: unknown }, proof: DataIntegrityProof, doc: DidDocument): Promise<string | undefined> {
  try {
    return (await verifyProof({ ...object, proof }, doc)).verificationMethod;
  } catch (e) {
    if (e instanceof TrustError) return undefined;
    throw e;
  }
}

/** Steps 1-3: resolve the DID, verify the index proof, then check key continuity and rollback against the pin. */
export async function verifyIndex(o: VerifyIndexOptions): Promise<VerifiedIndex> {
  const warnings: PolicyWarning[] = [];
  const tofu = (code: PolicyCode, message: string) => {
    if ((o.mode ?? 'enforce') === 'enforce') throw new PolicyError(code, message);
    warnings.push({ code, message });
  };

  // 1. Resolve the DID through its own method. The storage host is not involved.
  const resolved = await o.resolver.resolve(o.did);
  const doc = resolved.didDocument;
  if (resolved.didDocumentMetadata.deactivated) throw new PolicyError('DID_DEACTIVATED', `${o.did} is deactivated`);
  if (!doc || resolved.didResolutionMetadata.error) {
    throw new PolicyError('DID_RESOLUTION', `${o.did}: ${resolved.didResolutionMetadata.error?.type ?? 'no DID document'}`);
  }
  if (doc.id !== o.did) throw new PolicyError('DID_RESOLUTION', `the resolver returned ${doc.id}, not ${o.did}`);

  // 2. Every index copy. The highest sequence with a proof by a current assertionMethod key wins.
  // If no copy is valid, the error of the first copy (the DWN first) is the result.
  const copies = await o.reader.getIndexes(o.did, o.name);
  if (copies.length === 0) throw new PolicyError('INDEX_MISSING', `no index for ${pinId(o.did, o.name)}`);
  let best: { index: DidPkgIndex; epochMethod: string } | undefined;
  let firstError: unknown;
  for (const raw of copies) {
    try {
      const copy = await checkIndex(raw, o.did, o.name, doc);
      if (!best || copy.index.sequence > best.index.sequence) best = copy;
    } catch (e) {
      firstError ??= e;
    }
  }
  if (!best) throw firstError;
  const { index, epochMethod } = best;
  const epochKey = toMultikey(publicKeyOf(keyForRelationship(doc, epochMethod)));
  const indexDigest = contentDigest(index);

  // 3. Key continuity and rollback, against the pin of this DID and package.
  const pin = o.trust.get(pinId(o.did, o.name));
  let continuity: Continuity = pin ? 'pinned' : 'first-use';
  if (pin && !pin.keys.includes(epochKey)) {
    if (await coSigned(index, o.did, pin.keys)) {
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
  return { didDocument: doc, index, indexDigest, epochKey, continuity, warnings };
}

/** Steps 1-7: verify the index, the release status, the manifest and the tarball, then update the pin. */
export async function verifyRelease(o: VerifyReleaseOptions): Promise<VerifiedRelease> {
  const verified = await verifyIndex(o);
  const { index, indexDigest, epochKey, warnings } = verified;

  // 4. The release status from the signed index.
  const entry = Object.hasOwn(index.releases, o.version) ? index.releases[o.version] : undefined;
  const note = entry?.message ? `: ${entry.message}` : '';
  if (!entry) throw new PolicyError('NOT_LISTED', `${o.version} is not in the signed index`);
  if (entry.status === 'revoked') throw new PolicyError('REVOKED', `${o.version} is revoked${note}`);
  if (entry.status === 'yanked' && !o.exactPin) throw new PolicyError('YANKED', `${o.version} is yanked${note}. Only an exact lockfile pin installs it.`);
  if (entry.status === 'yanked') warnings.push({ code: 'YANKED', message: `${o.version} is yanked${note}` });
  if (entry.status === 'deprecated') warnings.push({ code: 'DEPRECATED', message: `${o.version} is deprecated${note}` });

  // 5. The manifest: the digest in the index, the fields, and the proof.
  const { release, manifestKey } = await checkRelease(o.reader, verified, o.version);

  // 6. The tarball: hash all bytes before one byte goes to npm.
  const tarball = await o.reader.getTarball(o.did, o.name, o.version, release.dist);
  if (!tarball) throw new PolicyError('TARBALL_MISSING', `no tarball for ${o.version}`);
  if (tarball.length !== release.dist.size || (await sri('sha512', tarball)) !== release.dist.integrity) {
    throw new PolicyError('INTEGRITY', 'the tarball bytes are not the bytes in the signed manifest');
  }

  // 7. Update the pin only after all checks pass. Step 3 rejects a lower sequence of the same key,
  // so this index is the newest index that the pin knows.
  const pin = o.trust.get(pinId(o.did, o.name));
  o.trust.set(pinId(o.did, o.name), {
    keys: [...new Set([...(pin?.keys ?? []), epochKey])],
    epochKey,
    sequence: index.sequence,
    indexDigest,
    releases: { ...pin?.releases, [o.version]: entry.digest },
  });
  return { ...verified, release, tarball, manifestKey };
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
): Promise<{ release: DidPkgRelease; manifestKey: VerifiedRelease['manifestKey'] }> {
  const { didDocument: doc, index } = verified;
  if (!Object.hasOwn(index.releases, version)) throw new PolicyError('NOT_LISTED', `${version} is not in the signed index`);
  const { digest } = index.releases[version]!;
  const raw = await reader.getRelease(index.publisher, index.name, version, digest);
  if (raw === null || raw === undefined) throw new PolicyError('MANIFEST_MISSING', `no manifest for ${version}`);
  const release = parseRelease(raw);
  if (contentDigest(release) !== digest) throw new PolicyError('MANIFEST_DIGEST', 'the manifest is not the manifest in the signed index');
  if (release.publisher !== index.publisher || release.name !== index.name || release.version !== version) {
    throw new PolicyError('MANIFEST_FIELDS', 'the manifest publisher, name or version is not the requested value');
  }
  return { release, manifestKey: await manifestKeyOf(release, doc) };
}

// Step 2 for one index copy: the schema, the fields, and a proof by a key in assertionMethod now.
async function checkIndex(raw: unknown, did: string, name: string, doc: DidDocument) {
  const index = parseIndex(raw);
  if (index.publisher !== did || index.name !== name) {
    throw new PolicyError('INDEX_FIELDS', `the index is for ${pinId(index.publisher, index.name)}`);
  }
  for (const proof of proofsOf(index)) {
    const epochMethod = await verifies(index, proof, doc);
    if (epochMethod) return { index, epochMethod };
  }
  throw new PolicyError('INDEX_SIGNATURE', 'no index proof by a current assertionMethod key');
}

// L2: a proof by a pinned key. The DID document does not hold that key now, so a one-key document checks it.
async function coSigned(index: DidPkgIndex, did: string, pinnedKeys: string[]): Promise<boolean> {
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
async function manifestKeyOf(release: DidPkgRelease, doc: DidDocument): Promise<'current-key' | 'index'> {
  const proofs = proofsOf(release);
  for (const proof of proofs) {
    const method = proof.verificationMethod;
    if (typeof method !== 'string' || !method.startsWith(`${doc.id}#`)) {
      throw new PolicyError('MANIFEST_SIGNATURE', `the manifest proof method ${String(method)} is not a method of ${doc.id}`);
    }
  }
  for (const proof of proofs) if (await verifies(release, proof, doc)) return 'current-key';
  return 'index';
}
