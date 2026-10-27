// runDriverConformance: the checks that every DID method driver must pass (PLAN.md "Definition of
// done" item 4). It uses no test framework, so packages/did-* can call it in their own tests.
// Each failure is one string. An empty list means pass.
import { DID_ERROR_NS, type DidErrorCode } from './errors.ts';
import { DidResolver } from './resolver.ts';
import type { DidDocument, DidMethodDriver, DidResolutionResult } from './types.ts';

export interface ConformanceFixtures {
  /** DIDs that resolve to a document. At least one. */
  valid: string[];
  /** DIDs with a method-specific syntax error. */
  invalid?: string[];
  notFound?: string[];
  deactivated?: string[];
}

const RELATIONSHIPS = ['authentication', 'assertionMethod', 'keyAgreement', 'capabilityInvocation', 'capabilityDelegation'] as const;
const VERIFICATIONS = new Set(['deterministic', 'cryptographic', 'partial', 'tofu']);

export async function runDriverConformance(driver: DidMethodDriver, fixtures: ConformanceFixtures): Promise<string[]> {
  const fails: string[] = [];
  const check = (ok: unknown, message: string) => {
    if (!ok) fails.push(`did:${driver.method}: ${message}`);
  };

  check(/^[a-z0-9]+$/.test(driver.method), `method ${JSON.stringify(driver.method)} is not a DID method name`);
  check(VERIFICATIONS.has(driver.verification), `verification ${JSON.stringify(driver.verification)} is not known`);
  check(typeof driver.history === 'boolean', 'history is not a boolean');
  check(typeof driver.freshMs === 'number' && driver.freshMs >= 0, 'freshMs is not a number >= 0');
  check(fixtures.valid.length > 0, 'the fixtures have no valid DID');

  const resolver = new DidResolver({ drivers: [driver] });
  const direct = async (did: string): Promise<DidResolutionResult | undefined> => {
    try {
      return await driver.resolve(did, {}, { signal: new AbortController().signal });
    } catch (e) {
      check(false, `${did}: resolve threw ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };
  const expectError = (did: string, r: DidResolutionResult | undefined, code: DidErrorCode, via: string) => {
    if (!r) return;
    check(r.didResolutionMetadata?.error?.type === DID_ERROR_NS + code, `${did}: ${via} gives ${r.didResolutionMetadata?.error?.type ?? 'no error'}, not ${code}`);
    check(r.didDocument === null, `${did}: ${via} gives a didDocument with an error`);
  };

  for (const did of fixtures.valid) {
    const r = await direct(did);
    if (!r) continue;
    const error = r.didResolutionMetadata?.error;
    check(!error, `${did}: error ${error?.type} ${error?.detail ?? ''}`.trim());
    if (error) continue;
    check(r.didDocumentMetadata && typeof r.didDocumentMetadata === 'object', `${did}: no didDocumentMetadata`);
    check(r.didDocumentMetadata?.deactivated !== true, `${did}: a valid fixture is deactivated`);
    check(isJson(r.didDocument) && isJson(r.didDocumentMetadata), `${did}: the result has a value that is not JSON`);
    if (r.didDocument) for (const f of checkDocument(did, r.didDocument)) check(false, `${did}: ${f}`);
    else check(false, `${did}: no didDocument`);

    if (driver.verification === 'deterministic') {
      const again = await direct(did);
      check(JSON.stringify(again) === JSON.stringify(r), `${did}: a second call gives a different result`);
    }
    const viaResolver = await resolver.resolve(did);
    check(!viaResolver.didResolutionMetadata.error, `${did}: DidResolver gives ${viaResolver.didResolutionMetadata.error?.type}`);
    expectError(did, await resolver.resolve(did, { versionId: '1', versionTime: '2026-01-01T00:00:00Z' }), 'INVALID_OPTIONS', 'versionId with versionTime');
    if (!driver.history) {
      expectError(did, await resolver.resolve(did, { versionId: '1', noCache: true }), 'FEATURE_NOT_SUPPORTED', 'versionId');
      expectError(did, await resolver.resolve(did, { versionTime: '2026-01-01T00:00:00Z', noCache: true }), 'FEATURE_NOT_SUPPORTED', 'versionTime');
    }
  }
  for (const did of fixtures.invalid ?? []) {
    expectError(did, await direct(did), 'INVALID_DID', 'the driver');
    expectError(did, await resolver.resolve(did), 'INVALID_DID', 'DidResolver');
  }
  for (const did of fixtures.notFound ?? []) {
    expectError(did, await direct(did), 'NOT_FOUND', 'the driver');
  }
  for (const did of fixtures.deactivated ?? []) {
    const r = await direct(did);
    if (!r) continue;
    check(!r.didResolutionMetadata?.error, `${did}: a deactivated DID gives error ${r.didResolutionMetadata?.error?.type}`);
    check(r.didDocument === null, `${did}: a deactivated DID gives a didDocument`);
    check(r.didDocumentMetadata?.deactivated === true, `${did}: didDocumentMetadata.deactivated is not true`);
  }
  const other = driver.method === 'example' ? 'did:other:1' : 'did:example:1';
  expectError(other, await resolver.resolve(other), 'METHOD_NOT_SUPPORTED', 'DidResolver');
  return fails;
}

/** DID Core 1.0 sections 5.2-5.4: the parts of a document that didpkg reads. */
function checkDocument(did: string, doc: DidDocument): string[] {
  const fails: string[] = [];
  const abs = (ref: string) => (ref.startsWith('#') ? did + ref : ref);
  if (doc.id !== did) fails.push(`didDocument.id is ${JSON.stringify(doc.id)}`);
  const vms = doc.verificationMethod ?? [];
  if (!Array.isArray(vms)) return [...fails, 'verificationMethod is not an array'];
  const ids = new Set<string>();
  for (const vm of vms) {
    if (typeof vm?.id !== 'string' || !(vm.id.startsWith('#') || vm.id.startsWith(`${did}#`))) fails.push(`verification method id ${JSON.stringify(vm?.id)} is not a fragment of the DID`);
    else if (ids.has(abs(vm.id))) fails.push(`verification method id ${vm.id} is not unique`);
    else ids.add(abs(vm.id));
    if (typeof vm?.type !== 'string') fails.push(`verification method ${vm?.id} has no type`);
    if (typeof vm?.controller !== 'string') fails.push(`verification method ${vm?.id} has no controller`);
    if (vm && vm.publicKeyMultibase === undefined && vm.publicKeyJwk === undefined) fails.push(`verification method ${vm.id} has no key`);
  }
  for (const rel of RELATIONSHIPS) {
    const list = doc[rel];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      fails.push(`${rel} is not an array`);
      continue;
    }
    for (const ref of list) {
      if (typeof ref === 'string' && (ref.startsWith('#') || ref.startsWith(`${did}#`)) && !ids.has(abs(ref))) fails.push(`${rel} refers to ${ref}, which is not in verificationMethod`);
      if (typeof ref !== 'string' && (typeof ref?.id !== 'string' || typeof ref.type !== 'string')) fails.push(`${rel} has an embedded method with no id or type`);
    }
  }
  if (doc.service !== undefined) {
    if (!Array.isArray(doc.service)) fails.push('service is not an array');
    else
      for (const s of doc.service) {
        if (typeof s?.id !== 'string') fails.push('a service has no id');
        if (typeof s?.type !== 'string' && !(Array.isArray(s?.type) && s.type.every((t) => typeof t === 'string'))) fails.push(`service ${s?.id} has no type`);
        if (s?.serviceEndpoint === undefined) fails.push(`service ${s?.id} has no serviceEndpoint`);
      }
  }
  return fails;
}

function isJson(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJson);
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    return (proto === Object.prototype || proto === null) && Object.values(v as object).every(isJson);
  }
  return false;
}
