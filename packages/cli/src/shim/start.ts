// `didpkg shim start`: the shim on 127.0.0.1 only. One resolver, one DWN adapter and one PackageSource
// for the shim lifetime, so their caches and the DWN rate limit hold across requests.
// The server is node:http, so the same code runs on Bun and on Node (the npm package).
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DidResolver, jwkDriver, keyDriver } from '@didpkg/core/did';
import { btcr2Driver, type Btcr2DriverOptions } from '@didpkg/core/did/btcr2';
import { dhtDriver } from '@didpkg/core/did/dht';
import { plcDriver } from '@didpkg/core/did/plc';
import { webDriver } from '@didpkg/core/did/web';
import { webvhDriver } from '@didpkg/core/did/webvh';
import { PackageSource } from '@didpkg/core/source';
import type { PolicyMode } from '@didpkg/core/trust';
import { DEFAULT_XID_RESOLVERS, memoryXidCache, resolveXid, type XidCache, type XidDocumentResolver } from '@didpkg/core/xid';
import { dwnAdapter } from '@didpkg/adapter-dwn';
import { httpsAdapter } from '@didpkg/adapter-https';
import { sidecarSource } from './sidecar.ts';
import { shimHandler } from './shim.ts';

export const DEFAULT_PORT = 2092;
/** Install uses a cached DID document for 7 days if the method fails. */
export const STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1000;
/** The shim uses a resolved XID document for 1 minute, so one install does not fetch it for each request. */
export const XID_TTL_MS = 60_000;

/** The read side of the shim and of `didpkg drl`: the DID drivers and the storage adapters. */
export interface ReadSideOptions {
  relays?: readonly string[];
  /** IPFS Trustless Gateway base URLs for did:btcr2. Default: CAS_GATEWAYS of the driver. */
  cas?: readonly string[];
  /** The Esplora API base URL for each network of did:btcr2. It replaces the default of that network. */
  esplora?: Btcr2DriverOptions['esplora'];
  /** The mirror base URLs of the did:btcr2 Sidecar Data, in order. Default: none. */
  sidecar?: readonly string[];
  /** XID resolver base URLs. The document of a XID is at `<url>/xid/<hex>.envelope`. Default: none. */
  xidResolvers?: readonly string[];
  /**
   * The config folder: the Sidecar Data of its identities, a copy of each verified did:btcr2 resolve, and the
   * newest XID document of each XID (`xid/<hex>.envelope`). Default: none.
   */
  home?: string;
  /** Read DWN and repository endpoints, DID documents and relays on a loopback host. Only for tests and a local demo. */
  allowLoopback?: boolean;
  log?: (line: string) => void;
}

export interface StartShimOptions extends ReadSideOptions {
  /** 0 selects a free port. Default: 2092. */
  port?: number;
  mode?: PolicyMode;
}

/** The newest verified XID document of each XID, in `<home>/xid/<hex>.envelope`. resolveXid checks the XID first. */
export function fileXidCache(home: string): XidCache {
  const dir = join(home, 'xid');
  return {
    get: (xid) => readFile(join(dir, `${xid}.envelope`)).then((b) => new Uint8Array(b), (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    }),
    async put(xid, bytes) {
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${xid}.envelope`);
      const tmp = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(tmp, bytes, { flag: 'wx' });
        await rename(tmp, path);
      } finally {
        await rm(tmp, { force: true });
      }
    },
  };
}

function xidResolver(o: ReadSideOptions): XidDocumentResolver {
  const cache = o.home ? fileXidCache(o.home) : memoryXidCache();
  const memo = new Map<string, { at: number; doc: ReturnType<XidDocumentResolver['resolve']> }>();
  return {
    resolve(xid) {
      const hit = memo.get(xid);
      if (hit && Date.now() - hit.at < XID_TTL_MS) return hit.doc;
      const doc = resolveXid(xid, { resolvers: o.xidResolvers ?? DEFAULT_XID_RESOLVERS, cache, allowPrivateHosts: o.allowLoopback });
      memo.set(xid, { at: Date.now(), doc });
      doc.catch(() => memo.get(xid)?.doc === doc && memo.delete(xid));
      return doc;
    },
  };
}

/** One resolver with every DID driver, one XID resolver, and one PackageSource with the DWN and the https adapters. */
export function readSide(o: ReadSideOptions = {}): { resolver: DidResolver; xidResolver: XidDocumentResolver; source: PackageSource } {
  const loopback = o.allowLoopback ?? false;
  const sidecar = sidecarSource({ home: o.home, mirrors: o.sidecar, allowPrivateHosts: loopback, log: o.log });
  const btcr2 = btcr2Driver({ cas: o.cas, esplora: o.esplora, sidecar: sidecar.get, allowPrivateHosts: loopback });
  const resolver = new DidResolver({
    drivers: [
      keyDriver(), jwkDriver(), webDriver({ allowPrivateHosts: loopback }), webvhDriver({ allowPrivateHosts: loopback }), plcDriver(),
      dhtDriver({ relays: o.relays?.length ? o.relays : undefined, allowPrivateRelays: loopback }),
      {
        ...btcr2,
        async resolve(did, options, ctx) {
          const r = await btcr2.resolve(did, options, ctx);
          sidecar.settle(did, r.didResolutionMetadata.error === undefined);
          return r;
        },
      },
    ],
    staleIfErrorMs: STALE_IF_ERROR_MS,
  });
  const xids = xidResolver(o);
  const source = new PackageSource({
    resolver,
    xidResolver: xids,
    adapters: [dwnAdapter({ allowLoopback: loopback }), httpsAdapter({ allowLoopback: loopback })],
    log: o.log,
  });
  return { resolver, xidResolver: xids, source };
}

export async function startShim(o: StartShimOptions = {}): Promise<{ url: string; stop: () => Promise<void> }> {
  const { resolver, xidResolver: xids, source } = readSide(o);
  let port = 0;
  let handler: ((req: Request) => Promise<Response>) | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      // A DNS rebinding page sends its own host name. Only the loopback names reach the handler.
      const host = req.headers.host ?? '';
      const path = req.url ?? '';
      let r: Response;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) r = Response.json({ error: 'bad host' }, { status: 421 });
      // Only an origin-form target. The shim reads no request body: route() refuses each PUT.
      else if (!path.startsWith('/')) r = Response.json({ error: 'bad request target' }, { status: 400 });
      else r = await handler!(new Request(`http://127.0.0.1:${port}${path}`, { method: req.method }));
      const body = new Uint8Array(await r.arrayBuffer());
      res.writeHead(r.status, { ...Object.fromEntries(r.headers), 'content-length': body.byteLength });
      res.end(body);
    })().catch((e: unknown) => {
      o.log?.(`${req.method} ${req.url} 500 ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? DEFAULT_PORT, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  handler = shimHandler({ origin, resolver, xidResolver: xids, source, trust: new Map(), mode: o.mode, log: o.log });
  return {
    url: origin,
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
