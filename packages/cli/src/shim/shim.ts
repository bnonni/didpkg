// The npm shim handler: (req: Request) => Promise<Response> (docs/how-it-works.md "Checks at install").
// No framework path patterns: route() parses the raw path. The shim verifies, then serves. It keeps no keys.
// HTTP results: ADR 0003 section 5.
import { errorCode, type DidResolver } from '@didpkg/core/did';
import { route } from '@didpkg/core/name';
import { buildPackument, SourceError, type PackumentOptions, type TarballUrlInput } from '@didpkg/core/source';
import {
  contentDigest, PolicyError, proofsOf, verifyIndex, verifyRelease,
  type PolicyCode, type PolicyMode, type PolicyWarning, type ReleaseReader, type TrustStore,
} from '@didpkg/core/trust';
import {
  verifyXidIndex, verifyXidRelease, xidContentDigest, XidError, type XidDocumentResolver, type XidErrorCode,
} from '@didpkg/core/xid';
import { readTarball } from '../publish/tarball.ts';

/** The compromised DIDs of SECURITY.md. The shim refuses every package from them. */
export const DENYLIST: readonly string[] = [
  'did:dht:umrapzbqwwp67m79koe5yf7x9h7kbzuctt4g6encchptm66dfkfo',
  'did:dht:tzarizg6dprr5x8djfy35h7k86z7hy9bdzzsa4jd9qt7rtnjqg1o',
];

export interface ShimOptions {
  /** The origin of the dist.tarball URLs, for example http://127.0.0.1:2092. */
  origin: string;
  resolver: Pick<DidResolver, 'resolve'>;
  /** The XID resolver of the PackageSource. With no XID resolver, the shim refuses each XID name. */
  xidResolver?: XidDocumentResolver;
  /** One PackageSource for the shim lifetime. */
  source: ReleaseReader;
  /** The TOFU pins. The shim keeps them in memory only. */
  trust: TrustStore;
  mode?: PolicyMode;
  /** More DIDs and XIDs (hex) to refuse, in addition to DENYLIST. */
  denylist?: readonly string[];
  /** Gets one line per request, and one line per warning. */
  log?: (line: string) => void;
}

// The policy codes of "unknown package or version". Each other PolicyError is a signed-policy failure (403).
const NOT_FOUND: readonly PolicyCode[] = ['INDEX_MISSING', 'NOT_LISTED', 'MANIFEST_MISSING', 'TARBALL_MISSING'];
// The XID codes of "no usable source": 502, as a DID resolution error. Each other XID code
// (a rollback, a fork, a broken chain, a wrong XID) is a signed-policy failure (403).
const XID_UNAVAILABLE: readonly XidErrorCode[] = ['XID_UNAVAILABLE', 'XID_INVALID'];

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const json = (status: number, body: unknown) => Response.json(body, { status });

/**
 * The tarball URL holds only facts of the signed release: `rec` (its contentDigest) and `vm` (its proof
 * method). Thus the URL of a version never changes, also after a key rotation (pnpm frozen installs).
 * `rec` pins the release bytes, so a key swap under the same `vm` gives another `rec`. A XID release
 * names no key (a Gordian signature has no key id), so its URL has only `rec`.
 */
export function tarballUrl(origin: string, input: TarballUrlInput): string {
  const { installName, release } = input;
  const body = installName.slice(installName.indexOf('/') + 1);
  if ('xidDocument' in input) return `${origin}/${installName}/-/${body}-${release.version}.tgz?${new URLSearchParams({ rec: xidContentDigest(input.release) })}`;
  const q = new URLSearchParams({ rec: contentDigest(input.release) });
  const vm = proofsOf(input.release)[0]?.verificationMethod;
  if (vm) q.set('vm', vm);
  return `${origin}/${installName}/-/${body}-${release.version}.tgz?${q}`;
}

/** The checks of one publisher kind: the index for a packument, and one release for a tarball. */
interface Checks {
  index(): Promise<PackumentOptions['verified'] & { warnings: PolicyWarning[] }>;
  release(version: string, exactPin: boolean): Promise<{ digest: string; tarball: Uint8Array; warnings: PolicyWarning[] }>;
}

