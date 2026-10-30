// `didpkg shim start`: the shim on 127.0.0.1 only. One resolver, one DWN adapter and one PackageSource
// for the shim lifetime, so their caches and the DWN rate limit hold across requests.
// The server is node:http, so the same code runs on Bun and on Node (the npm package).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DidResolver, jwkDriver, keyDriver } from '@didpkg/core/did';
import { dhtDriver } from '@didpkg/core/did/dht';
import { webDriver } from '@didpkg/core/did/web';
import { webvhDriver } from '@didpkg/core/did/webvh';
import { PackageSource } from '@didpkg/core/source';
import type { PolicyMode } from '@didpkg/core/trust';
import { dwnAdapter } from '@didpkg/adapter-dwn';
import { httpsAdapter } from '@didpkg/adapter-https';
import { shimHandler } from './shim.ts';

export const DEFAULT_PORT = 2092;
/** Install uses a cached DID document for 7 days if the method fails. */
export const STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1000;

export interface StartShimOptions {
  /** 0 selects a free port. Default: 2092. */
  port?: number;
  relays?: readonly string[];
  mode?: PolicyMode;
  /** Read DWN and repository endpoints, DID documents and relays on a loopback host. Only for tests and a local demo. */
  allowLoopback?: boolean;
  log?: (line: string) => void;
}

export async function startShim(o: StartShimOptions = {}): Promise<{ url: string; stop: () => Promise<void> }> {
  const loopback = o.allowLoopback ?? false;
  const resolver = new DidResolver({
    drivers: [
      keyDriver(), jwkDriver(), webDriver({ allowPrivateHosts: loopback }), webvhDriver({ allowPrivateHosts: loopback }),
      dhtDriver({ relays: o.relays?.length ? o.relays : undefined, allowPrivateRelays: loopback }),
    ],
    staleIfErrorMs: STALE_IF_ERROR_MS,
  });
  const source = new PackageSource({
    resolver,
    adapters: [dwnAdapter({ allowLoopback: loopback }), httpsAdapter({ allowLoopback: loopback })],
    log: o.log,
  });
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
  handler = shimHandler({ origin, resolver, source, trust: new Map(), mode: o.mode, log: o.log });
  return {
    url: origin,
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
