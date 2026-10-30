// The publisher side: sign a release manifest and the next index head. The test builders of
// test/trust/sim.ts moved here for `didpkg publish`.
import { contentDigest, sri } from './digest.ts';
import type { Signer } from './proof.ts';
import { compareVersions, SEMVER, signObject, type DidPkgIndex, type DidPkgRelease, type IndexEntry } from './release.ts';

// The same form as the default proof `created`: no fraction of a second.
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The publish rule for a version: SemVer 2.0.0 with no build metadata. `1.0.0+a` and `1.0.0+b` have one
 * precedence, so npm and pnpm can confuse them (ADR 0003, Consequences). A verifier accepts build metadata,
 * because another tool can publish it.
 */
export function checkVersion(version: string): void {
  const m = SEMVER.exec(version);
  if (!m) throw new TypeError(`not a SemVer 2.0.0 version: ${version}`);
  if (m[5] !== undefined) throw new TypeError(`${version}: a version with build metadata is not published`);
}

export interface ReleaseInput {
  publisher: string;
  name: string;
  version: string;
  /** The exact `npm pack` bytes. */
  tarball: Uint8Array;
  /** The packument fields: dependencies, bin, engines, hasInstallScript. */
  npm: Record<string, unknown>;
  /** The head index before this release, or null. Its last release is `previous`. */
  head: DidPkgIndex | null;
  /** The publish time and the proof time. Default: now. */
  published?: string;
}

/** A new signed release manifest. */
export async function signRelease(o: ReleaseInput, signers: Signer[]): Promise<DidPkgRelease> {
  // The index lists the releases in publish order, and a version key is never an array index.
  const last = o.head ? Object.keys(o.head.releases).at(-1) : undefined;
  const published = o.published ?? now();
  return (await signObject({
    type: 'DidPkgRelease', specVersion: '1', publisher: o.publisher, name: o.name, version: o.version, published,
    dist: { integrity: await sri('sha512', o.tarball), size: o.tarball.length },
    npm: o.npm,
    previous: o.head && last ? { version: last, digest: o.head.releases[last]!.digest } : null,
  }, signers, published)) as DidPkgRelease;
}

const LIVE: readonly string[] = ['active', 'deprecated'];

/** The highest active or deprecated stable version. If there is none, the highest active or deprecated prerelease. */
export function latestOf(releases: Record<string, IndexEntry>): string | undefined {
  const live = Object.keys(releases).filter((v) => LIVE.includes(releases[v]!.status)).sort(compareVersions);
  return live.filter((v) => SEMVER.exec(v)?.[4] === undefined).at(-1) ?? live.at(-1);
}

export interface IndexInput {
  publisher: string;
  name: string;
  /** The head index, or null for the first index. */
  head: DidPkgIndex | null;
  /** The release list. Default: the list of the head. */
  releases?: Record<string, IndexEntry>;
  /** Default: the dist-tags of the head, with `latest` from latestOf. */
  distTags?: Record<string, string>;
  /** Default: the head sequence + 1. Only a test sets it. */
  sequence?: number;
  /** The index time and the proof time. Default: now. */
  updated?: string;
}

/** The next signed index head. `previous` is the contentDigest of the head. */
export async function signIndex(o: IndexInput, signers: Signer[]): Promise<DidPkgIndex> {
  const releases = o.releases ?? o.head?.releases ?? {};
  const latest = latestOf(releases);
  const { latest: _old, ...tags } = o.head?.distTags ?? {};
  const updated = o.updated ?? now();
  return (await signObject({
    type: 'DidPkgIndex', specVersion: '1', publisher: o.publisher, name: o.name,
    sequence: o.sequence ?? (o.head?.sequence ?? 0) + 1, updated,
    previous: o.head ? contentDigest(o.head) : null,
    distTags: o.distTags ?? (latest ? { ...tags, latest } : tags), releases,
  }, signers, updated)) as DidPkgIndex;
}
