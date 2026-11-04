// The DID resolver of the didpkg DWN. dwn-server 0.1.45 resolves only did:dht, did:jwk, did:key and did:web.
// This resolver keeps those 4 resolvers and adds did:webvh and did:plc through the drivers of @didpkg/core.
// The did:plc driver reads the audit log from https://plc.directory and checks each operation.
// dwn-sdk-js accepts a signature only from a verification method of type JsonWebKey or JsonWebKey2020
// with publicKeyJwk and no other member. Thus each Ed25519 Multikey method becomes a JsonWebKey method.
// The key bytes do not change, so the trust does not change.
import { DidDht, DidJwk, DidKey, DidResolverCacheMemory, DidWeb, UniversalResolver } from '@enbox/dids';
import { base58, base64urlnopad } from '@scure/base';
import { DidResolver } from '../../packages/core/src/did/resolver.ts';
import { errorCode } from '../../packages/core/src/did/errors.ts';
import { plcDriver } from '../../packages/core/src/did/drivers/plc.ts';
import { webvhDriver } from '../../packages/core/src/did/drivers/webvh.ts';
import type { DidDocument, DidResolutionResult, VerificationMethod } from '../../packages/core/src/did/types.ts';

export function dwnDidResolver(): UniversalResolver {
  const core = new DidResolver({ drivers: [webvhDriver(), plcDriver()] });
  const resolve = async (did: string) => toEnbox(await core.resolve(did));
  // The type of didResolvers wants a class. UniversalResolver reads only methodName and resolve.
  const methods = ['webvh', 'plc'].map((methodName) => ({ methodName, resolve }) as unknown as typeof DidKey);
  return new UniversalResolver({
    didResolvers: [DidDht, DidJwk, DidKey, DidWeb, ...methods],
    cache: new DidResolverCacheMemory(),
  });
}

export interface EnboxResolution {
  didResolutionMetadata: { error?: string; errorMessage?: string; errorCause?: string; contentType?: string };
  didDocument: DidDocument | null;
  didDocumentMetadata: DidResolutionResult['didDocumentMetadata'];
}

/** The Enbox form of a W3C DID Resolution result: the error is a camelCase code, as in DidErrorCode. */
export function toEnbox(r: DidResolutionResult): EnboxResolution {
  const code = errorCode(r);
  if (code) {
    const error = code.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    return {
      didResolutionMetadata: {
        error,
        errorMessage: r.didResolutionMetadata.error?.detail ?? code,
        ...(r.didResolutionMetadata.transient && { errorCause: 'networkUnavailable' }),
      },
      didDocument: null,
      didDocumentMetadata: {},
    };
  }
  return {
    didResolutionMetadata: { contentType: r.didResolutionMetadata.contentType },
    didDocument: r.didDocument && jwkMethods(r.didDocument),
    didDocumentMetadata: r.didDocumentMetadata,
  };
}

/** A copy of the document where each Ed25519 Multikey method is a JsonWebKey method. */
export function jwkMethods(doc: DidDocument): DidDocument {
  const methods = (list: unknown) => Array.isArray(list) ? list.map((m) => (typeof m === 'object' && m ? jwkMethod(m as VerificationMethod) : m)) : list;
  const out: DidDocument = { ...doc, verificationMethod: methods(doc.verificationMethod) as VerificationMethod[] | undefined };
  for (const rel of ['authentication', 'assertionMethod', 'capabilityInvocation', 'capabilityDelegation'] as const) {
    if (doc[rel] !== undefined) out[rel] = methods(doc[rel]) as DidDocument[typeof rel];
  }
  if (out.verificationMethod === undefined) delete out.verificationMethod;
  return out;
}

function jwkMethod(m: VerificationMethod): VerificationMethod {
  if (m.type !== 'Multikey' || typeof m.publicKeyMultibase !== 'string' || !m.publicKeyMultibase.startsWith('z')) return m;
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(m.publicKeyMultibase.slice(1));
  } catch {
    return m;
  }
  // The multicodec varint 0xed01 is ed25519-pub. A key of another type stays as it is.
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) return m;
  return { id: m.id, type: 'JsonWebKey', controller: m.controller, publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: base64urlnopad.encode(bytes.subarray(2)) } };
}