export function shimHandler(o: ShimOptions): (req: Request) => Promise<Response> {
  const denied = new Set([...DENYLIST, ...(o.denylist ?? [])]);
  const log = o.log ?? (() => {});
  const mode = o.mode ?? 'enforce';
  const urlOf = (input: TarballUrlInput) => tarballUrl(o.origin, input);

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const line = `${req.method} ${url.pathname}`;
    try {
      // route() gives 404 for each other path, also /-/npm/v1/attestations/* (pnpm 11 asks for it).
      const r = route(req.method, url.pathname);
      if (r.kind === 'reject') throw new HttpError(r.status, r.reason);
      if (r.kind === 'publish') throw new HttpError(405, 'the shim does not publish');
      const { parsed } = r;
      if (parsed.kind === 'did' && parsed.form !== 'direct') throw new HttpError(404, 'a hash-form name needs a DID binding');
      const { name } = parsed;
      const common = { name, reader: o.source, trust: o.trust, mode };
      let checks: Checks;
      if (parsed.kind === 'xid') {
        const { xid } = parsed;
        if (denied.has(xid)) throw new HttpError(403, `${xid} is on the denylist (SECURITY.md)`);
        const resolver = o.xidResolver;
        if (!resolver) throw new HttpError(404, 'KIND_NOT_SUPPORTED: the shim has no XID resolver');
        checks = {
          index: () => verifyXidIndex({ ...common, xid, resolver }),
          release: async (version, exactPin) => {
            const v = await verifyXidRelease({ ...common, xid, resolver, version, exactPin });
            return { digest: v.index.releases[version]!.digest, tarball: v.tarball, warnings: v.warnings };
          },
        };
      } else {
        const { did } = parsed;
        if (denied.has(did)) throw new PolicyError('DID_RESOLUTION', `${did} is on the denylist (SECURITY.md)`);
        const code = errorCode(await o.resolver.resolve(did));
        if (code === 'NOT_FOUND' || code === 'METHOD_NOT_SUPPORTED') throw new HttpError(404, `${did}: ${code}`);
        if (code) throw new HttpError(502, `${did}: ${code}`);
        checks = {
          index: () => verifyIndex({ ...common, did, resolver: o.resolver }),
          release: async (version, exactPin) => {
            const v = await verifyRelease({ ...common, did, resolver: o.resolver, version, exactPin });
            return { digest: v.index.releases[version]!.digest, tarball: v.tarball, warnings: v.warnings };
          },
        };
      }

      if (r.kind === 'packument') {
        const verified = await checks.index();
        for (const w of verified.warnings) log(`  warn ${w.code}: ${w.message}`);
        const packument = await buildPackument({ verified, reader: o.source, tarballUrl: urlOf });
        log(`${line} 200`);
        return json(200, packument);
      }

      // A yanked version is not in the packument. Thus a request with `rec` comes from a lockfile pin.
      const rec = url.searchParams.get('rec');
      const v = await checks.release(r.version, rec !== null);
      const { digest } = v;
      if (rec !== null && rec !== digest) throw new PolicyError('HISTORY_CHANGED', 'the release in the lockfile is not the signed release');
      const bad = packedError(v.tarball, name, r.version);
      if (bad) throw new HttpError(403, bad);
      for (const w of v.warnings) log(`  warn ${w.code}: ${w.message}`);
      log(`${line} 200`);
      return new Response(v.tarball, { headers: { 'content-type': 'application/octet-stream' } });
    } catch (e) {
      const { status, message } = httpError(e);
      log(`${line} ${status} ${message}`);
      return json(status, { error: message });
    }
  };
}

/**
 * The error text if the signed tarball is not the `npm pack` tarball of `name@version`. `didpkg publish`
 * signs the `npm pack` tarball of the package name, so package.json has `name`, not the install name.
 */
export function packedError(tarball: Uint8Array, name: string, version: string): string | undefined {
  let packed: { name: string; version: string };
  try {
    packed = readTarball(tarball);
  } catch (e) {
    return `the signed tarball is not an npm pack tarball: ${(e as Error).message}`;
  }
  if (packed.name !== name || packed.version !== version) return `the tarball package.json is ${packed.name}@${packed.version}, not ${name}@${version}`;
  return undefined;
}

/** The HTTP result of an error. A defect (not a PolicyError, SourceError or HttpError) gives 500. */
export function httpError(e: unknown): { status: number; message: string } {
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  if (e instanceof SourceError) return { status: 502, message: `${e.code}: ${e.message}` };
  if (e instanceof XidError) {
    const status = e.code === 'XID_NOT_FOUND' ? 404 : XID_UNAVAILABLE.includes(e.code) ? 502 : 403;
    return { status, message: e.message };
  }
  if (e instanceof PolicyError) return { status: NOT_FOUND.includes(e.code) ? 404 : 403, message: `${e.code}: ${e.message}` };
  return { status: 500, message: e instanceof Error ? e.message : String(e) };
}
