// XID documents (BCR-2024-010): read, verify and resolve.
export { checkProvenance, grants, keysWith, readXidDocument, xidFromUr, XidError } from './document.ts';
export type { XidDocumentInfo, XidErrorCode, XidKeyInfo, XidPrivilege, XidProvenanceInfo, XidServiceInfo } from './document.ts';
export { DEFAULT_XID_RESOLVERS, ENVELOPE_MEDIA_TYPE, memoryXidCache, resolveXid, xidDocumentUrl } from './resolve.ts';
export type { ResolveXidOptions, XidCache, XidResolution } from './resolve.ts';
