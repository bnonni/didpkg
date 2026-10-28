// @didpkg/core/source: the storage contract, PackageSource (ADR 0003) and the npm packument.
export { DWN_SERVICE_TYPE, REPOSITORY_SERVICE_TYPE, MAX_ENDPOINTS, storageEndpoints } from './endpoints.ts';
export {
  PackageSource, SourceError, MAX_JSON_BYTES, MAX_TARBALL_BYTES, JSON_TIMEOUT_MS, TARBALL_TIMEOUT_MS,
} from './source.ts';
export type { PackageSourceOptions, SourceErrorCode } from './source.ts';
export { buildPackument } from './packument.ts';
export type { Packument, PackumentVersion, PackumentOptions, TarballUrlInput } from './packument.ts';
export type {
  Endpoint, EndpointType, StoredFile, ReadOptions, StorageReader, StorageAdapter, PublishInput, StorageWriter,
} from './types.ts';
