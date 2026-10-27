// did:jwk driver (https://github.com/quartzjer/did-jwk/blob/main/spec.md). No DID library:
// the DID holds the public JWK. The spec rejects a private key.
import { base64urlnopad } from '@scure/base';
import { failure } from '../errors.ts';
import type { DidDocument, DidMethodDriver, DidResolutionResult, Jwk } from '../types.ts';

const ID_RE = /^[A-Za-z0-9_-]+$/;
// RFC 7518 section 6: the private members of EC, RSA and oct keys. RFC 8037 uses "d" for OKP.
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
const REQUIRED: Record<string, string[]> = { EC: ['crv', 'x', 'y'], OKP: ['crv', 'x'], RSA: ['n', 'e'] };

export function jwkDriver(): DidMethodDriver {
  return {
    method: 'jwk',
    verification: 'deterministic',
    history: false,
    freshMs: Number.POSITIVE_INFINITY,
    async resolve(did) {
      return resolveJwk(did);
    },
  };
}

function resolveJwk(did: string): DidResolutionResult {
  const id = did.slice('did:jwk:'.length);
  if (!did.startsWith('did:jwk:') || !ID_RE.test(id)) return failure('INVALID_DID', 'did:jwk needs one base64url value with no padding');
  let jwk: unknown;
  try {
    jwk = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64urlnopad.decode(id)));
  } catch {
    return failure('INVALID_DID', 'the value is not base64url UTF-8 JSON');
  }
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return failure('INVALID_DID', 'the value is not a JSON object');
  const key = jwk as Jwk;
  const required = REQUIRED[key.kty];
  if (!required) return failure('INVALID_DID', `kty ${JSON.stringify(key.kty)} is not a public key type`);
  if (PRIVATE_MEMBERS.some((m) => m in key)) return failure('INVALID_DID', 'the JWK is a private key');
  const missing = required.filter((m) => typeof key[m] !== 'string');
  if (missing.length) return failure('INVALID_DID', `the ${key.kty} JWK has no ${missing.join(', ')}`);

  const vmId = `${did}#0`;
  const doc: DidDocument = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: did,
    verificationMethod: [{ id: vmId, type: 'JsonWebKey2020', controller: did, publicKeyJwk: key }],
  };
  if (key.use !== 'enc') {
    doc.assertionMethod = [vmId];
    doc.authentication = [vmId];
    doc.capabilityInvocation = [vmId];
    doc.capabilityDelegation = [vmId];
  }
  if (key.use !== 'sig') doc.keyAgreement = [vmId];
  return { didResolutionMetadata: { source: 'did', verification: 'deterministic' }, didDocument: doc, didDocumentMetadata: {} };
}
