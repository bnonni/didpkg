import { expect, test } from 'bun:test';
import { DID_ERROR_NS, failure } from '../../src/did/errors.ts';
import { DidResolver } from '../../src/did/resolver.ts';
import type { DidDocument, DidMethodDriver, DidResolutionResult } from '../../src/did/types.ts';

const DID = 'did:test:abc';
const doc = (id = DID): DidDocument => ({ id, verificationMethod: [] });
const ok = (d: DidDocument | null = doc(), meta = {}): DidResolutionResult => ({ didResolutionMetadata: {}, didDocument: d, didDocumentMetadata: meta });
const code = (r: DidResolutionResult) => r.didResolutionMetadata.error?.type.slice(DID_ERROR_NS.length);

/** A driver that answers from a queue, or from a function. It counts its calls. */
function testDriver(answer: (did: string) => DidResolutionResult | Promise<DidResolutionResult>, extra: Partial<DidMethodDriver> = {}) {
  const d = {
    method: 'test',
    verification: 'cryptographic' as const,
    history: false,
    freshMs: 1000,
    calls: 0,
    async resolve(did: string) {
      d.calls++;
      return answer(did);
    },
    ...extra,
  };
  return d;
}

test('an invalid DID, an unsupported method and bad options give W3C type URLs', async () => {
  const r = new DidResolver({ drivers: [testDriver(() => ok())] });
  expect((await r.resolve('did:Bad:1')).didResolutionMetadata.error?.type).toBe('https://www.w3.org/ns/did#INVALID_DID');
  expect(code(await r.resolve('not a did'))).toBe('INVALID_DID');
  expect(code(await r.resolve(42 as never))).toBe('INVALID_DID');
  expect(code(await r.resolve('did:test:a%zz'))).toBe('INVALID_DID');
  expect(code(await r.resolve('did:other:1'))).toBe('METHOD_NOT_SUPPORTED');
  expect(code(await r.resolve(DID, { versionId: '1', versionTime: '2026-01-01T00:00:00Z' }))).toBe('INVALID_OPTIONS');
  expect(code(await r.resolve(DID, { versionTime: '2026-01-01' }))).toBe('INVALID_OPTIONS');
  expect(code(await r.resolve(DID, { versionTime: '2026-13-01T00:00:00Z' }))).toBe('INVALID_OPTIONS');
  expect(code(await r.resolve(DID, { versionId: '' }))).toBe('INVALID_OPTIONS');
  expect(code(await r.resolve(DID, { versionId: '1' }))).toBe('FEATURE_NOT_SUPPORTED');
  expect(code(await r.resolve(DID, { versionTime: '2026-01-01T00:00:00Z' }))).toBe('FEATURE_NOT_SUPPORTED');
  expect(code(await r.resolve(DID, { accept: 'text/html' }))).toBe('REPRESENTATION_NOT_SUPPORTED');
  const failed = await r.resolve('did:other:1');
  expect(failed.didDocument).toBeNull();
  expect(failed.didResolutionMetadata.error?.title).toBe('METHOD_NOT_SUPPORTED');
});

test('a driver with history gets the version options', async () => {
  const seen: unknown[] = [];
  const driver: DidMethodDriver = { method: 'test', verification: 'cryptographic', history: true, freshMs: 0, async resolve(_d, o) { seen.push(o); return ok(); } };
  const r = new DidResolver({ drivers: [driver] });
  expect(code(await r.resolve(DID, { versionId: '7' }))).toBeUndefined();
  expect(seen).toEqual([{ versionId: '7' }]);
});

test('a driver that returns the document of another DID gives INVALID_DID_DOCUMENT', async () => {
  const r = new DidResolver({ drivers: [testDriver(() => ok(doc('did:test:other')))] });
  const res = await r.resolve(DID);
  expect(code(res)).toBe('INVALID_DID_DOCUMENT');
  expect(res.didDocument).toBeNull();
  const none = new DidResolver({ drivers: [testDriver(() => ok(null))] });
  expect(code(await none.resolve(DID))).toBe('INVALID_DID_DOCUMENT');
  const array = new DidResolver({ drivers: [testDriver(() => ok([] as never))] });
  expect(code(await array.resolve(DID))).toBe('INVALID_DID_DOCUMENT');
});

