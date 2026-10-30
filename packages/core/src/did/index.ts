// DID resolution: DidResolver, the W3C error shapes, and the drivers that use no library (key, jwk).
// The dht, web and webvh drivers are separate entry points (@didpkg/core/did/dht, @didpkg/core/did/web,
// @didpkg/core/did/webvh), so that a user of this entry point does not load their libraries.
export { DidResolver, DID_TIMEOUT_MS, REPRESENTATIONS } from './resolver.ts';
export type { DidResolverOptions } from './resolver.ts';
export { DID_ERROR_NS, DID_ERROR_CODES, problem, failure, errorCode, fromLibraryResult, fromLibraryError } from './errors.ts';
export type { DidErrorCode } from './errors.ts';
export { fetchBytes, isPrivateHost, FetchError, SOURCE_TIMEOUT_MS, MAX_RESPONSE_BYTES } from './fetch.ts';
export type { FetchLike, FetchLimits, FetchedBytes } from './fetch.ts';
export { keyDriver } from './drivers/key.ts';
export { jwkDriver } from './drivers/jwk.ts';
export type * from './types.ts';
