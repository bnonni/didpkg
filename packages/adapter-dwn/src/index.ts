// @didpkg/adapter-dwn: the publisher DWN storage adapter.
// This entry point does not load the DWN SDK. The writer is in `@didpkg/adapter-dwn/writer`.
export { DIDPKG_PROTOCOL, DIDPKG_PROTOCOL_V2, ENVELOPE_DATA_FORMAT, definitionOf, protocolDefinition, protocolDefinitionV2, protocolOf } from './protocol.ts';
export { dwnAdapter, MAX_QUERY_BYTES, MAX_CONTEXTS, CONTEXT_TTL_MS, INDEX_TTL_MS, REQUESTS_PER_SECOND, REQUEST_BURST } from './reader.ts';
export type { DwnAdapterOptions } from './reader.ts';