test('a deactivated DID gives no document and deactivated: true', async () => {
  const r = new DidResolver({ drivers: [testDriver(() => ok(doc(), { deactivated: true }))] });
  const res = await r.resolve(DID);
  expect(res.didResolutionMetadata.error).toBeUndefined();
  expect(res.didDocument).toBeNull();
  expect(res.didDocumentMetadata.deactivated).toBe(true);
});

test('a driver error keeps its code, gets a W3C type and loses its document', async () => {
  const r = new DidResolver({
    drivers: [testDriver(() => ({ didResolutionMetadata: { error: { type: 'https://example.com/odd', detail: 'x' } }, didDocument: doc(), didDocumentMetadata: {} }))],
  });
  const res = await r.resolve(DID);
  expect(res.didResolutionMetadata.error).toEqual({ type: DID_ERROR_NS + 'INTERNAL_ERROR', title: 'INTERNAL_ERROR', detail: 'x' });
  expect(res.didDocument).toBeNull();
});

test('a driver that throws or returns nothing gives INTERNAL_ERROR', async () => {
  const thrower = new DidResolver({ drivers: [testDriver(() => { throw Object.assign(new Error('bad sig'), { code: 'invalidSignature' }); })] });
  expect(code(await thrower.resolve(DID))).toBe('INVALID_DID_DOCUMENT');
  const sync = new DidResolver({ drivers: [{ ...testDriver(() => ok()), resolve: () => { throw new Error('sync'); } }] });
  expect(code(await sync.resolve(DID))).toBe('INTERNAL_ERROR');
  const empty = new DidResolver({ drivers: [testDriver(() => undefined as never)] });
  expect(code(await empty.resolve(DID))).toBe('INTERNAL_ERROR');
});

test('the time limit per DID gives a transient INTERNAL_ERROR and aborts the driver', async () => {
  let aborted = false;
  const driver: DidMethodDriver = {
    method: 'test', verification: 'cryptographic', history: false, freshMs: 0,
    resolve: (_d, _o, ctx) => new Promise(() => ctx.signal.addEventListener('abort', () => { aborted = true; })),
  };
  const r = new DidResolver({ drivers: [driver], timeoutMs: 30 });
  const res = await r.resolve(DID);
  expect(code(res)).toBe('INTERNAL_ERROR');
  expect(res.didResolutionMetadata.transient).toBe(true);
  expect(aborted).toBe(true);
});

test('the success metadata: contentType, retrieved, verification', async () => {
  const r = new DidResolver({ drivers: [testDriver(() => ok({ ...doc(), '@context': 'https://www.w3.org/ns/did/v1' }))], now: () => Date.UTC(2026, 9, 27, 21, 30, 0, 123) });
  const res = await r.resolve(DID);
  expect(res.didResolutionMetadata).toEqual({ contentType: 'application/did', retrieved: '2026-10-27T21:30:00Z', verification: 'cryptographic' });
  expect((await r.resolve(DID, { accept: 'application/did+ld+json; q=1' })).didResolutionMetadata.contentType).toBe('application/did+ld+json');
  const noContext = new DidResolver({ drivers: [testDriver(() => ok())] });
  expect(code(await noContext.resolve(DID, { accept: 'application/did+ld+json' }))).toBe('REPRESENTATION_NOT_SUPPORTED');
  expect((await noContext.resolve(DID, { accept: 'application/did+json' })).didResolutionMetadata.contentType).toBe('application/did+json');
});

