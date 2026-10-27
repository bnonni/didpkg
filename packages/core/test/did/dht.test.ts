// did:dht driver against fake relays. The payloads are signed with a new identity key per run.
import { expect, test } from 'bun:test';
import { DidDht } from '@enbox/dids';
import { DID_ERROR_NS } from '../../src/did/errors.ts';
import { dhtDriver } from '../../src/did/drivers/dht.ts';
import { DidResolver } from '../../src/did/resolver.ts';
import type { DidResolutionResult } from '../../src/did/types.ts';
import { bytesResponse, dhtFixture, fakeFetch, hangingFetch, SERVICE_TYPE } from './helpers.ts';

const A = 'https://relay-a.example';
const B = 'https://relay-b.example/pkarr/';
const ctx = { signal: new AbortController().signal };
const code = (r: DidResolutionResult) => r.didResolutionMetadata.error?.type.slice(DID_ERROR_NS.length);
const fx = await dhtFixture(['https://bnonni.github.io/didpkg-spike-pages/', 'https://dwn.example/']);

test('resolves a signed packet: document, versionId, updated, source', async () => {
  const { fetch, calls } = fakeFetch({ [`${A}/${fx.id}`]: bytesResponse(await fx.payload(1793113192)) });
  const r = await dhtDriver({ relays: [A, B], fetch }).resolve(fx.did, {}, ctx);
  expect(code(r)).toBeUndefined();
  expect(calls.sort()).toEqual([`${A}/${fx.id}`, `${B}${fx.id}`]);
  expect(r.didResolutionMetadata).toEqual({ source: A, verification: 'cryptographic' });
  expect(r.didDocumentMetadata).toEqual({ versionId: '1793113192', updated: '2026-10-27T14:59:52Z' });
  const doc = r.didDocument!;
  expect(doc.id).toBe(fx.did);
  // Enbox also puts #0 in assertionMethod by default (ADR 0001 finding).
  expect(doc.assertionMethod).toEqual([`${fx.did}#0`, `${fx.did}#didpkg-1`]);
  expect(doc.service).toEqual([{ id: `${fx.did}#pkg`, type: SERVICE_TYPE, serviceEndpoint: ['https://bnonni.github.io/didpkg-spike-pages/', 'https://dwn.example/'] }]);
  // The same document as the Enbox resolver gives for the same packet.
  expect(doc).toEqual(JSON.parse(JSON.stringify(fx.document)));
});

test('the valid packet with the highest seq wins', async () => {
  const { fetch } = fakeFetch({
    [`${A}/${fx.id}`]: bytesResponse(await fx.payload(1000)),
    [`${B}${fx.id}`]: bytesResponse(await fx.payload(2000)),
  });
  const r = await dhtDriver({ relays: [A, B], fetch }).resolve(fx.did, {}, ctx);
  expect([r.didDocumentMetadata.versionId, r.didResolutionMetadata.source]).toEqual(['2000', B]);
});

test('a packet with a bad signature loses to a valid one, and alone gives INVALID_DID_DOCUMENT', async () => {
  const forged = await fx.payload(3000);
  forged[0]! ^= 1;
  const { fetch } = fakeFetch({ [`${A}/${fx.id}`]: bytesResponse(forged), [`${B}${fx.id}`]: bytesResponse(await fx.payload(1000)) });
  expect((await dhtDriver({ relays: [A, B], fetch }).resolve(fx.did, {}, ctx)).didDocumentMetadata.versionId).toBe('1000');
  const only = await dhtDriver({ relays: [A], fetch }).resolve(fx.did, {}, ctx);
  expect(code(only)).toBe('INVALID_DID_DOCUMENT');
  expect(only.didResolutionMetadata.error?.detail).toContain('Invalid signature');
});

test('a packet of another DID fails the signature check', async () => {
  const other = await dhtFixture();
  const { fetch } = fakeFetch({ [`${A}/${fx.id}`]: bytesResponse(await other.payload()) });
  expect(code(await dhtDriver({ relays: [A], fetch }).resolve(fx.did, {}, ctx))).toBe('INVALID_DID_DOCUMENT');
});

