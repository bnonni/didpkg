// The DWN reader (ADR 0003 sections 3 and 6). Plain fetch on the anonymous DRL routes of dwn-server:
// no DWN SDK, no keys. Safe in a browser. The DWN is untrusted storage: core checks every byte.
import { fetchBytes, isPrivateHost } from '@didpkg/core/did';
import { DWN_SERVICE_TYPE } from '@didpkg/core/source';
import type { Endpoint, ReadOptions, StorageAdapter, StorageReader, StoredFile } from '@didpkg/core/source';
import { DIDPKG_PROTOCOL } from './protocol.ts';

/** A query reply holds the package records of one name. */
export const MAX_QUERY_BYTES = 1024 * 1024;
/** A hostile publisher must not make one read send many requests. */
export const MAX_CONTEXTS = 8;
export const CONTEXT_TTL_MS = 5 * 60_000;
export const INDEX_TTL_MS = 5_000;
const MAX_CACHE_ENTRIES = 1000;

export interface DwnAdapterOptions {
  /** Also read http and https on a loopback host (127.0.0.0/8, [::1], localhost). Only for tests and a local demo. */
  allowLoopback?: boolean;
  /** How long the reader keeps the package contextIds of a name. An empty result is not kept. */
  contextTtlMs?: number;
  /** How long the reader keeps the index copies of a name. 0: concurrent reads share one request, and nothing more. */
  indexTtlMs?: number;
}

// The same rule as adapter-https: the WHATWG URL parser writes each IPv4 form as 4 decimal parts.
const isLoopback = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
// DID Core 1.0 section 3.1: no "/", "?" or "#", so the DID is one path segment as it is.
const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const PROTOCOL_PATH = btoa(DIDPKG_PROTOCOL).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** A single-flight cache with a time limit. A failed load, and a value that `keep` refuses, are not kept. */
class TtlCache<T> {
  readonly #entries = new Map<string, { expires: number; value: Promise<T> }>();

  get(key: string, ttlMs: number, load: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
    const hit = this.#entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    // A load in flight has no expiry, so concurrent reads share it.
    const entry = { expires: Infinity, value: load() };
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (this.#entries.size > MAX_CACHE_ENTRIES) this.#entries.delete(this.#entries.keys().next().value!);
    const drop = () => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    };
    entry.value.then((value) => {
      if (keep(value)) entry.expires = Date.now() + ttlMs;
      else drop();
    }, drop);
    return entry.value;
  }
}

interface Shared {
  contextTtlMs: number;
  indexTtlMs: number;
  contexts: TtlCache<string[]>;
  indexes: TtlCache<Uint8Array[]>;
}

/**
 * The reader of `DecentralizedWebNode` endpoints. Only https and no private address. The adapter keeps
 * the contextIds and the index copies of each name, because a DWN allows 20 requests a second per tenant.
 * Use one adapter for each PackageSource.
 */
export function dwnAdapter(options: DwnAdapterOptions = {}): StorageAdapter {
  const shared: Shared = {
    contextTtlMs: options.contextTtlMs ?? CONTEXT_TTL_MS,
    indexTtlMs: options.indexTtlMs ?? INDEX_TTL_MS,
    contexts: new TtlCache(),
    indexes: new TtlCache(),
  };
  const canRead = (endpoint: Endpoint): boolean => {
    if (endpoint.type !== DWN_SERVICE_TYPE || !DID_RE.test(endpoint.did) || !URL.canParse(endpoint.url)) return false;
    const { protocol, hostname } = new URL(endpoint.url);
    if (options.allowLoopback && isLoopback(hostname)) return protocol === 'https:' || protocol === 'http:';
    return protocol === 'https:' && !isPrivateHost(hostname);
  };
  return {
    kind: 'dwn',
    canRead,
    reader(endpoint, deps) {
      if (!canRead(endpoint)) throw new TypeError(`the dwn adapter does not read ${endpoint.url}`);
      return new DwnReader(endpoint, deps.fetch, shared);
    },
  };
}

