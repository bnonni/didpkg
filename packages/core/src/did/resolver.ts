// DidResolver: one entry point for all DID methods.
// It does the checks that apply to every method, so that no driver must do them:
// the DID syntax, the options, the didDocument.id check (DID Core 1.0 section 7.1),
// the time limit per DID, a memory cache with single-flight, and stale-if-error.
import { DID_RE } from '../name/grammar.ts';
import { errorCode, failure, fromLibraryError, problem } from './errors.ts';
import type { DidMethodDriver, DidResolutionOptions, DidResolutionResult } from './types.ts';

export const DID_TIMEOUT_MS = 10_000;
export const REPRESENTATIONS: readonly string[] = ['application/did', 'application/did+json', 'application/did+ld+json'];
// DID Core 1.0 section 7.1.2: versionTime is an XML datetime in UTC, with no fraction of a second.
const VERSION_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface DidResolverOptions {
  drivers: DidMethodDriver[];
  /** The time limit per DID, in milliseconds. Default: 10 s. */
  timeoutMs?: number;
  /**
   * How long after the fresh time a cached result can replace a transient failure, in milliseconds.
   * Default: 0 (for publish). Install uses 7 days.
   */
  staleIfErrorMs?: number;
  /** The clock, for tests. */
  now?: () => number;
}

interface CacheEntry {
  result: DidResolutionResult;
  freshUntil: number;
  staleUntil: number;
}

export class DidResolver {
  readonly #drivers = new Map<string, DidMethodDriver>();
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<DidResolutionResult>>();
  readonly #timeoutMs: number;
  readonly #staleIfErrorMs: number;
  readonly #now: () => number;

