// PackageSource: the core reader over every storage endpoint of a publisher (ADR 0003). It gives
// the trust verifier untrusted values. It selects a release and a tarball only by the digests in
// signed objects, so a hostile endpoint can delay an install, but it cannot change the bytes.
import type { DidResolver } from '../did/resolver.ts';
import { PKG_NAME_RE } from '../name/grammar.ts';
import { contentDigest, sri } from '../trust/digest.ts';
import { SEMVER } from '../trust/release.ts';
import type { ReleaseReader } from '../trust/verify.ts';
import { storageEndpoints } from './endpoints.ts';
import type { Endpoint, StorageAdapter, StorageReader, StoredFile } from './types.ts';

/** The DWN protocol `$size` limits (ADR 0003). */
export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
export const JSON_TIMEOUT_MS = 5_000;
export const TARBALL_TIMEOUT_MS = 30_000;

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
const label = (f: StoredFile) => (f.kind === 'index' ? `the index of ${f.name}` : `the ${f.kind} ${f.name}@${f.version}`);

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

export class PackageSource implements ReleaseReader {
  readonly #o: PackageSourceOptions;

  constructor(options: PackageSourceOptions) {
    this.#o = options;
  }

  /** The endpoints that an adapter can read, the DWN endpoints first. */
  async endpoints(did: string): Promise<Endpoint[]> {
    return (await this.#bound(did)).map((b) => b.endpoint);
  }

  /** Every index copy from every endpoint, in parallel. The verifier selects the highest valid sequence. */
  async getIndexes(did: string, name: string): Promise<unknown[]> {
    check(name);
    const file: StoredFile = { kind: 'index', name };
    const results = await Promise.all((await this.#bound(did)).map(async (b) => {
      const values: unknown[] = [];
      let failed = false;
      try {
        for await (const bytes of this.#read(b, file, MAX_JSON_BYTES, this.#o.jsonTimeoutMs ?? JSON_TIMEOUT_MS)) {
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

  /** The first release copy, in endpoint order, whose contentDigest is the digest in the signed index. */
  async getRelease(did: string, name: string, version: string, digest: string): Promise<unknown> {
    check(name, version);
    return this.#first(did, { kind: 'release', name, version }, MAX_JSON_BYTES, this.#o.jsonTimeoutMs ?? JSON_TIMEOUT_MS, async (bytes) => {
      const value = parseJson(bytes)?.value;
      return isObject(value) && contentDigest(value) === digest ? value : undefined;
    });
  }

  /** The first tarball copy, in endpoint order, with the size and the sha512 in the signed release. */
  async getTarball(did: string, name: string, version: string, dist: { integrity: string; size: number }): Promise<Uint8Array | null> {
    check(name, version);
    return this.#first(did, { kind: 'tarball', name, version }, MAX_TARBALL_BYTES, this.#o.tarballTimeoutMs ?? TARBALL_TIMEOUT_MS, async (bytes) =>
      bytes.length === dist.size && (await sri('sha512', bytes)) === dist.integrity ? bytes : undefined);
  }

  async #first<T>(did: string, file: StoredFile, maxBytes: number, timeoutMs: number, match: (bytes: Uint8Array) => Promise<T | undefined>): Promise<T | null> {
    let failed = false;
    let mismatch = false;
    for (const b of await this.#bound(did)) {
      try {
        for await (const bytes of this.#read(b, file, maxBytes, timeoutMs)) {
          const value = await match(bytes);
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

  // The size check here does not trust the adapter to stop at maxBytes.
  async *#read(b: Bound, file: StoredFile, maxBytes: number, timeoutMs: number): AsyncGenerator<Uint8Array> {
    for await (const bytes of b.reader.read(file, { signal: AbortSignal.timeout(timeoutMs), maxBytes })) {
      if (bytes.length > maxBytes) throw new Error(`a copy is larger than ${maxBytes} bytes`);
      yield bytes;
    }
  }

  // The verifier resolves the DID first and reports each DID error. Here, no document means no endpoint.
  async #bound(did: string): Promise<Bound[]> {
    const { didDocument: doc } = await this.#o.resolver.resolve(did);
    if (!doc || doc.id !== did) return [];
    const out: Bound[] = [];
    for (const endpoint of storageEndpoints(doc)) {
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
