// `didpkg shim start`: the shim on 127.0.0.1 only. One resolver, one DWN adapter and one PackageSource
// for the shim lifetime, so their caches and the DWN rate limit hold across requests.
import { DidResolver, jwkDriver, keyDriver } from '@didpkg/core/did';
import { dhtDriver } from '@didpkg/core/did/dht';
import { webDriver } from '@didpkg/core/did/web';
import { PackageSource } from '@didpkg/core/source';
import type { PolicyMode } from '@didpkg/core/trust';
import { dwnAdapter } from '@didpkg/adapter-dwn';
import { httpsAdapter } from '@didpkg/adapter-https';
import { shimHandler } from './shim.ts';

export const DEFAULT_PORT = 2092;
/** Install uses a cached DID document for 7 days if the method fails (PLAN.md "DID resolution" item 3). */
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

export function startShim(o: StartShimOptions = {}) {
  const loopback = o.allowLoopback ?? false;
  const resolver = new DidResolver({
    drivers: [
      keyDriver(), jwkDriver(), webDriver({ allowPrivateHosts: loopback }),
      dhtDriver({ relays: o.relays?.length ? o.relays : undefined, allowPrivateRelays: loopback }),
    ],
    staleIfErrorMs: STALE_IF_ERROR_MS,
  });
  const source = new PackageSource({
    resolver,
    adapters: [dwnAdapter({ allowLoopback: loopback }), httpsAdapter({ allowLoopback: loopback })],
    log: o.log,
  });
  let handler: ((req: Request) => Promise<Response>) | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: o.port ?? DEFAULT_PORT,
    fetch: (req) => {
      // A DNS rebinding page sends its own host name. Only the loopback names reach the handler.
      const host = req.headers.get('host') ?? '';
      if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return Response.json({ error: 'bad host' }, { status: 421 });
      return handler!(req);
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  handler = shimHandler({ origin, resolver, source, trust: new Map(), mode: o.mode, log: o.log });
  return { url: origin, stop: () => server.stop(true) };
}
