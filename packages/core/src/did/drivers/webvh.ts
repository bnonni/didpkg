// did:webvh driver. didwebvh-ts 3.0.0 checks the DID log: the SCID, the hash chain of the entries
// and the update key proof on each entry. This is the only file that imports it.
// Its requests go through fetch.ts, so the network limits apply.
import { resolveDID } from 'didwebvh-ts';
import { failure } from '../errors.ts';
import { fetchBytes, FetchError, SOURCE_TIMEOUT_MS, type FetchLike } from '../fetch.ts';
import type { DidDocument, DidDocumentMetadata, DidMethodDriver } from '../types.ts';

export interface WebvhDriverOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  freshMs?: number;
  /** Allows private hosts. Only for tests. */
  allowPrivateHosts?: boolean;
}

export function webvhDriver(options: WebvhDriverOptions = {}): DidMethodDriver {
  return {
    method: 'webvh',
    verification: 'cryptographic',
    history: true,
    freshMs: options.freshMs ?? 15 * 60_000,
    async resolve(did, { versionId, versionTime }, ctx) {
      const urls: string[] = [];
      let transient = false;
      const fetch = async (url: string) => {
        urls.push(url);
        try {
          const { status, body } = await fetchBytes(url, {
            fetch: options.fetch,
            signal: ctx.signal,
            timeoutMs: options.timeoutMs ?? SOURCE_TIMEOUT_MS,
            allowPrivateHosts: options.allowPrivateHosts,
          });
          if (status === 429 || status >= 500) transient = true;
          const ok = status >= 200 && status < 300;
          return new Response(ok ? body : null, { status: ok ? 200 : status });
        } catch (e) {
          transient = e instanceof FetchError ? e.transient : true;
          throw e;
        }
      };
      const raw = await resolveDID(did, {
        fetch,
        ...(versionId !== undefined && { versionId }),
        ...(versionTime !== undefined && { versionTime: new Date(versionTime) }),
      });
      const source = urls[0];
      const meta = raw.didResolutionMetadata as { error?: string; message?: string };
      if (meta.error) {
        const detail = meta.message;
        if (transient) return failure('INTERNAL_ERROR', detail, { source, transient: true });
        if (meta.error === 'notFound') return failure('NOT_FOUND', detail, { source });
        if (meta.error === 'invalidOptions') return failure('INVALID_OPTIONS', detail);
        if (meta.error === 'internalError') return failure('INTERNAL_ERROR', detail, { source });
        // The library gives invalidDid for a syntax error and for a log that fails a check.
        // The log URL comes from the DID, so no request means a syntax error.
        if (!source) return failure('INVALID_DID', detail);
        // A log with a bad entry after good entries also fails. The driver gives no older document.
        return failure('INVALID_DID_DOCUMENT', detail, { source });
      }
      // JSON round trip: the result keeps only JSON values, with no undefined member.
      const didDocumentMetadata = JSON.parse(JSON.stringify(raw.didDocumentMetadata)) as DidDocumentMetadata;
      if (!raw.didDocument && didDocumentMetadata.deactivated !== true) return failure('INVALID_DID_DOCUMENT', 'the log gives no document', { source });
      return {
        didResolutionMetadata: { source, verification: 'cryptographic' },
        didDocument: raw.didDocument ? (JSON.parse(JSON.stringify(raw.didDocument)) as DidDocument) : null,
        didDocumentMetadata,
      };
    },
  };
}
