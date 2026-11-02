// `didpkg drl`: the checks of the shim for one version, then the plain HTTPS URL of the signed tarball.
// npm installs from this URL with no shim, but npm then checks no DID signature. Thus the result also
// holds the signed sha512: the lockfile integrity must be equal to it.
import { errorCode, type DidResolver } from '@didpkg/core/did';
import { parse } from '@didpkg/core/name';
import { SourceError, type FoundTarball, type PackageSource } from '@didpkg/core/source';
import { PolicyError, verifyIndex, verifyRelease, type PolicyWarning, type ReleaseReader } from '@didpkg/core/trust';
import { DENYLIST, packedError } from './shim/shim.ts';

export interface DrlOptions {
  /** `<install-name>@<version>`, or `<install-name>` for the `latest` dist-tag of the signed index. */
  spec: string;
  resolver: Pick<DidResolver, 'resolve'>;
  source: Pick<PackageSource, 'getIndexes' | 'getRelease' | 'findTarball'>;
  /** More DIDs to refuse, in addition to DENYLIST. */
  denylist?: readonly string[];
}

export interface Drl {
  did: string;
  name: string;
  version: string;
  /** For a DWN: the DRL of the tarball record. For a static mirror: the layout URL of the tarball. */
  url: string;
  /** The service of the DID document that gave the tarball. */
  endpoint: string;
  /** The sha512 of the signed release. */
  integrity: string;
  warnings: PolicyWarning[];
}

export async function drl(o: DrlOptions): Promise<Drl> {
  // An install name has no "@" after the scope, so the last "@" after index 0 starts the version.
  const at = o.spec.lastIndexOf('@');
  const p = parse(at > 0 ? o.spec.slice(0, at) : o.spec);
  if (p.form !== 'direct') throw new Error('a hash-form name needs a DID binding');
  const { did, name } = p;
  if (DENYLIST.includes(did) || o.denylist?.includes(did)) throw new Error(`DID_RESOLUTION: ${did} is on the denylist (SECURITY.md)`);
  const code = errorCode(await o.resolver.resolve(did));
  if (code) throw new Error(`${did}: ${code}`);

  // The verifier reads the tarball one time. This reader keeps the copy that it got, with its URL.
  let found: FoundTarball | null = null;
  const reader: ReleaseReader = {
    getIndexes: (d, n) => o.source.getIndexes(d, n),
    getRelease: (d, n, v, digest) => o.source.getRelease(d, n, v, digest),
    getTarball: async (d, n, v, dist) => (found = await o.source.findTarball(d, n, v, dist))?.bytes ?? null,
  };
  const opts = { did, name, resolver: o.resolver, reader, trust: new Map() };
  try {
    const version = at > 0 ? o.spec.slice(at + 1) : (await verifyIndex(opts)).index.distTags.latest;
    if (!version) throw new Error(`the index of ${name} has no latest dist-tag: add @<version>`);
    const v = await verifyRelease({ ...opts, version });
    const bad = packedError(v.tarball, name, version);
    if (bad) throw new Error(bad);
    const copy = found as FoundTarball | null;
    if (!copy?.url) throw new Error(`no endpoint gives a URL for the tarball of ${name}@${version}`);
    return { did, name, version, url: copy.url, endpoint: copy.endpoint.serviceId, integrity: v.release.dist.integrity, warnings: v.warnings };
  } catch (e) {
    if (e instanceof PolicyError || e instanceof SourceError) throw new Error(`${e.code}: ${e.message}`);
    throw e;
  }
}
