// The DWN reader against the pinned @enbox/dwn-server 0.1.45, with the data of DwnWriter. Then PackageSource
// and the verifier on the reader, with a count of the requests (the DWN allows 20 a second per tenant).
import { afterAll, expect, test } from 'bun:test';
import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import { RecordsWrite } from '@enbox/dwn-sdk-js';
import type { DidDocument } from '@didpkg/core/did';
import { PackageSource, buildPackument, type Endpoint, type StorageReader, type StoredFile } from '@didpkg/core/source';
import { verifyIndex, verifyRelease, type Pin } from '@didpkg/core/trust';
import { FakeResolver, MemReader, NAME, didDoc, newKey, publish, tgz } from '../../core/test/trust/sim.ts';
import { DIDPKG_PROTOCOL, MAX_CONTEXTS, dwnAdapter, protocolDefinition } from '../src/index.ts';
import { startPublisher } from './server.ts';

const { fx, signer, dwn, writer, stop } = await startPublisher();
afterAll(stop);

const te = new TextEncoder();
const enc = (v: unknown) => te.encode(JSON.stringify(v));

// The signed objects of the simulator. Their key is not the DWN key: the DWN signature is not a trust input.
const key = await newKey(fx.did, 'didpkg-1');
const mem = new MemReader();
const stored = new Map<string, { release: Uint8Array; tarball: Uint8Array; index: Uint8Array }>();
for (const version of ['1.0.0', '1.1.0']) {
  await publish(mem, { did: fx.did, version, tarball: tgz(version), signers: [key.signer] });
  const files = { release: enc(mem.releases.get(`${fx.did}/${NAME}@${version}`)), tarball: tgz(version), index: enc(mem.indexes.get(`${fx.did}/${NAME}`)) };
  await writer.publish({ name: NAME, version, ...files });
  stored.set(version, files);
}
const v10 = stored.get('1.0.0')!;
const v11 = stored.get('1.1.0')!;

const resolver = new FakeResolver();
resolver.docs.set(fx.did, { doc: { ...didDoc(fx.did, [key]), service: [{ id: '#dwn', type: 'DecentralizedWebNode', serviceEndpoint: dwn.url }] } as DidDocument });

const endpoint = (url: string, type: Endpoint['type'] = 'DecentralizedWebNode'): Endpoint => ({ did: fx.did, serviceId: `${fx.did}#dwn`, type, url });

/** A fetch that records the route of each request: `query`, or the protocol path of a read. */
function counted(f: typeof fetch = fetch) {
  const routes: string[] = [];
  const wrapped = ((url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    routes.push(path.endsWith('/query') ? 'query' : path.slice(path.indexOf('/package') + 1));
    return f(url, init);
  }) as typeof fetch;
  return { fetch: wrapped, routes };
}

async function all(reader: StorageReader, file: StoredFile, maxBytes = 1024 * 1024): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const bytes of reader.read(file, { signal: AbortSignal.timeout(5000), maxBytes })) out.push(bytes);
  return out;
}

test('canRead: the DWN type, https and no private host; http only on loopback with allowLoopback', () => {
  const strict = dwnAdapter();
  const urls = ['https://dwn.example', 'https://dwn.example/x/', 'http://dwn.example', 'https://10.0.0.1', 'https://localhost', 'http://127.0.0.1:3000', 'dwn.example'];
  expect(urls.map((u) => strict.canRead(endpoint(u)))).toEqual([true, true, false, false, false, false, false]);
  expect(strict.canRead(endpoint('https://dwn.example/', 'DIDPackageRepository'))).toBe(false);
  const local = dwnAdapter({ allowLoopback: true });
  expect(['http://127.0.0.1:3000', 'https://[::1]/', 'http://10.0.0.1'].map((u) => local.canRead(endpoint(u)))).toEqual([true, true, false]);
  expect(() => strict.reader(endpoint('http://127.0.0.1:3000'), { fetch })).toThrow(TypeError);
});

test('the reader yields the exact stored bytes; an absent file yields nothing', async () => {
  const { fetch, routes } = counted();
  const reader = dwnAdapter({ allowLoopback: true }).reader(endpoint(dwn.url), { fetch });
  expect(await all(reader, { kind: 'index', name: NAME })).toEqual([v11.index]);
  expect(await all(reader, { kind: 'release', name: NAME, version: '1.0.0' })).toEqual([v10.release]);
  expect(await all(reader, { kind: 'tarball', name: NAME, version: '1.1.0' })).toEqual([v11.tarball]);
  expect(await all(reader, { kind: 'release', name: NAME, version: '9.9.9' })).toEqual([]);
  expect(await all(reader, { kind: 'index', name: 'absent' })).toEqual([]);
  // One query per name: the contextIds of "hello" are kept, and an empty result is asked again.
  expect(routes.filter((r) => r === 'query').length).toBe(2);
  await all(reader, { kind: 'release', name: 'absent', version: '1.0.0' });
  expect(routes.filter((r) => r === 'query').length).toBe(3);
});

