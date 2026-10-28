// @didpkg/adapter-https: reads the static layout v1 from a DIDPackageRepository endpoint (ADR 0003
// sections 3 and 7). Only https and no private address, with the limits of did/fetch.ts. Safe in a browser.
import { fetchBytes, isPrivateHost } from '@didpkg/core/did';
import { REPOSITORY_SERVICE_TYPE } from '@didpkg/core/source';
import type { Endpoint, ReadOptions, StorageAdapter, StorageReader, StoredFile } from '@didpkg/core/source';
import { layoutPath } from './layout.ts';

export { layoutPath } from './layout.ts';

export interface HttpsAdapterOptions {
  /** Also read http and https on a loopback host (127.0.0.0/8, [::1], localhost). Only for tests and a local demo. */
  allowLoopback?: boolean;
}

// The WHATWG URL parser writes each IPv4 form as 4 decimal parts and keeps the brackets of IPv6.
const isLoopback = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);

export function httpsAdapter(options: HttpsAdapterOptions = {}): StorageAdapter {
  const canRead = (endpoint: Endpoint): boolean => {
    if (endpoint.type !== REPOSITORY_SERVICE_TYPE || !URL.canParse(endpoint.url)) return false;
    const { protocol, hostname } = new URL(endpoint.url);
    if (options.allowLoopback && isLoopback(hostname)) return protocol === 'https:' || protocol === 'http:';
    return protocol === 'https:' && !isPrivateHost(hostname);
  };
  return {
    kind: 'https',
    canRead,
    reader(endpoint, deps) {
      if (!canRead(endpoint)) throw new TypeError(`the https adapter does not read ${endpoint.url}`);
      return new HttpsReader(new URL(endpoint.url), deps.fetch);
    },
  };
}

class HttpsReader implements StorageReader {
  readonly #base: URL;
  readonly #fetch: typeof fetch;

  constructor(base: URL, f: typeof fetch) {
    this.#base = base;
    this.#fetch = f;
  }

  // A static mirror has 0 or 1 copies. Only 404 and 410 mean "absent". Each other status is a failed
  // endpoint, so a broken mirror cannot make a published file look absent (ADR 0003 section 5).
  async *read(file: StoredFile, { signal, maxBytes }: ReadOptions): AsyncGenerator<Uint8Array> {
    // encodeURIComponent changes only "+" (SemVer build metadata) to "%2B". Some hosts read a literal "+" as a space.
    const url = new URL(layoutPath(file).map(encodeURIComponent).join('/'), this.#base);
    // fetchBytes allows a redirect only to the same host and protocol, so a loopback endpoint stays loopback.
    // PackageSource sets the time limit with the signal (ADR 0003 section 5), so no own timer.
    const { status, body } = await fetchBytes(url.href, {
      fetch: this.#fetch, signal, timeoutMs: Infinity, maxBytes, allowPrivateHosts: isLoopback(url.hostname),
    });
    if (status === 404 || status === 410) return;
    if (status !== 200) throw new Error(`${url.host}: HTTP ${status}`);
    yield body;
  }
}
