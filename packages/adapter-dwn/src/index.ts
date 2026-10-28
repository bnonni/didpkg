// @didpkg/adapter-dwn: the publisher DWN storage adapter.
// This entry point does not load the DWN SDK. The writer is in `@didpkg/adapter-dwn/writer`.
export { DIDPKG_PROTOCOL, protocolDefinition } from './protocol.ts';
export { dwnAdapter, MAX_QUERY_BYTES, MAX_CONTEXTS, CONTEXT_TTL_MS, INDEX_TTL_MS } from './reader.ts';
export type { DwnAdapterOptions } from './reader.ts';
