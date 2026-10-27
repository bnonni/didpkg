// did:web driver with a fake fetch. web-did-resolver builds the URLs.
import { expect, test } from 'bun:test';
import { DID_ERROR_NS } from '../../src/did/errors.ts';
import { webDriver } from '../../src/did/drivers/web.ts';
import { DidResolver } from '../../src/did/resolver.ts';
import type { DidResolutionResult } from '../../src/did/types.ts';
import { fakeFetch, hangingFetch, jsonResponse } from './helpers.ts';

const ctx = { signal: new AbortController().signal };
const code = (r: DidResolutionResult) => r.didResolutionMetadata.error?.type.slice(DID_ERROR_NS.length);
const docOf = (id: string) => ({
  '@context': ['https://www.w3.org/ns/did/v1'],
  id,
  verificationMethod: [{ id: `${id}#didpkg-1`, type: 'Multikey', controller: id, publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' }],
  assertionMethod: [`${id}#didpkg-1`],
  service: [{ id: `${id}#pkg`, type: 'DIDPackageRepository', serviceEndpoint: ['https://bnonni.github.io/didpkg-spike-pages/'] }],
});

test('resolves the domain form and the path form', async () => {
  const root = 'did:web:example.com';
  const path = 'did:web:bnonni.github.io:didpkg-spike-pages';
  const port = 'did:web:example.com%3A8443:u:alice';
  const { fetch, calls } = fakeFetch({
    'https://example.com/.well-known/did.json': jsonResponse(docOf(root)),
    'https://bnonni.github.io/didpkg-spike-pages/did.json': jsonResponse(docOf(path)),
    'https://example.com:8443/u/alice/did.json': jsonResponse(docOf(port)),
  });
  const d = webDriver({ fetch });
  for (const did of [root, path, port]) {
    const r = await d.resolve(did, {}, ctx);
    expect([did, code(r)]).toEqual([did, undefined]);
    expect(r.didDocument).toEqual(docOf(did));
    expect(r.didResolutionMetadata.verification).toBe('tofu');
  }
  expect(calls).toEqual(['https://example.com/.well-known/did.json', 'https://bnonni.github.io/didpkg-spike-pages/did.json', 'https://example.com:8443/u/alice/did.json']);
});

test('a document of another DID gives INVALID_DID_DOCUMENT', async () => {
  const { fetch } = fakeFetch({ 'https://example.com/.well-known/did.json': jsonResponse(docOf('did:web:evil.example')) });
  const r = await webDriver({ fetch }).resolve('did:web:example.com', {}, ctx);
  expect([code(r), r.didDocument]).toEqual(['INVALID_DID_DOCUMENT', null]);
});

test('404 gives NOT_FOUND; 503, 429 and a timeout give a transient INTERNAL_ERROR', async () => {
  const { fetch } = fakeFetch({
    'https://busy.example/.well-known/did.json': new Response('busy', { status: 503 }),
    'https://slow.example/.well-known/did.json': new Response('wait', { status: 429 }),
    'https://gone.example/.well-known/did.json': new Response('gone', { status: 403 }),
  });
  const d = webDriver({ fetch });
  const nf = await d.resolve('did:web:none.example', {}, ctx);
  expect([code(nf), nf.didResolutionMetadata.transient]).toEqual(['NOT_FOUND', undefined]);
  for (const host of ['busy.example', 'slow.example']) {
    const r = await d.resolve(`did:web:${host}`, {}, ctx);
    expect([host, code(r), r.didResolutionMetadata.transient]).toEqual([host, 'INTERNAL_ERROR', true]);
  }
  const forbidden = await d.resolve('did:web:gone.example', {}, ctx);
  expect([code(forbidden), forbidden.didResolutionMetadata.transient]).toEqual(['INTERNAL_ERROR', undefined]);
  const slow = await webDriver({ fetch: hangingFetch, timeoutMs: 30 }).resolve('did:web:example.com', {}, ctx);
  expect([code(slow), slow.didResolutionMetadata.transient]).toEqual(['INTERNAL_ERROR', true]);
});

test('bad JSON, a large response and a redirect to another host fail', async () => {
  const { fetch } = fakeFetch({
    'https://json.example/.well-known/did.json': new Response('{not json'),
    'https://big.example/.well-known/did.json': new Response(new Uint8Array(256 * 1024 + 1)),
    'https://move.example/.well-known/did.json': new Response(null, { status: 301, headers: { location: 'https://evil.example/did.json' } }),
  });
  const d = webDriver({ fetch });
  for (const host of ['json.example', 'big.example', 'move.example']) {
    const r = await d.resolve(`did:web:${host}`, {}, ctx);
    expect([host, code(r), r.didResolutionMetadata.transient]).toEqual([host, 'INTERNAL_ERROR', undefined]);
  }
});

test('a private host is blocked unless allowPrivateHosts', async () => {
  const { fetch, calls } = fakeFetch({ 'https://localhost/.well-known/did.json': jsonResponse(docOf('did:web:localhost')) });
  for (const did of ['did:web:localhost', 'did:web:127.0.0.1', 'did:web:169.254.169.254', 'did:web:%5B%3A%3A1%5D']) {
    expect([did, code(await webDriver({ fetch }).resolve(did, {}, ctx))]).toEqual([did, 'INTERNAL_ERROR']);
  }
  expect(calls).toEqual([]);
  expect(code(await webDriver({ fetch, allowPrivateHosts: true }).resolve('did:web:localhost', {}, ctx))).toBeUndefined();
});

test('an invalid did:web gives INVALID_DID with no request', async () => {
  const { fetch, calls } = fakeFetch({});
  const d = webDriver({ fetch });
  for (const did of ['did:web:example.com%3A99999', 'did:web:example.com::x', 'did:web:user%40example.com']) {
    expect([did, code(await d.resolve(did, {}, ctx))]).toEqual([did, 'INVALID_DID']);
  }
  expect(calls).toEqual([]);
});

test('through DidResolver: version options give FEATURE_NOT_SUPPORTED', async () => {
  const { fetch } = fakeFetch({ 'https://example.com/.well-known/did.json': jsonResponse(docOf('did:web:example.com')) });
  const r = new DidResolver({ drivers: [webDriver({ fetch })] });
  expect(code(await r.resolve('did:web:example.com', { versionTime: '2026-10-27T00:00:00Z' }))).toBe('FEATURE_NOT_SUPPORTED');
  expect((await r.resolve('did:web:example.com', { accept: 'application/did+ld+json' })).didResolutionMetadata.contentType).toBe('application/did+ld+json');
});
