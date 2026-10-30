// did:webvh driver with a fake fetch. didwebvh-ts makes and checks the logs.
import { expect, test } from 'bun:test';
import { DID_ERROR_NS } from '../../src/did/errors.ts';
import { webvhDriver } from '../../src/did/drivers/webvh.ts';
import { DidResolver } from '../../src/did/resolver.ts';
import type { DidResolutionResult } from '../../src/did/types.ts';
import { fakeFetch, hangingFetch, textResponse, webvhFixture } from './helpers.ts';

const ctx = { signal: new AbortController().signal };
const code = (r: DidResolutionResult) => r.didResolutionMetadata.error?.type.slice(DID_ERROR_NS.length);
const endpoint = (r: DidResolutionResult) => r.didDocument?.service?.find((s) => s.id.endsWith('#pkg'))?.serviceEndpoint;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test('resolves the domain form, the path form and a port', async () => {
  const root = await webvhFixture();
  const path = await webvhFixture('pkg.example.com', ['dids', 'alice']);
  const port = await webvhFixture('pkg.example.com:8443');
  expect([root.url, path.url, port.url]).toEqual([
    'https://pkg.example.com/.well-known/did.jsonl',
    'https://pkg.example.com/dids/alice/did.jsonl',
    'https://pkg.example.com:8443/.well-known/did.jsonl',
  ]);
  expect(port.did).toEndWith(':pkg.example.com%3A8443');
  const { fetch, calls } = fakeFetch(Object.fromEntries([root, path, port].map((f) => [f.url, textResponse(f.jsonl(f.log))])));
  const d = webvhDriver({ fetch });
  for (const f of [root, path, port]) {
    const r = await d.resolve(f.did, {}, ctx);
    expect(r.didResolutionMetadata).toEqual({ source: f.url, verification: 'cryptographic' });
    expect(r.didDocument?.id).toBe(f.did);
    expect(r.didDocument?.assertionMethod).toEqual([`${f.did}#didpkg-1`]);
    expect(r.didDocumentMetadata.versionId).toStartWith('1-');
  }
  expect(calls).toEqual([root.url, path.url, port.url]);
});

test('versionId and versionTime select an older entry', async () => {
  const f = await webvhFixture();
  const log = await f.update(f.log, 'https://two.example.com/');
  const { fetch } = fakeFetch({ [f.url]: textResponse(f.jsonl(log)) });
  const resolver = new DidResolver({ drivers: [webvhDriver({ fetch })] });
  const [first, second] = log;
  expect(endpoint(await resolver.resolve(f.did))).toBe('https://two.example.com/');
  expect(endpoint(await resolver.resolve(f.did, { versionId: first!.versionId }))).toBe('https://pkg.example.com/');
  expect(endpoint(await resolver.resolve(f.did, { versionTime: first!.versionTime }))).toBe('https://pkg.example.com/');
  expect(endpoint(await resolver.resolve(f.did, { versionTime: second!.versionTime }))).toBe('https://two.example.com/');
  expect(code(await resolver.resolve(f.did, { versionId: '3-QmNone' }))).toBe('NOT_FOUND');
});

test('a changed entry fails, and the driver gives no older document', async () => {
  const f = await webvhFixture();
  const log = copy(await f.update(f.log, 'https://two.example.com/'));
  (log[1]!.state.service as { serviceEndpoint: string }[])[0]!.serviceEndpoint = 'https://evil.example.com/';
  const { fetch } = fakeFetch({ [f.url]: textResponse(f.jsonl(log)) });
  const r = await webvhDriver({ fetch }).resolve(f.did, {}, ctx);
  expect([code(r), r.didDocument, r.didResolutionMetadata.source]).toEqual(['INVALID_DID_DOCUMENT', null, f.url]);
  expect(r.didResolutionMetadata.error?.detail).toContain('Hash chain broken');
});

test('a proof by another key fails, and so does the log of another DID', async () => {
  const f = await webvhFixture();
  const other = await webvhFixture();
  const log = copy(f.log);
  log[0]!.proof = copy(other.log[0]!.proof);
  const { fetch } = fakeFetch({ [f.url]: textResponse(f.jsonl(log)) });
  expect(code(await webvhDriver({ fetch }).resolve(f.did, {}, ctx))).toBe('INVALID_DID_DOCUMENT');

  const swapped = fakeFetch({ [f.url]: textResponse(other.jsonl(other.log)) });
  expect(code(await webvhDriver({ fetch: swapped.fetch }).resolve(f.did, {}, ctx))).toBe('INVALID_DID_DOCUMENT');
});

test('a deactivated DID gives no document and deactivated true', async () => {
  const f = await webvhFixture();
  const { fetch } = fakeFetch({ [f.url]: textResponse(f.jsonl(await f.deactivate(f.log))) });
  const r = await webvhDriver({ fetch }).resolve(f.did, {}, ctx);
  expect([r.didResolutionMetadata.error, r.didDocument, r.didDocumentMetadata.deactivated]).toEqual([undefined, null, true]);
});

test('HTTP 503 and a timeout are transient; HTTP 403 and an empty log are not', async () => {
  const f = await webvhFixture();
  const at = (status: number, body = '') => webvhDriver({ fetch: fakeFetch({ [f.url]: textResponse(body, status) }).fetch }).resolve(f.did, {}, ctx);
  const r503 = await at(503);
  expect([code(r503), r503.didResolutionMetadata.transient]).toEqual(['INTERNAL_ERROR', true]);
  const late = await webvhDriver({ fetch: hangingFetch, timeoutMs: 20 }).resolve(f.did, {}, ctx);
  expect([code(late), late.didResolutionMetadata.transient]).toEqual(['INTERNAL_ERROR', true]);
  const r403 = await at(403);
  expect([code(r403), r403.didResolutionMetadata.transient]).toEqual(['INTERNAL_ERROR', undefined]);
  expect(code(await at(200, ''))).toBe('NOT_FOUND');
});

// The library refuses localhost and IP addresses. A .localhost name is a private host for fetch.ts.
test('a private host needs allowPrivateHosts', async () => {
  const f = await webvhFixture('pkg.localhost:8443');
  const { fetch, calls } = fakeFetch({ [f.url]: textResponse(f.jsonl(f.log)) });
  const blocked = await webvhDriver({ fetch }).resolve(f.did, {}, ctx);
  expect([code(blocked), blocked.didDocument, calls]).toEqual(['INVALID_DID_DOCUMENT', null, []]);
  const allowed = await webvhDriver({ fetch, allowPrivateHosts: true }).resolve(f.did, {}, ctx);
  expect([allowed.didResolutionMetadata.error, allowed.didDocument?.id]).toEqual([undefined, f.did]);
});
