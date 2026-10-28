// The signed objects of a package: the release manifest `DidPkgRelease` (one per version, immutable)
// and the package index `DidPkgIndex` (one per package, the mutable head). The storage host is not
// trusted, so a reader must parse each object with parseRelease or parseIndex before use.
// The schemas are v1. A v1 reader accepts unknown members, because v1 can only get new members.
import { PolicyError, TrustError, type PolicyCode } from './errors.ts';
import { addProof, DATE_TIME_STAMP, type DataIntegrityProof, type Signer } from './proof.ts';

export const RELEASE_STATUSES = ['active', 'deprecated', 'yanked', 'revoked'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export interface DidPkgRelease {
  type: 'DidPkgRelease';
  specVersion: '1';
  /** The publisher DID. It must be the DID in the install name. */
  publisher: string;
  /** The package name, with no npm route scope. */
  name: string;
  /** A SemVer 2.0.0 version. */
  version: string;
  /** The publish time, as the publisher asserts it. Never use it for a security decision. */
  published: string;
  /** The sha512 SRI and the length of the exact .tgz bytes. */
  dist: { integrity: string; size: number };
  /** The packument fields: dependencies, bin, engines, hasInstallScript. */
  npm: Record<string, unknown>;
  /** The release before this one, in publish order (a hash chain). */
  previous: { version: string; digest: string } | null;
  proof: DataIntegrityProof | DataIntegrityProof[];
  [property: string]: unknown;
}

export interface IndexEntry {
  /** The contentDigest of the release manifest. */
  digest: string;
  status: ReleaseStatus;
  message?: string;
}

export interface DidPkgIndex {
  type: 'DidPkgIndex';
  specVersion: '1';
  publisher: string;
  name: string;
  /** It rises with each new index of one signing key. */
  sequence: number;
  /** The index time, as the publisher asserts it. Never use it for a security decision. */
  updated: string;
  /** The contentDigest of the index before this one. */
  previous: string | null;
  distTags: Record<string, string>;
  releases: Record<string, IndexEntry>;
  /** A proof set on a key rotation: the new key and the old key. */
  proof: DataIntegrityProof | DataIntegrityProof[];
  [property: string]: unknown;
}

const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;
const SHA256_DIGEST = /^sha256-[A-Za-z0-9+/]{43}=$/;
// SemVer 2.0.0, the regular expression that semver.org gives.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTime = (v: unknown) => typeof v === 'string' && DATE_TIME_STAMP.test(v) && !Number.isNaN(Date.parse(v));
const isVersion = (v: unknown) => typeof v === 'string' && SEMVER.test(v);
const isDigest = (v: unknown) => typeof v === 'string' && SHA256_DIGEST.test(v);
// The proof members are checked by verifyProof. Here, only the shape: one object or a set of objects.
const isProof = (v: unknown) => isObject(v) || (Array.isArray(v) && v.length > 0 && v.every(isObject));

function checker(code: PolicyCode, object: string) {
  return (ok: boolean, member: string) => {
    if (!ok) throw new PolicyError(code, `${object}: ${member} is not valid`);
  };
}

/** The value as a DidPkgRelease. It is the same object, so contentDigest covers each member. */
export function parseRelease(value: unknown): DidPkgRelease {
  const check = checker('MANIFEST_SCHEMA', 'DidPkgRelease');
  check(isObject(value), 'the manifest');
  const m = value as Json;
  check(m.type === 'DidPkgRelease', 'type');
  check(m.specVersion === '1', 'specVersion');
  check(isText(m.publisher) && m.publisher.startsWith('did:'), 'publisher');
  check(isText(m.name), 'name');
  check(isVersion(m.version), 'version');
  check(isTime(m.published), 'published');
  const dist = m.dist as Json;
  check(isObject(dist) && typeof dist.integrity === 'string' && SHA512_SRI.test(dist.integrity), 'dist.integrity');
  check(Number.isSafeInteger(dist.size) && (dist.size as number) >= 0, 'dist.size');
  check(isObject(m.npm), 'npm');
  const previous = m.previous as Json | null;
  check(previous === null || (isObject(previous) && isVersion(previous.version) && isDigest(previous.digest)), 'previous');
  check(isProof(m.proof), 'proof');
  return value as DidPkgRelease;
}

/** The value as a DidPkgIndex. It is the same object, so contentDigest covers each member. */
export function parseIndex(value: unknown): DidPkgIndex {
  const check = checker('INDEX_SCHEMA', 'DidPkgIndex');
  check(isObject(value), 'the index');
  const ix = value as Json;
  check(ix.type === 'DidPkgIndex', 'type');
  check(ix.specVersion === '1', 'specVersion');
  check(isText(ix.publisher) && ix.publisher.startsWith('did:'), 'publisher');
  check(isText(ix.name), 'name');
  check(Number.isSafeInteger(ix.sequence) && (ix.sequence as number) >= 1, 'sequence');
  check(isTime(ix.updated), 'updated');
  check(ix.previous === null || isDigest(ix.previous), 'previous');
  check(isObject(ix.releases), 'releases');
  for (const [version, entry] of Object.entries(ix.releases as Json)) {
    const e = entry as Json;
    check(isVersion(version), `releases version ${version}`);
    check(isObject(e) && isDigest(e.digest), `releases[${version}].digest`);
    check((RELEASE_STATUSES as readonly unknown[]).includes(e.status), `releases[${version}].status`);
    check(e.message === undefined || typeof e.message === 'string', `releases[${version}].message`);
  }
  check(isObject(ix.distTags), 'distTags');
  for (const [tag, version] of Object.entries(ix.distTags as Json)) {
    check(isText(tag) && typeof version === 'string' && Object.hasOwn(ix.releases as Json, version), `distTags.${tag}`);
  }
  check(isProof(ix.proof), 'proof');
  return value as DidPkgIndex;
}

/** The proofs of a signed object, as a list. */
export const proofsOf = (object: { proof: DataIntegrityProof | DataIntegrityProof[] }): DataIntegrityProof[] =>
  ([] as DataIntegrityProof[]).concat(object.proof);

/**
 * Sign the object with each signer. Each proof covers the object with no `proof` member, so the
 * contentDigest does not change. One signer gives one proof. More signers give a proof set
 * (VC Data Integrity 1.0 section 2.1), for example the new key and the old key on a rotation.
 */
export async function signObject<T extends Json>(
  object: T,
  signers: Signer[],
  created?: string,
): Promise<Omit<T, 'proof'> & { proof: DataIntegrityProof | DataIntegrityProof[] }> {
  if (signers.length === 0) throw new TrustError('PROOF_GENERATION_ERROR', 'malformed-proof', 'no signer');
  const { proof: _replaced, ...unsecured } = object;
  const set: DataIntegrityProof[] = [];
  for (const signer of signers) set.push((await addProof(unsecured, signer, { created })).proof);
  return { ...unsecured, proof: set.length === 1 ? set[0]! : set } as Omit<T, 'proof'> & { proof: DataIntegrityProof | DataIntegrityProof[] };
}
