// The npm packument of a verified package (ADR 0003 section 8).
// Each listed version must pass the manifest checks of the tarball route (checkRelease), so the
// packument never lists a version that the tarball route rejects. If one listed manifest is absent
// or bad, the packument fails: a storage host must not hide a signed version (a selective rollback).
import { format } from '../name/grammar.ts';
import type { DidDocument } from '../did/types.ts';
import { compareVersions, type DidPkgRelease } from '../trust/release.ts';
import { checkRelease, type ReleaseReader, type VerifiedIndex } from '../trust/verify.ts';
import type { XidDocumentInfo } from '../xid/document.ts';
import { checkXidRelease, type VerifiedXidIndex, type XidPkgRelease } from '../xid/release.ts';

/** One entry of `versions`. The signed `npm` fields of the release, plus the fields that the builder sets. */
export interface PackumentVersion {
  name: string;
  version: string;
  deprecated?: string;
  dist: { integrity: string; tarball: string };
  [field: string]: unknown;
}

export interface Packument {
  _id: string;
  name: string;
  'dist-tags': Record<string, string>;
  /** The publish time of each listed version, as the publisher asserts it. */
  time: Record<string, string>;
  versions: Record<string, PackumentVersion>;
}

/** One verified release. `didDocument` for a DID publisher, `xidDocument` for a XID publisher. */
export type TarballUrlInput =
  | { /** The canonical install name of the publisher and the package. */ installName: string; release: DidPkgRelease; didDocument: DidDocument }
  | { installName: string; release: XidPkgRelease; xidDocument: XidDocumentInfo };

export interface PackumentOptions {
  /** The result of verifyIndex or verifyXidIndex. */
  verified: Pick<VerifiedIndex, 'didDocument' | 'index'> | Pick<VerifiedXidIndex, 'xidDocument' | 'index'>;
  /** Usually the PackageSource that verifyIndex used. */
  reader: Pick<ReleaseReader, 'getRelease'>;
  /** The `dist.tarball` URL of one verified release. The shim decides the query. */
  tarballUrl: (input: TarballUrlInput) => string;
}

// The npm `deprecated` value of a deprecated version with no message.
const DEPRECATED = 'deprecated';
// The prerelease starts at the first "-" before the build metadata.
const isPrerelease = (version: string) => version.split('+')[0]!.includes('-');

/**
 * The packument of a verified index. It lists the `active` and `deprecated` versions in SemVer order,
 * and omits `yanked` and `revoked` versions. The index owns the status, so a `deprecated` field in the
 * signed `npm` fields does not count. The builder sets `name` (the install name), `version` and `dist`.
 * A dist-tag of an omitted version is dropped. If no `latest` tag is left, `latest` is the highest
 * listed version with no prerelease, else the highest listed version (ADR 0003 section 8).
 */
export async function buildPackument(o: PackumentOptions): Promise<Packument> {
  const { verified } = o;
  const { index } = verified;
  const installName = format(index.publisher, index.name);
  const listed = Object.keys(index.releases)
    .filter((v) => ['active', 'deprecated'].includes(index.releases[v]!.status))
    .sort((a, b) => compareVersions(a, b) || (a < b ? -1 : 1));

  // Read in parallel. If more versions fail, the error of the lowest version is the result.
  const check = (v: string) => ('xidDocument' in verified ? checkXidRelease(o.reader, verified, v) : checkRelease(o.reader, verified, v));
  const releases: (DidPkgRelease | XidPkgRelease)[] = [];
  for (const r of await Promise.allSettled(listed.map(check))) {
    if (r.status === 'rejected') throw r.reason;
    releases.push(r.value.release);
  }
  const urlOf = (release: DidPkgRelease | XidPkgRelease): string =>
    o.tarballUrl('xidDocument' in verified
      ? { installName, release: release as XidPkgRelease, xidDocument: verified.xidDocument }
      : { installName, release: release as DidPkgRelease, didDocument: verified.didDocument });

  const versions: Record<string, PackumentVersion> = {};
  const time: Record<string, string> = {};
  for (const release of releases) {
    const { status, message } = index.releases[release.version]!;
    const { deprecated: _ignored, ...npm } = release.npm;
    versions[release.version] = {
      ...npm,
      name: installName,
      version: release.version,
      ...(status === 'deprecated' ? { deprecated: message || DEPRECATED } : {}),
      dist: { integrity: release.dist.integrity, tarball: urlOf(release) },
    };
    time[release.version] = release.published;
  }

  const distTags = Object.fromEntries(Object.entries(index.distTags).filter(([, v]) => Object.hasOwn(versions, v)));
  if (!Object.hasOwn(distTags, 'latest') && listed.length > 0) {
    distTags.latest = listed.filter((v) => !isPrerelease(v)).at(-1) ?? listed.at(-1)!;
  }
  return { _id: installName, name: installName, 'dist-tags': distTags, time, versions };
}