test('the DID is one path segment as it is; a DID that cannot be one segment is not read', async () => {
  const urls: string[] = [];
  const reader = dwnAdapter({ allowLoopback: true }).reader(endpoint(`${dwn.url}/`), { fetch: ((u: string, i?: RequestInit) => (urls.push(u), fetch(u, i))) as typeof fetch });
  expect(await all(reader, { kind: 'release', name: NAME, version: '1.0.0' })).toEqual([v10.release]);
  expect(urls.map((u) => u.slice(0, u.indexOf('/', dwn.url.length + 1)))).toEqual([`${dwn.url}/${fx.did}`, `${dwn.url}/${fx.did}`]);
  const adapter = dwnAdapter();
  for (const did of ['did:web:a.example%3A8443', 'did:web:a.example/x', 'did:web:a.example?x', 'did:web:a.example#x', 'did:Web:a']) {
    expect([did, adapter.canRead({ ...endpoint('https://dwn.example'), did })]).toEqual([did, did === 'did:web:a.example%3A8443']);
  }
});

test('an install from the DWN through PackageSource and the verifier: 4 requests, then only the tarball', async () => {
  const { fetch, routes } = counted();
  const source = new PackageSource({ resolver, adapters: [dwnAdapter({ allowLoopback: true })], fetch });
  const install = () => verifyRelease({ did: fx.did, name: NAME, version: '1.1.0', resolver, reader: source, trust: new Map<string, Pin>() });
  expect(new TextDecoder().decode((await install()).tarball)).toBe('fake-tgz:1.1.0');
  expect(routes).toEqual(['query', 'package/index', 'package/release', 'package/release/tarball']);
  // The index copies (5 s), the contextIds (5 min) and the release (by its signed digest) are kept.
  routes.length = 0;
  await install();
  expect(routes).toEqual(['package/release/tarball']);
});

test('a packument reads each listed release one time; a second packument sends no request', async () => {
  const { fetch, routes } = counted();
  const source = new PackageSource({ resolver, adapters: [dwnAdapter({ allowLoopback: true })], fetch });
  const packument = async () => {
    const verified = await verifyIndex({ did: fx.did, name: NAME, resolver, reader: source, trust: new Map<string, Pin>() });
    return buildPackument({ verified, reader: source, tarballUrl: ({ release }) => `http://shim/${release.version}.tgz` });
  };
  expect(Object.keys((await packument()).versions)).toEqual(['1.0.0', '1.1.0']);
  expect(routes).toEqual(['query', 'package/index', 'package/release', 'package/release']);
  routes.length = 0;
  await packument();
  expect(routes).toEqual([]);
});

test('concurrent reads share one request; after the index time limit, only the index is read again', async () => {
  const { fetch, routes } = counted();
  const source = new PackageSource({ resolver, adapters: [dwnAdapter({ allowLoopback: true, indexTtlMs: 50 })], fetch });
  const [a, b] = await Promise.all([source.getIndexes(fx.did, NAME), source.getIndexes(fx.did, NAME)]);
  expect([a, b]).toEqual([[JSON.parse(new TextDecoder().decode(v11.index))], [JSON.parse(new TextDecoder().decode(v11.index))]]);
  expect(routes).toEqual(['query', 'package/index']);
  await Bun.sleep(60);
  await source.getIndexes(fx.did, NAME);
  expect(routes).toEqual(['query', 'package/index', 'package/index']);
});

test('a new package becomes visible: an empty result is not kept', async () => {
  const reader = dwnAdapter({ allowLoopback: true, indexTtlMs: 0 }).reader(endpoint(dwn.url), { fetch });
  const later = { name: 'later', version: '1.0.0', release: enc({ name: 'later' }), tarball: tgz('later'), index: enc({ name: 'later' }) };
  expect(await all(reader, { kind: 'index', name: 'later' })).toEqual([]);
  await writer.publish(later);
  expect(await all(reader, { kind: 'index', name: 'later' })).toEqual([later.index]);
});