  constructor(options: DidResolverOptions) {
    for (const d of options.drivers) {
      if (this.#drivers.has(d.method)) throw new Error(`two drivers for did:${d.method}`);
      this.#drivers.set(d.method, d);
    }
    this.#timeoutMs = options.timeoutMs ?? DID_TIMEOUT_MS;
    this.#staleIfErrorMs = options.staleIfErrorMs ?? 0;
    this.#now = options.now ?? Date.now;
  }

  get methods(): string[] {
    return [...this.#drivers.keys()];
  }

  clearCache(): void {
    this.#cache.clear();
  }

  /** Returns a W3C DID Resolution v1 result. It does not throw. Each call gets its own copy. */
  async resolve(did: string, options: DidResolutionOptions = {}): Promise<DidResolutionResult> {
    const m = typeof did === 'string' ? DID_RE.exec(did) : null;
    if (!m) return failure('INVALID_DID', `not a DID: ${JSON.stringify(did)}`);
    const driver = this.#drivers.get(m[1]);
    if (!driver) return failure('METHOD_NOT_SUPPORTED', `did:${m[1]} is not supported`);
    const invalid = checkOptions(driver, options);
    if (invalid) return invalid;

    const key = `${did}\n${options.versionId ?? ''}\n${options.versionTime ?? ''}`;
    const hit = this.#cache.get(key);
    if (hit && !options.noCache && this.#now() < hit.freshUntil) return output(hit.result, options);
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.#resolveFresh(driver, did, options, key).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return output(await pending, options);
  }

  async #resolveFresh(driver: DidMethodDriver, did: string, options: DidResolutionOptions, key: string): Promise<DidResolutionResult> {
    const result = checkResult(did, await this.#callDriver(driver, did, options));
    const now = this.#now();
    if (!result.didResolutionMetadata.error) {
      result.didResolutionMetadata.retrieved = isoSeconds(now);
      result.didResolutionMetadata.verification ??= driver.verification;
      const freshUntil = now + driver.freshMs;
      this.#cache.set(key, { result, freshUntil, staleUntil: freshUntil + this.#staleIfErrorMs });
      return result;
    }
    // A definite failure (for example NOT_FOUND) replaces the cache entry. Only a transient failure
    // can use a stale entry. A deactivation is a success result, so a stale entry never hides it.
    const hit = this.#cache.get(key);
    if (!result.didResolutionMetadata.transient) this.#cache.delete(key);
    else if (hit && now < hit.staleUntil) {
      return { ...hit.result, didResolutionMetadata: { ...hit.result.didResolutionMetadata, stale: true } };
    }
    return result;
  }

  async #callDriver(driver: DidMethodDriver, did: string, options: DidResolutionOptions): Promise<DidResolutionResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<DidResolutionResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(failure('INTERNAL_ERROR', `did:${driver.method}: no result in ${this.#timeoutMs} ms`, { transient: true }));
      }, this.#timeoutMs);
    });
    const call = (async () => driver.resolve(did, { ...options }, { signal: controller.signal }))().catch(fromLibraryError);
    try {
      return await Promise.race([call, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function checkOptions(driver: DidMethodDriver, o: DidResolutionOptions): DidResolutionResult | undefined {
  if (o.versionId !== undefined && o.versionTime !== undefined) {
    return failure('INVALID_OPTIONS', 'versionId and versionTime are mutually exclusive');
  }
  if (o.versionId !== undefined && (typeof o.versionId !== 'string' || !o.versionId)) {
    return failure('INVALID_OPTIONS', 'versionId must be a non-empty string');
  }
  if (o.versionTime !== undefined && (typeof o.versionTime !== 'string' || !VERSION_TIME_RE.test(o.versionTime) || Number.isNaN(Date.parse(o.versionTime)))) {
    return failure('INVALID_OPTIONS', 'versionTime must be a UTC datetime like 2026-10-27T00:00:00Z');
  }
  if ((o.versionId !== undefined || o.versionTime !== undefined) && !driver.history) {
    return failure('FEATURE_NOT_SUPPORTED', `did:${driver.method} has no version history`);
  }
  if (o.accept !== undefined && !REPRESENTATIONS.includes(mediaType(o.accept))) {
    return failure('REPRESENTATION_NOT_SUPPORTED', `accept ${JSON.stringify(o.accept)} is not supported`);
  }
  return undefined;
}

/** Applies the rules that apply to every driver result. */
function checkResult(did: string, r: DidResolutionResult): DidResolutionResult {
  if (!r || typeof r !== 'object' || !r.didResolutionMetadata || !r.didDocumentMetadata) {
    return failure('INTERNAL_ERROR', 'the driver returned no resolution result');
  }
  const error = r.didResolutionMetadata.error;
  if (error) {
    return { didResolutionMetadata: { ...r.didResolutionMetadata, error: problem(errorCode(r)!, error.detail) }, didDocument: null, didDocumentMetadata: {} };
  }
  if (r.didDocumentMetadata.deactivated === true) {
    return { didResolutionMetadata: r.didResolutionMetadata, didDocument: null, didDocumentMetadata: r.didDocumentMetadata };
  }
  const doc = r.didDocument;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return failure('INVALID_DID_DOCUMENT', 'the driver returned no DID document');
  if (doc.id !== did) return failure('INVALID_DID_DOCUMENT', `didDocument.id is ${JSON.stringify(doc.id)}, not the requested DID`);
  return r;
}

function output(result: DidResolutionResult, options: DidResolutionOptions): DidResolutionResult {
  const r = structuredClone(result);
  if (r.didResolutionMetadata.error) return r;
  const type = options.accept === undefined ? 'application/did' : mediaType(options.accept);
  if (type === 'application/did+ld+json' && r.didDocument && r.didDocument['@context'] === undefined) {
    return failure('REPRESENTATION_NOT_SUPPORTED', 'the DID document has no @context, so it has no JSON-LD form');
  }
  r.didResolutionMetadata.contentType = type;
  return r;
}

const mediaType = (accept: string) => String(accept).split(';')[0].trim().toLowerCase();
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
