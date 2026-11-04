// XID document resolution. BCR-2024-010 has no resolution method, so didpkg sets one
// (docs/spec/release-records.md section 6): GET the document from each source in parallel,
// with the network limits of fetch.ts. The valid document with the highest provenance seq wins.
// A cache keeps that document for each XID, and the client refuses a document with a lower seq.
import { fetchBytes, FetchError, SOURCE_TIMEOUT_MS, type FetchLike } from '../did/fetch.ts';
import { XID_RE } from '../name/grammar.ts';
import { checkProvenance, readXidDocument, XidError, type XidDocumentInfo } from './document.ts';

/** The proposed media type of a Gordian Envelope (draft-mcnally-envelope-12 section 8.2). */
export const ENVELOPE_MEDIA_TYPE = 'application/envelope+cbor';
/** No public XID resolver exists yet. */
export const DEFAULT_XID_RESOLVERS: readonly string[] = [];
const MAX_DOCUMENT_BYTES = 64 * 1024;

/** The newest verified XID document that the client saw, for each XID. */
export interface XidCache {
  get(xid: string): Promise<Uint8Array | undefined>;
  put(xid: string, bytes: Uint8Array): Promise<void>;
}

export function memoryXidCache(): XidCache {
  const docs = new Map<string, Uint8Array>();
  return {
    async get(xid) {
      return docs.get(xid);
    },
    async put(xid, bytes) {
      docs.set(xid, bytes);
    },
  };
}

export interface ResolveXidOptions {
  /** Resolver base URLs. The document URL is `<base>/xid/<hex>.envelope`. */
  resolvers?: readonly string[];
  cache?: XidCache;
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Allows http and private addresses. Only for tests and local resolvers. */
  allowPrivateHosts?: boolean;
}

export interface XidResolution extends XidDocumentInfo {
  /** The URL of the document, or "cache" if no source gave a valid document. */
  source: string;
}

type Outcome =
  | { kind: 'ok'; url: string; info: XidDocumentInfo }
  | { kind: 'notFound' | 'invalid' | 'error'; url: string; detail: string };

/** The URL of the XID document at a resolver base URL. */
export function xidDocumentUrl(base: string, xid: string): string {
  return new URL(`xid/${xid}.envelope`, base.endsWith('/') ? base : `${base}/`).href;
}

/**
 * Resolve a XID to its newest verified document. The sources are the http(s) `dereferenceVia`
 * URIs of the cached document, then the resolvers. If no source gives a valid document,
 * the cached document is the result.
 */
export async function resolveXid(xid: string, options: ResolveXidOptions = {}): Promise<XidResolution> {
  if (!XID_RE.test(xid)) throw new XidError('XID_INVALID', 'a XID must be 64 lowercase hex characters');
  const stored = await options.cache?.get(xid);
  const known = stored === undefined ? undefined : readXidDocument(stored, xid);
  const via = (known?.dereferenceVia ?? []).filter((u) => /^https?:\/\//.test(u));
  const urls = [...new Set([...via, ...(options.resolvers ?? DEFAULT_XID_RESOLVERS).map((r) => xidDocumentUrl(r, xid))])];
  const outcomes = await Promise.all(urls.map((url) => fromSource(url, xid, options)));
  const ok = outcomes.flatMap((o) => (o.kind === 'ok' ? [o] : []));
  if (!ok.length) {
    if (known) return { ...known, source: 'cache' };
    const detail = outcomes.map((o) => `${o.url}: ${'detail' in o ? o.detail : 'ok'}`).join('; ') || 'no XID resolver is set';
    if (outcomes.some((o) => o.kind === 'error')) throw new XidError('XID_UNAVAILABLE', `no source gave the XID document: ${detail}`);
    if (outcomes.some((o) => o.kind === 'invalid')) throw new XidError('XID_INVALID', `no source gave a valid XID document: ${detail}`);
    throw new XidError('XID_NOT_FOUND', `no source has the XID document: ${detail}`);
  }
  const best = ok.reduce((a, b) => (b.info.provenance.seq > a.info.provenance.seq ? b : a));
  if (known) checkProvenance(known.provenance, best.info.provenance);
  if (!known || best.info.provenance.seq > known.provenance.seq) await options.cache?.put(xid, best.info.bytes);
  return { ...best.info, source: best.url };
}

async function fromSource(url: string, xid: string, o: ResolveXidOptions): Promise<Outcome> {
  let status: number;
  let body: Uint8Array;
  try {
    ({ status, body } = await fetchBytes(url, {
      fetch: o.fetch,
      signal: o.signal,
      timeoutMs: o.timeoutMs ?? SOURCE_TIMEOUT_MS,
      maxBytes: MAX_DOCUMENT_BYTES,
      allowPrivateHosts: o.allowPrivateHosts,
      noStore: true,
      accept: ENVELOPE_MEDIA_TYPE,
    }));
  } catch (e) {
    const transient = e instanceof FetchError ? e.transient : true;
    return { kind: transient ? 'error' : 'invalid', url, detail: e instanceof Error ? e.message : String(e) };
  }
  if (status === 404) return { kind: 'notFound', url, detail: 'HTTP 404' };
  if (status !== 200) return { kind: 'error', url, detail: `HTTP ${status}` };
  try {
    return { kind: 'ok', url, info: readXidDocument(body, xid) };
  } catch (e) {
    return { kind: 'invalid', url, detail: e instanceof Error ? e.message : String(e) };
  }
}
