// did:web driver. web-did-resolver 3.2.0 builds the URL and parses the document. Its requests go
// through fetch.ts, so the network limits apply. This is the only file that imports it.
// The host is the only authority for the document, so the trust is TOFU.
import { getResolver, webParser } from 'web-did-resolver';
import { failure, fromLibraryResult } from '../errors.ts';
import { fetchBytes, FetchError, SOURCE_TIMEOUT_MS, type FetchLike } from '../fetch.ts';
import type { DidMethodDriver } from '../types.ts';

export interface WebDriverOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  freshMs?: number;
  /** Allows private hosts. Only for tests. */
  allowPrivateHosts?: boolean;
}

export function webDriver(options: WebDriverOptions = {}): DidMethodDriver {
  return {
    method: 'web',
    verification: 'tofu',
    history: false,
    freshMs: options.freshMs ?? 15 * 60_000,
    async resolve(did, _options, ctx) {
      const parsed = { did, didUrl: did, method: 'web', id: did.slice('did:web:'.length) };
      if (!did.startsWith('did:web:') || !webParser(parsed)) return failure('INVALID_DID', 'the did:web host or path is not valid');

      let source = '';
      let transient = false;
      const fetchJson = async (url: string) => {
        source = url;
        try {
          const { status, body } = await fetchBytes(url, {
            fetch: options.fetch,
            signal: ctx.signal,
            timeoutMs: options.timeoutMs ?? SOURCE_TIMEOUT_MS,
            allowPrivateHosts: options.allowPrivateHosts,
          });
          transient = status === 429 || status >= 500;
          return { status, json: async () => JSON.parse(new TextDecoder().decode(body)) as unknown };
        } catch (e) {
          transient = e instanceof FetchError ? e.transient : true;
          throw e;
        }
      };
      const raw = await getResolver({ fetch: fetchJson }).web(did, parsed, null as never, {});
      const result = fromLibraryResult(raw);
      const error = result.didResolutionMetadata.error;
      if (error) {
        // web-did-resolver gives notFound for a document of another DID. W3C: INVALID_DID_DOCUMENT.
        if (error.detail?.includes('id does not match')) return failure('INVALID_DID_DOCUMENT', error.detail, { source });
        result.didResolutionMetadata = { ...result.didResolutionMetadata, source, ...(transient ? { transient: true } : {}) };
        return result;
      }
      result.didResolutionMetadata = { source, verification: 'tofu' };
      return result;
    },
  };
}