class DwnReader implements StorageReader {
  readonly #tenant: URL;
  readonly #fetch: typeof fetch;
  readonly #shared: Shared;

  constructor(endpoint: Endpoint, f: typeof fetch, shared: Shared) {
    // The DID goes in the path as it is. dwn-server 0.1.45 does not decode the segment: "did%3Adht%3A..."
    // is another tenant, with no records and no error.
    this.#tenant = new URL(`${endpoint.url.replace(/\/+$/, '')}/${endpoint.did}/`);
    this.#fetch = f;
    this.#shared = shared;
  }

  // A DRL read gives the newest published record that matches. Thus one copy per package contextId
  // (ADR 0003 section 6 item 3). `filter.contextId` is a subtree match, so a nested record needs one request.
  async *read(file: StoredFile, { signal, maxBytes }: ReadOptions): AsyncGenerator<Uint8Array> {
    if (file.kind === 'index') {
      yield* await this.#shared.indexes.get(`${this.#tenant.href}\n${file.name}`, this.#shared.indexTtlMs, async () => {
        const contexts = await this.#contexts(file.name, signal);
        const copies = await Promise.all(contexts.map((c) => this.#read('package/index', { 'filter.contextId': c }, signal, maxBytes)));
        return copies.filter((c) => c !== null);
      });
      return;
    }
    const path = file.kind === 'release' ? 'package/release' : 'package/release/tarball';
    for (const c of await this.#contexts(file.name, signal)) {
      const bytes = await this.#read(path, { 'filter.contextId': c, 'filter.tags.version': file.version }, signal, maxBytes);
      if (bytes) yield bytes;
    }
  }

  /** The contextIds of the `package` records with the tag `name`. The DWN cannot make a name unique. */
  #contexts(name: string, signal: AbortSignal): Promise<string[]> {
    return this.#shared.contexts.get(`${this.#tenant.href}\n${name}`, this.#shared.contextTtlMs, async () => {
      const params = { 'filter.protocol': DIDPKG_PROTOCOL, 'filter.protocolPath': 'package', 'filter.tags.name': name };
      const { status, body } = await this.#get(`query?${qs(params)}`, signal, MAX_QUERY_BYTES);
      if (status !== 200) throw new Error(`${this.#tenant.host}: query HTTP ${status}`);
      let reply: { status?: { code?: unknown }; entries?: unknown };
      try {
        reply = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new Error(`${this.#tenant.host}: the query reply is not JSON`);
      }
      if (reply?.status?.code !== 200 || !Array.isArray(reply.entries)) throw new Error(`${this.#tenant.host}: bad query reply`);
      const ids = reply.entries.map((e) => (e as { contextId?: unknown } | null)?.contextId);
      return [...new Set(ids.filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9]+$/.test(c)))].slice(0, MAX_CONTEXTS);
    }, (ids) => ids.length > 0);
  }

  /** The bytes of one record, or null if absent. Only 404 means absent (ADR 0003 section 5). */
  async #read(path: string, params: Record<string, string>, signal: AbortSignal, maxBytes: number): Promise<Uint8Array | null> {
    const { status, body } = await this.#get(`read/protocols/${PROTOCOL_PATH}/${path}?${qs(params)}`, signal, maxBytes);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`${this.#tenant.host}: HTTP ${status}`);
    return body;
  }

  // PackageSource sets the time limit with the signal, so no own timer. fetchBytes allows a redirect
  // only to the same host and protocol, so a loopback endpoint stays loopback.
  #get(route: string, signal: AbortSignal, maxBytes: number) {
    const url = new URL(route, this.#tenant);
    return fetchBytes(url.href, { fetch: this.#fetch, signal, timeoutMs: Infinity, maxBytes, allowPrivateHosts: isLoopback(url.hostname) });
  }
}
