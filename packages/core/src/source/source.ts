// PackageSource: the core reader over every storage endpoint of a publisher (ADR 0003). It gives
// the trust verifier untrusted values. It selects a release and a tarball only by the digests in
// signed objects, so a hostile endpoint can delay an install, but it cannot change the bytes.
import type { DidResolver } from '../did/resolver.ts';
import { PKG_NAME_RE, XID_RE } from '../name/grammar.ts';
import { contentDigest, sri } from '../trust/digest.ts';
import { SEMVER } from '../trust/release.ts';
import type { ReleaseReader } from '../trust/verify.ts';
import { parseXidRelease, xidContentDigest, type XidDocumentResolver } from '../xid/release.ts';
import { hintEndpoints, storageEndpoints, xidEndpoints } from './endpoints.ts';
import type { Endpoint, RecordFormat, StorageAdapter, StorageReader, StoredFile } from './types.ts';

/** The signed tarball bytes, the endpoint that gave them, and their URL if the adapter gives URLs. */
export interface FoundTarball {
  bytes: Uint8Array;
  endpoint: Endpoint;
  url?: string;
}

/** The DWN protocol `$size` limits (ADR 0003). */
export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
export const JSON_TIMEOUT_MS = 5_000;
export const TARBALL_TIMEOUT_MS = 30_000;
/** A release is content-addressed, so a kept copy with the signed digest is never stale. */
export const RELEASE_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * No endpoint gave usable bytes. UNAVAILABLE: each endpoint failed or sent bad JSON.
 * MISMATCH: copies arrived, but no copy has the signed digest. The shim answers 502 for both.
 */
export type SourceErrorCode = 'UNAVAILABLE' | 'MISMATCH';

export class SourceError extends Error {
  constructor(readonly code: SourceErrorCode, message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

export interface PackageSourceOptions {
  /** The same resolver as the verifier. Its cache makes the second resolution free. */
  resolver: Pick<DidResolver, 'resolve'>;
  /** The XID resolver of the verifier. With no XID resolver, a XID publisher has no endpoint. */
  xidResolver?: XidDocumentResolver;
  /**
   * The DWN URLs of the consumer. Only a did:key or did:jwk publisher uses them, because its document cannot
   * have a service. The list is not a trust input: the signatures are the trust. Default: none.
   */
  dwnHints?: readonly string[];
  adapters: readonly StorageAdapter[];
  fetch?: typeof fetch;
  jsonTimeoutMs?: number;
  tarballTimeoutMs?: number;
  /** Gets one line for each skipped endpoint or copy. */
  log?: (line: string) => void;
}

interface Bound {
  endpoint: Endpoint;
  reader: StorageReader;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const utf8 = new TextDecoder('utf-8', { fatal: true });
// A XID publisher signs Gordian Envelopes. The source gives their bytes, and the verifier parses them.
const isXid = (publisher: string) => XID_RE.test(publisher);
// The DID methods with no services in the document. A publisher of these methods uses the DWN list of the consumer.
const NO_SERVICES = /^did:(?:key|jwk):/;
const recordFile = <F extends StoredFile>(publisher: string, file: F): F & { format?: RecordFormat } => (isXid(publisher) ? { ...file, format: 'envelope' } : file);
const label = (f: StoredFile) => (f.kind === 'index' ? `the index of ${f.name}` : `the ${f.kind} ${f.name}@${f.version}`);

function xidDigest(bytes: Uint8Array): string | undefined {
  try {
    return xidContentDigest(parseXidRelease(bytes));
  } catch {
    return undefined;
  }
}

function parseJson(bytes: Uint8Array): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(utf8.decode(bytes)) };
  } catch {
    return undefined;
  }
}

// The shim parses the install name first, so a bad value here is a caller bug. The check also
// keeps "../" and "/" out of the adapter paths.
function check(name: string, version?: string) {
  if (!PKG_NAME_RE.test(name)) throw new TypeError(`bad package name: ${name}`);
  if (version !== undefined && !SEMVER.test(version)) throw new TypeError(`bad version: ${version}`);
}

async function* bytesOnly(copies: AsyncIterable<Uint8Array>): AsyncGenerator<{ bytes: Uint8Array; url?: string }> {
  for await (const bytes of copies) yield { bytes };
}

export class PackageSource implements ReleaseReader {
  readonly #o: PackageSourceOptions;
  /** The release bytes per did, name, version and signed digest, the oldest first. */
  readonly #releases = new Map<string, Uint8Array>();
  #releaseBytes = 0;

  constructor(options: PackageSourceOptions) {
    this.#o = options;
  }

  /** The endpoints that an adapter can read, the DWN endpoints first. */
  async endpoints(did: string): Promise<Endpoint[]> {
    return (await this.#bound(did)).map((b) => b.endpoint);
  }

  /**
   * Every index copy from every endpoint, in parallel. The verifier selects the highest valid sequence.
   * A DID publisher gives JSON values. A XID publisher gives envelope bytes.
   */
  async getIndexes(did: string, name: string): Promise<unknown[]> {
    check(name);
    const file = recordFile(did, { kind: 'index', name });
    const results = await Promise.all((await this.#bound(did)).map(async (b) => {
      const values: unknown[] = [];
      let failed = false;
      try {
        for await (const { bytes } of this.#read(b, file, MAX_JSON_BYTES, this.#o.jsonTimeoutMs ?? JSON_TIMEOUT_MS)) {
          if (file.format === 'envelope') {
            values.push(bytes.slice());
            continue;
          }
          const json = parseJson(bytes);
          if (json) {
            values.push(json.value);
          } else {
            failed = true;
            this.#log(b, file, 'the copy is not JSON');
          }
        }
      } catch (e) {
        failed = true;
        this.#log(b, file, (e as Error).message);
      }
      return { values, failed };
    }));
    const values = results.flatMap((r) => r.values);
    if (values.length === 0 && results.some((r) => r.failed)) {
      throw new SourceError('UNAVAILABLE', `no endpoint gave ${label(file)}`);
    }
    return values;
  }

