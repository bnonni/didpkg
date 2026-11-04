// Endpoint selection (ADR 0003 section 4). Readers select services by type, not by id.
import type { DidDocument } from '../did/types.ts';
import type { XidDocumentInfo } from '../xid/document.ts';
import type { Endpoint, EndpointType } from './types.ts';

export const DWN_SERVICE_TYPE = 'DecentralizedWebNode';
export const REPOSITORY_SERVICE_TYPE = 'DIDPackageRepository';
/** A hostile DID document must not make one install send many requests. */
export const MAX_ENDPOINTS = 8;

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');

/**
 * The storage endpoints of a DID document: each DecentralizedWebNode endpoint first, then each
 * DIDPackageRepository endpoint, in document order. The type match is exact (DID Core 1.0 section 5.4:
 * a string or a set of strings). A map endpoint is not used in v1.
 */
export function storageEndpoints(doc: DidDocument): Endpoint[] {
  const out: Endpoint[] = [];
  for (const type of [DWN_SERVICE_TYPE, REPOSITORY_SERVICE_TYPE] as const) {
    for (const service of doc.service ?? []) {
      if (typeof service.id !== 'string' || !strings(service.type).includes(type)) continue;
      const serviceId = service.id.startsWith('#') ? doc.id + service.id : service.id;
      for (const url of strings(service.serviceEndpoint)) {
        if (!usable(type, url) || out.some((e) => e.type === type && e.url === url)) continue;
        out.push({ did: doc.id, serviceId, type, url });
      }
    }
  }
  return out.slice(0, MAX_ENDPOINTS);
}

/**
 * The storage endpoints of a XID document: each service with the capability DIDPackageRepository, in
 * document order. A service has one URI. A XID document has no DWN endpoint yet.
 */
export function xidEndpoints(doc: XidDocumentInfo): Endpoint[] {
  const out: Endpoint[] = [];
  for (const s of doc.services) {
    if (s.capability !== REPOSITORY_SERVICE_TYPE || !usable(REPOSITORY_SERVICE_TYPE, s.uri) || out.some((e) => e.url === s.uri)) continue;
    out.push({ did: doc.xid, serviceId: s.uri, type: REPOSITORY_SERVICE_TYPE, url: s.uri });
  }
  return out.slice(0, MAX_ENDPOINTS);
}

// A repository URL is the base of relative layout paths. Thus it must end with "/", or the
// last path segment is lost (RFC 3986 section 5). Credentials, a query and a fragment are not allowed.
function usable(type: EndpointType, url: string): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  if (u.username || u.password || url.includes('?') || url.includes('#')) return false;
  return type === DWN_SERVICE_TYPE || url.endsWith('/');
}