test('cache: a fresh hit does not call the driver; noCache does', async () => {
  let t = 0;
  const driver = testDriver(() => ok());
  const r = new DidResolver({ drivers: [driver], now: () => t });
  await r.resolve(DID);
  await r.resolve(DID);
  expect(driver.calls).toBe(1);
  await r.resolve(DID, { noCache: true });
  expect(driver.calls).toBe(2);
  t = 999;
  await r.resolve(DID);
  expect(driver.calls).toBe(2);
  t = 2000; // fresh until 1000 + 1000
  await r.resolve(DID);
  expect(driver.calls).toBe(3);
  r.clearCache();
  await r.resolve(DID);
  expect(driver.calls).toBe(4);
});

test('single-flight: concurrent calls share one driver call', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const driver = testDriver(async () => {
    await gate;
    return ok();
  });
  const r = new DidResolver({ drivers: [driver] });
  const all = Promise.all([r.resolve(DID), r.resolve(DID), r.resolve(DID, { accept: 'application/did+json' })]);
  release();
  const results = await all;
  expect(driver.calls).toBe(1);
  expect(results.map((x) => x.didResolutionMetadata.contentType)).toEqual(['application/did', 'application/did', 'application/did+json']);
});

test('each call gets a copy, so a caller cannot change the cache', async () => {
  const r = new DidResolver({ drivers: [testDriver(() => ok())] });
  const a = await r.resolve(DID);
  a.didDocument!.id = 'did:test:changed';
  a.didDocument!.verificationMethod!.push({ id: '#x', type: 'Multikey', controller: DID });
  const b = await r.resolve(DID);
  expect(b.didDocument).toEqual(doc());
});

test('stale-if-error: a transient failure uses the stale entry; a definite failure does not', async () => {
  let t = 0;
  let answer: DidResolutionResult = ok();
  const driver = testDriver(() => answer);
  const r = new DidResolver({ drivers: [driver], staleIfErrorMs: 5000, now: () => t });
  await r.resolve(DID);
  answer = failure('INTERNAL_ERROR', 'relay down', { transient: true });
  t = 3000; // stale, inside the stale-if-error window (until 6000)
  const stale = await r.resolve(DID);
  expect(stale.didDocument).toEqual(doc());
  expect(stale.didResolutionMetadata.stale).toBe(true);
  t = 7000; // after the window
  expect(code(await r.resolve(DID))).toBe('INTERNAL_ERROR');

  t = 0;
  answer = ok();
  await r.resolve(DID, { noCache: true });
  answer = failure('NOT_FOUND');
  t = 3000;
  expect(code(await r.resolve(DID))).toBe('NOT_FOUND');
  answer = failure('INTERNAL_ERROR', 'down', { transient: true });
  expect(code(await r.resolve(DID))).toBe('INTERNAL_ERROR'); // NOT_FOUND removed the entry
});

test('stale-if-error is off by default (publish)', async () => {
  let t = 0;
  let answer: DidResolutionResult = ok();
  const r = new DidResolver({ drivers: [testDriver(() => answer)], now: () => t });
  await r.resolve(DID);
  answer = failure('INTERNAL_ERROR', 'down', { transient: true });
  t = 1001;
  expect(code(await r.resolve(DID))).toBe('INTERNAL_ERROR');
});

test('a deactivation replaces a cached document', async () => {
  let t = 0;
  let answer: DidResolutionResult = ok();
  const r = new DidResolver({ drivers: [testDriver(() => answer)], staleIfErrorMs: 1e9, now: () => t });
  await r.resolve(DID);
  answer = ok(null, { deactivated: true });
  t = 2000;
  const res = await r.resolve(DID);
  expect([res.didDocument, res.didDocumentMetadata.deactivated]).toEqual([null, true]);
  answer = failure('INTERNAL_ERROR', 'down', { transient: true });
  t = 4000;
  const stale = await r.resolve(DID);
  expect([stale.didDocument, stale.didDocumentMetadata.deactivated, stale.didResolutionMetadata.stale]).toEqual([null, true, true]);
});

test('two drivers for one method is a configuration error', () => {
  expect(() => new DidResolver({ drivers: [testDriver(() => ok()), testDriver(() => ok())] })).toThrow('two drivers for did:test');
  expect(new DidResolver({ drivers: [testDriver(() => ok())] }).methods).toEqual(['test']);
});