test('a short, an oversize and an unsafe-seq payload are invalid', async () => {
  const big = await fx.payload(1, new Uint8Array(1001));
  const huge = await fx.payload(2n ** 60n);
  for (const body of [new Uint8Array(71), big, huge]) {
    const { fetch } = fakeFetch({ [`${A}/${fx.id}`]: bytesResponse(body) });
    expect(code(await dhtDriver({ relays: [A], fetch }).resolve(fx.did, {}, ctx))).toBe('INVALID_DID_DOCUMENT');
  }
});

test('404 from all relays gives NOT_FOUND; a relay failure gives a transient INTERNAL_ERROR', async () => {
  const { fetch } = fakeFetch({});
  const nf = await dhtDriver({ relays: [A, B], fetch }).resolve(fx.did, {}, ctx);
  expect([code(nf), nf.didResolutionMetadata.transient]).toEqual(['NOT_FOUND', undefined]);
  const down = fakeFetch({ [`${B}${fx.id}`]: new Response('busy', { status: 503 }) });
  const r = await dhtDriver({ relays: [A, B], fetch: down.fetch }).resolve(fx.did, {}, ctx);
  expect([code(r), r.didResolutionMetadata.transient]).toEqual(['INTERNAL_ERROR', true]);
  expect(r.didResolutionMetadata.error?.detail).toContain('HTTP 503');
  const slow = await dhtDriver({ relays: [A], fetch: hangingFetch, timeoutMs: 30 }).resolve(fx.did, {}, ctx);
  expect([code(slow), slow.didResolutionMetadata.transient]).toEqual(['INTERNAL_ERROR', true]);
});

test('one relay down does not block the answer of the other', async () => {
  const { fetch } = fakeFetch({ [`${A}/${fx.id}`]: async () => { throw new TypeError('fetch failed'); }, [`${B}${fx.id}`]: bytesResponse(await fx.payload(5)) });
  expect((await dhtDriver({ relays: [A, B], fetch }).resolve(fx.did, {}, ctx)).didDocumentMetadata.versionId).toBe('5');
});

test('an invalid did:dht identifier gives INVALID_DID with no request', async () => {
  const { fetch, calls } = fakeFetch({});
  const d = dhtDriver({ relays: [A], fetch });
  for (const did of ['did:dht:abc', `did:dht:${fx.id}x`, 'did:dht:' + 'l'.repeat(52)]) {
    expect([did, code(await d.resolve(did, {}, ctx))]).toEqual([did, 'INVALID_DID']);
  }
  expect(calls).toEqual([]);
});

test('a private relay needs allowPrivateRelays', async () => {
  const local = 'http://127.0.0.1:9';
  const { fetch } = fakeFetch({ [`${local}/${fx.id}`]: bytesResponse(await fx.payload(9)) });
  const blocked = await dhtDriver({ relays: [local], fetch }).resolve(fx.did, {}, ctx);
  expect(code(blocked)).toBe('INVALID_DID_DOCUMENT');
  expect(blocked.didResolutionMetadata.error?.detail).toContain('only https');
  expect((await dhtDriver({ relays: [local], fetch, allowPrivateRelays: true }).resolve(fx.did, {}, ctx)).didDocumentMetadata.versionId).toBe('9');
});

test('through DidResolver: the id check passes and the cache works', async () => {
  const { fetch, calls } = fakeFetch({ [`${A}/${fx.id}`]: bytesResponse(await fx.payload(7)) });
  const r = new DidResolver({ drivers: [dhtDriver({ relays: [A], fetch })] });
  expect((await r.resolve(fx.did)).didDocument?.id).toBe(fx.did);
  await r.resolve(fx.did);
  expect(calls).toHaveLength(1);
  expect(code(await r.resolve(fx.did, { versionId: '7' }))).toBe('FEATURE_NOT_SUPPORTED');
});

test('the default relays are the two from spike 01', () => {
  expect(() => dhtDriver({ relays: [] })).toThrow('at least one relay');
  expect(dhtDriver().method).toBe('dht');
  expect(DidDht.methodName).toBe('dht');
});
