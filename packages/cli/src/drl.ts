// `didpkg drl`: the checks of the shim for one version, then the plain HTTPS URL of the signed tarball.
// npm installs from this URL with no shim, but npm then checks no DID or XID signature. Thus the result
// also holds the signed sha512: the lockfile integrity must be equal to it.
import { errorCode, type DidResolver } from '@didpkg/core/did';
import { parse } from '@didpkg/core/name';
import { SourceError, type FoundTarball, type PackageSource } from '@didpkg/core/source';
import {
  PolicyError, verifyIndex, verifyRelease, type IndexFields, type PolicyWarning, type ReleaseFields, type ReleaseReader,
} from '@didpkg/core/trust';
import { verifyXidIndex, verifyXidRelease, type XidDocumentResolver } from '@didpkg/core/xid';
import { DENYLIST, packedError } from './shim/shim.ts';

export interface DrlOptions {
  /** `<install-name>@<version>`, or `<install-name>` for the `latest` dist-tag of the signed index. */
  spec: string;
  resolver: Pick<DidResolver, 'resolve'>;
  /** The resolver of XID documents. With no XID resolver, "drl" refuses each XID name. */
  xidResolver?: XidDocumentResolver;
  source: Pick<PackageSource, 'getIndexes' | 'getRelease' | 'findTarball'>;
  /** More DIDs and XIDs (hex) to refuse, in addition to DENYLIST. */
  denylist?: readonly string[];
}

/** The publisher is `did` for a DID name and `xid` (64 hex characters) for a XID name. */
export type Drl = ({ did: string } | { xid: string }) & {
  name: string;
  version: string;
  /** For a DWN: the DRL of the tarball record. For a static mirror: the layout URL of the tarball. */
  url: string;
  /** The service of the DID or XID document that gave the tarball. */
  endpoint: string;
  /** The sha512 of the signed release. */
  integrity: string;
  warnings: PolicyWarning[];
};

/** The checks of one publisher kind, as in the shim. */
interface Checks {
  index(): Promise<{ index: IndexFields }>;
  release(version: string): Promise<{ release: ReleaseFields; tarball: Uint8Array; warnings: PolicyWarning[] }>;
}

export async function drl(o: DrlOptions): Promise<Drl> {
  // An install name has no "@" after the scope, so the last "@" after index 0 starts the version.
  const at = o.spec.lastIndexOf('@');
  const p = parse(at > 0 ? o.spec.slice(0, at) : o.spec);
  if (p.kind === 'did' && p.form !== 'direct') throw new Error('a hash-form name needs a DID binding');
  const { name } = p;
  const publisher = p.kind === 'xid' ? { xid: p.xid } : { did: p.did };
  const id = p.kind === 'xid' ? p.xid : p.did;
  if (DENYLIST.includes(id) || o.denylist?.includes(id)) {
    throw new Error(`${p.kind === 'did' ? 'DID_RESOLUTION: ' : ''}${id} is on the denylist (SECURITY.md)`);
  }

  // The verifier reads the tarball one time. This reader keeps the copy that it got, with its URL.
  let found: FoundTarball | null = null;
  const reader: ReleaseReader = {
    getIndexes: (d, n) => o.source.getIndexes(d, n),
    getRelease: (d, n, v, digest) => o.source.getRelease(d, n, v, digest),
    getTarball: async (d, n, v, dist) => (found = await o.source.findTarball(d, n, v, dist))?.bytes ?? null,
  };
  const opts = { name, reader, trust: new Map() };
  let checks: Checks;
  if (p.kind === 'xid') {
    const { xid } = p;
    const resolver = o.xidResolver;
    if (!resolver) throw new Error('KIND_NOT_SUPPORTED: "drl" has no XID resolver');
    checks = {
      index: () => verifyXidIndex({ ...opts, xid, resolver }),
      release: (version) => verifyXidRelease({ ...opts, xid, resolver, version }),
    };
  } else {
    const { did } = p;
    const code = errorCode(await o.resolver.resolve(did));
    if (code) throw new Error(`${did}: ${code}`);
    checks = {
      index: () => verifyIndex({ ...opts, did, resolver: o.resolver }),
      release: (version) => verifyRelease({ ...opts, did, resolver: o.resolver, version }),
    };
  }

  try {
    const version = at > 0 ? o.spec.slice(at + 1) : (await checks.index()).index.distTags.latest;
    if (!version) throw new Error(`the index of ${name} has no latest dist-tag: add @<version>`);
    const v = await checks.release(version);
    const bad = packedError(v.tarball, name, version);
    if (bad) throw new Error(bad);
    const copy = found as FoundTarball | null;
    if (!copy?.url) throw new Error(`no endpoint gives a URL for the tarball of ${name}@${version}`);
    return { ...publisher, name, version, url: copy.url, endpoint: copy.endpoint.serviceId, integrity: v.release.dist.integrity, warnings: v.warnings };
  } catch (e) {
    if (e instanceof PolicyError || e instanceof SourceError) throw new Error(`${e.code}: ${e.message}`);
    throw e;
  }
}