  /**
   * The first release copy, in endpoint order, whose contentDigest is the digest in the signed index.
   * A packument reads each listed release, so the source keeps them (ADR 0003 section 5 item 4).
   */
  async getRelease(did: string, name: string, version: string, digest: string): Promise<unknown> {
    check(name, version);
    const key = `${did}\n${name}@${version}\n${digest}`;
    const file = recordFile(did, { kind: 'release', name, version });
    const kept = this.#releases.get(key);
    if (kept) return file.format === 'envelope' ? kept.slice() : parseJson(kept)!.value;
    return this.#first(did, file, MAX_JSON_BYTES, this.#o.jsonTimeoutMs ?? JSON_TIMEOUT_MS, async (bytes) => {
      if (file.format === 'envelope') {
        if (xidDigest(bytes) !== digest) return undefined;
        this.#keep(key, bytes);
        return bytes.slice();
      }
      const value = parseJson(bytes)?.value;
      if (!isObject(value) || contentDigest(value) !== digest) return undefined;
      this.#keep(key, bytes);
      return value;
    });
  }

  // A copy, so a later change to the buffer of the adapter cannot change a kept release.
  #keep(key: string, bytes: Uint8Array) {
    if (this.#releases.has(key)) return;
    this.#releases.set(key, bytes.slice());
    this.#releaseBytes += bytes.length;
    for (const [k, b] of this.#releases) {
      if (this.#releaseBytes <= RELEASE_CACHE_BYTES) break;
      this.#releases.delete(k);
      this.#releaseBytes -= b.length;
    }
  }

  /** The first tarball copy, in endpoint order, with the size and the sha512 in the signed release. */
  async getTarball(did: string, name: string, version: string, dist: { integrity: string; size: number }): Promise<Uint8Array | null> {
    return (await this.findTarball(did, name, version, dist))?.bytes ?? null;
  }

  /** As getTarball, and also the endpoint and the URL of the copy (`didpkg drl`). */
  async findTarball(did: string, name: string, version: string, dist: { integrity: string; size: number }): Promise<FoundTarball | null> {
    check(name, version);
    return this.#first(did, recordFile(did, { kind: 'tarball', name, version }), MAX_TARBALL_BYTES, this.#o.tarballTimeoutMs ?? TARBALL_TIMEOUT_MS, async (bytes, b, url) =>
      bytes.length === dist.size && (await sri('sha512', bytes)) === dist.integrity ? { bytes, endpoint: b.endpoint, url } : undefined);
  }

  async #first<T>(
    did: string, file: StoredFile, maxBytes: number, timeoutMs: number, match: (bytes: Uint8Array, b: Bound, url?: string) => Promise<T | undefined>,
  ): Promise<T | null> {
    let failed = false;
    let mismatch = false;
    for (const b of await this.#bound(did)) {
      try {
        for await (const { bytes, url } of this.#read(b, file, maxBytes, timeoutMs)) {
          const value = await match(bytes, b, url);
          if (value !== undefined) return value;
          mismatch = true;
          this.#log(b, file, 'the copy is not the signed copy, try the next copy');
        }
      } catch (e) {
        failed = true;
        this.#log(b, file, (e as Error).message);
      }
    }
    if (mismatch) throw new SourceError('MISMATCH', `no copy of ${label(file)} has the signed digest`);
    if (failed) throw new SourceError('UNAVAILABLE', `no endpoint gave ${label(file)}`);
    return null;
  }

  // The size check here does not trust the adapter to stop at maxBytes. An adapter with no `copies` gives no URL.
  async *#read(b: Bound, file: StoredFile, maxBytes: number, timeoutMs: number): AsyncGenerator<{ bytes: Uint8Array; url?: string }> {
    const options = { signal: AbortSignal.timeout(timeoutMs), maxBytes };
    const copies = b.reader.copies ? b.reader.copies(file, options) : bytesOnly(b.reader.read(file, options));
    for await (const copy of copies) {
      if (copy.bytes.length > maxBytes) throw new Error(`a copy is larger than ${maxBytes} bytes`);
      yield copy;
    }
  }

  // The verifier resolves the DID or the XID first and reports each error. Here, no document means no endpoint.
  async #bound(did: string): Promise<Bound[]> {
    if (isXid(did)) {
      const doc = await this.#o.xidResolver?.resolve(did).catch(() => undefined);
      return doc?.xid === did ? this.#bind(xidEndpoints(doc)) : [];
    }
    const { didDocument: doc } = await this.#o.resolver.resolve(did);
    if (!doc || doc.id !== did) return [];
    const found = storageEndpoints(doc);
    return this.#bind(found.length === 0 && NO_SERVICES.test(did) ? hintEndpoints(did, this.#o.dwnHints ?? []) : found);
  }

  #bind(endpoints: Endpoint[]): Bound[] {
    const out: Bound[] = [];
    for (const endpoint of endpoints) {
      const adapter = this.#o.adapters.find((a) => a.canRead(endpoint));
      if (adapter) out.push({ endpoint, reader: adapter.reader(endpoint, { fetch: this.#o.fetch ?? globalThis.fetch }) });
      else this.#o.log?.(`skip ${endpoint.url}: no adapter reads it`);
    }
    return out;
  }

  #log(b: Bound, file: StoredFile, message: string) {
    this.#o.log?.(`${label(file)} from ${b.endpoint.url}: ${message}`);
  }
}
