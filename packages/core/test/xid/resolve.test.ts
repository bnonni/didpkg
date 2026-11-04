import { describe, expect, test } from 'bun:test';
import { memoryXidCache, resolveXid, XidError, xidDocumentUrl, type ResolveXidOptions } from '../../src/xid/index.ts';
import { docBytes } from './fixture.ts';
import golden from './golden.json';

const XID = golden.xid;
const A = 'https://a.example';
const B = 'https://b.example/base/';
const VIA = `https://mirror.example/xid/${XID}.envelope`;

/** A fake network: URL to response. The `calls` list keeps each GET URL and its Accept header. */
function net(routes: Record<string, Uint8Array | number>) {
  const calls: string[] = [];
  const fetch: ResolveXidOptions['fetch'] = async (url, init) => {
    calls.push(`${url} ${new Headers(init.headers).get('accept')}`);
    const r = routes[url];
    if (r === undefined) return new Response('no route', { status: 404 });
    return typeof r === 'number' ? new Response('', { status: r }) : new Response(r, { status: 200 });
  };
  return { fetch, calls };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof XidError ? e.code : `not a XidError: ${String(e)}`;
  }
  return 'no error';
}

test('xidDocumentUrl adds xid/<hex>.envelope to the base URL', () => {
  expect(xidDocumentUrl(A, XID)).toBe(`${A}/xid/${XID}.envelope`);
  expect(xidDocumentUrl(B, XID)).toBe(`${B}xid/${XID}.envelope`);
});

describe('resolveXid', () => {
  test('the document with the highest seq wins, and the cache keeps it', async () => {
    const { fetch, calls } = net({ [xidDocumentUrl(A, XID)]: docBytes(), [xidDocumentUrl(B, XID)]: docBytes({ seq: 2 }) });
    const cache = memoryXidCache();
    const r = await resolveXid(XID, { resolvers: [A, B], fetch, cache });
    expect([r.xid, r.provenance.seq, r.source]).toEqual([XID, 2, xidDocumentUrl(B, XID)]);
    expect(calls.sort()).toEqual([`${xidDocumentUrl(A, XID)} application/envelope+cbor`, `${xidDocumentUrl(B, XID)} application/envelope+cbor`]);
    expect(await cache.get(XID)).toEqual(docBytes({ seq: 2 }));
  });

  test('the dereferenceVia URL of the cached document is a source', async () => {
    const cache = memoryXidCache();
    await cache.put(XID, docBytes());
    const { fetch, calls } = net({ [VIA]: docBytes({ seq: 1 }) });
    const r = await resolveXid(XID, { fetch, cache });
    expect([r.provenance.seq, r.source, calls.length]).toEqual([1, VIA, 1]);
    expect(await cache.get(XID)).toEqual(docBytes({ seq: 1 }));
  });

  test('a lower seq than the cached seq is refused', async () => {
    const cache = memoryXidCache();
    await cache.put(XID, docBytes({ seq: 2 }));
    const { fetch } = net({ [VIA]: docBytes({ seq: 1 }), [xidDocumentUrl(A, XID)]: docBytes() });
    expect(await code(resolveXid(XID, { resolvers: [A], fetch, cache }))).toBe('XID_ROLLBACK');
    expect(await cache.get(XID)).toEqual(docBytes({ seq: 2 }));
  });

  test('another mark with the cached seq is refused', async () => {
    const cache = memoryXidCache();
    await cache.put(XID, docBytes({ seq: 1 }));
    const { fetch } = net({ [VIA]: docBytes({ seq: 1, date: new Date('2027-01-01T00:00:00Z') }) });
    expect(await code(resolveXid(XID, { fetch, cache }))).toBe('XID_FORK');
  });

  test('if no source gives a valid document, the cached document is the result', async () => {
    const cache = memoryXidCache();
    await cache.put(XID, docBytes({ seq: 1 }));
    const { fetch } = net({ [VIA]: 503 });
    const r = await resolveXid(XID, { fetch, cache });
    expect([r.provenance.seq, r.source]).toEqual([1, 'cache']);
  });

  test('a document for another XID is not valid', async () => {
    const { fetch } = net({ [xidDocumentUrl(A, XID)]: docBytes({ inception: 7 }) });
    expect(await code(resolveXid(XID, { resolvers: [A], fetch }))).toBe('XID_INVALID');
  });

  test.each([
    ['no resolver and no cache', [], {}, 'XID_NOT_FOUND'],
    ['HTTP 404 from each source', [A, B], {}, 'XID_NOT_FOUND'],
    ['HTTP 500 from a source', [A, B], { [xidDocumentUrl(A, XID)]: 500 }, 'XID_UNAVAILABLE'],
    ['bad bytes from a source', [A], { [xidDocumentUrl(A, XID)]: new Uint8Array([1, 2, 3]) }, 'XID_INVALID'],
  ] as const)('%s', async (_l, resolvers, routes, want) => {
    expect(await code(resolveXid(XID, { resolvers, fetch: net(routes).fetch }))).toBe(want);
  });

  test('an http resolver needs allowPrivateHosts', async () => {
    const http = 'http://127.0.0.1:1';
    const { fetch } = net({ [xidDocumentUrl(http, XID)]: docBytes() });
    expect(await code(resolveXid(XID, { resolvers: [http], fetch }))).toBe('XID_INVALID');
    expect((await resolveXid(XID, { resolvers: [http], fetch, allowPrivateHosts: true })).provenance.seq).toBe(0);
  });

  test('a bad XID is refused before a network call', async () => {
    const { fetch, calls } = net({});
    expect(await code(resolveXid(XID.toUpperCase(), { resolvers: [A], fetch }))).toBe('XID_INVALID');
    expect(calls).toEqual([]);
  });
});