test('two package records with one name: one copy per contextId', async () => {
  const twin = { name: 'twin', version: '1.0.0', release: enc({ twin: 1 }), tarball: tgz('twin-1'), index: enc({ twin: 1 }) };
  await writer.publish(twin);
  // A second package record and its own index and release, as after a race of two publishes.
  const write = async (protocolPath: string, data: Uint8Array, o: { tags?: Record<string, string>; parentContextId?: string }) => {
    const type = protocolPath.split('/').at(-1) as 'package' | 'index' | 'release';
    const w = await RecordsWrite.create({
      protocol: DIDPKG_PROTOCOL, protocolPath, schema: protocolDefinition.types[type].schema, dataFormat: 'application/json', data, published: true, signer, ...o,
    });
    expect((await new HttpDwnRpcClient().sendDwnRequest({ dwnUrl: dwn.url, targetDid: fx.did, message: w.message, data })).status.code).toBe(202);
    return w.message;
  };
  const second = await write('package', enc({ name: 'twin' }), { tags: { name: 'twin' } });
  await write('package/index', enc({ twin: 2 }), { parentContextId: second.contextId });
  await write('package/release', enc({ twin: 2 }), { tags: { version: '1.0.0' }, parentContextId: second.contextId });
  const reader = dwnAdapter({ allowLoopback: true }).reader(endpoint(dwn.url), { fetch });
  const sorted = (list: Uint8Array[]) => list.map((b) => new TextDecoder().decode(b)).sort();
  expect(sorted(await all(reader, { kind: 'index', name: 'twin' }))).toEqual(['{"twin":1}', '{"twin":2}']);
  expect(sorted(await all(reader, { kind: 'release', name: 'twin', version: '1.0.0' }))).toEqual(['{"twin":1}', '{"twin":2}']);
  expect(await all(reader, { kind: 'tarball', name: 'twin', version: '1.0.0' })).toEqual([twin.tarball]);
});

/** A fetch that answers the query itself and sends each read to the server. */
function fakeQuery(reply: () => Response) {
  return counted(((url: string, init?: RequestInit) => (new URL(url).pathname.endsWith('/query') ? Promise.resolve(reply()) : fetch(url, init))) as typeof fetch);
}

test(`at most ${MAX_CONTEXTS} contextIds; a bad or repeated contextId is dropped`, async () => {
  const ids = ['bafy0', '../x', 5, null, ...Array.from({ length: 20 }, (_, i) => `bafy${i}`)];
  const { fetch, routes } = fakeQuery(() => Response.json({ status: { code: 200 }, entries: [null, ...ids.map((contextId) => ({ contextId }))] }));
  const read: string[] = [];
  const spy = ((url: string, init?: RequestInit) => (read.push(new URL(url).searchParams.get('filter.contextId') ?? 'query'), fetch(url, init))) as typeof fetch;
  const reader = dwnAdapter({ allowLoopback: true }).reader(endpoint(dwn.url), { fetch: spy });
  expect(await all(reader, { kind: 'index', name: NAME })).toEqual([]);
  expect(routes).toEqual(['query', ...Array(MAX_CONTEXTS).fill('package/index')]);
  expect(read).toEqual(['query', ...Array.from({ length: MAX_CONTEXTS }, (_, i) => `bafy${i}`)]);
});

test('a failed endpoint throws, and the failure is not kept', async () => {
  const bad = [
    [new Response('down', { status: 500 }), /query HTTP 500$/],
    [new Response('<html>'), /the query reply is not JSON$/],
    [Response.json({ status: { code: 401 }, entries: [] }), /bad query reply$/],
    [Response.json({ status: { code: 200 } }), /bad query reply$/],
  ] as const;
  for (const [response, error] of bad) {
    let failed = true;
    const { fetch } = fakeQuery(() => (failed ? (response.clone() as Response) : Response.json({ status: { code: 200 }, entries: [] })));
    const reader = dwnAdapter({ allowLoopback: true }).reader(endpoint(dwn.url), { fetch });
    await expect(all(reader, { kind: 'index', name: NAME })).rejects.toThrow(error);
    failed = false;
    expect(await all(reader, { kind: 'index', name: NAME })).toEqual([]);
  }
  const down = ((url: string, init?: RequestInit) => (url.includes('/read/') ? Promise.resolve(new Response('x', { status: 503 })) : fetch(url, init))) as typeof fetch;
  await expect(all(dwnAdapter({ allowLoopback: true }).reader(endpoint(dwn.url), { fetch: down }), { kind: 'release', name: NAME, version: '1.0.0' })).rejects.toThrow(/: HTTP 503$/);
  const reader = dwnAdapter({ allowLoopback: true }).reader(endpoint(dwn.url), { fetch });
  await expect(all(reader, { kind: 'tarball', name: NAME, version: '1.0.0' }, 10)).rejects.toThrow('larger than 10 bytes');
});
