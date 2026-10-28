// The shim handler on the core test publisher: the HTTP results of PLAN.md and ADR 0003 section 5.
import { beforeEach, describe, expect, test } from 'bun:test';
import { format } from '@didpkg/core/name';
import { SourceError } from '@didpkg/core/source';
import { contentDigest, type Pin } from '@didpkg/core/trust';
import { FakeResolver, MemReader, NAME, newKey, publish, reindex, type Key } from '../../core/test/trust/sim.ts';
import { DENYLIST, shimHandler, type ShimOptions } from '../src/shim/shim.ts';
import { npmTgz } from './tgz.ts';

const DID = 'did:web:example.com';
const INSTALL = format(DID, NAME);
const ORIGIN = 'http://127.0.0.1:2092';
const enc = new TextEncoder();

let reader: MemReader;
let resolver: FakeResolver;
let key: Key;
let lines: string[];
let shim: (req: Request) => Promise<Response>;

const make = (o: Partial<ShimOptions> = {}) =>
  shimHandler({ origin: ORIGIN, resolver, source: reader, trust: new Map<string, Pin>(), log: (l) => lines.push(l), ...o });
const get = (path: string, method = 'GET') => shim(new Request(`${ORIGIN}${path}`, { method }));
const tarballPath = (version: string, query = '') => `/${INSTALL}/-/${INSTALL.slice('@didpkg/'.length)}-${version}.tgz${query}`;
const rec = (version: string) => `?rec=${encodeURIComponent(contentDigest(reader.releases.get(`${DID}/${NAME}@${version}`)!))}`;
const error = async (r: Response) => ((await r.json()) as { error: string }).error;

beforeEach(async () => {
  reader = new MemReader();
  resolver = new FakeResolver();
  key = await newKey(DID, 'didpkg-1');
  resolver.set(DID, [key]);
  lines = [];
  shim = make();
  for (const version of ['1.0.0', '1.1.0']) {
    await publish(reader, { did: DID, version, tarball: npmTgz({ name: NAME, version }), signers: [key.signer] });
  }
});

describe('packument route', () => {
  test('200: the verified versions, with tarball URLs that hold only signed release facts', async () => {
    const r = await get(`/${INSTALL}`);
    expect(r.status).toBe(200);
    const p = (await r.json()) as { name: string; 'dist-tags': Record<string, string>; versions: Record<string, { dist: { tarball: string } }> };
    expect(p.name).toBe(INSTALL);
    expect(p['dist-tags']).toEqual({ latest: '1.1.0' });
    const url = new URL(p.versions['1.0.0']!.dist.tarball);
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}${tarballPath('1.0.0')}`);
    expect(`?${url.searchParams}`.startsWith(rec('1.0.0'))).toBe(true);
    expect([...url.searchParams.keys()]).toEqual(['rec', 'vm']);
    expect(url.searchParams.get('vm')).toBe(key.vm);
    expect(lines).toEqual([`GET /${INSTALL} 200`]);
  });

  test('the scope slash can be %2f, and HEAD works', async () => {
    expect((await get(`/@didpkg%2f${INSTALL.slice('@didpkg/'.length)}`)).status).toBe(200);
    expect((await get(`/${INSTALL}`, 'HEAD')).status).toBe(200);
  });

  test('the tarball URL of a version does not change after a key rotation', async () => {
    const before = ((await (await get(`/${INSTALL}`)).json()) as { versions: Record<string, { dist: { tarball: string } }> }).versions;
    const next = await newKey(DID, 'didpkg-2');
    resolver.set(DID, [next]);
    await reindex(reader, { did: DID, signers: [next.signer, key.signer] });
    const after = ((await (await make()(new Request(`${ORIGIN}/${INSTALL}`))).json()) as { versions: typeof before }).versions;
    expect(after['1.0.0']!.dist.tarball).toBe(before['1.0.0']!.dist.tarball);
  });
});

describe('tarball route', () => {
  test('200: the exact signed bytes', async () => {
    const r = await get(tarballPath('1.0.0', rec('1.0.0')));
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array(reader.tarballs.get(`${DID}/${NAME}@1.0.0`)!));
  });

  test('a yanked version: 403 without a lockfile pin, 200 with it', async () => {
    const pin = rec('1.0.0');
    await reindex(reader, { did: DID, signers: [key.signer], status: { '1.0.0': { status: 'yanked' } } });
    expect(await error(await get(tarballPath('1.0.0')))).toStartWith('YANKED:');
    expect((await get(tarballPath('1.0.0', pin))).status).toBe(200);
    expect(lines.at(-2)).toStartWith('  warn YANKED:');
  });

  test('403: revoked, a lockfile record that is not the signed release, a tarball of another package', async () => {
    await publish(reader, { did: DID, version: '1.2.0', tarball: npmTgz({ name: 'other', version: '1.2.0' }), signers: [key.signer] });
    await reindex(reader, { did: DID, signers: [key.signer], status: { '1.0.0': { status: 'revoked' } } });
    const revoked = await get(tarballPath('1.0.0'));
    expect(revoked.status).toBe(403);
    expect(await error(revoked)).toStartWith('REVOKED:');
    const swapped = await get(tarballPath('1.1.0', rec('1.0.0')));
    expect(swapped.status).toBe(403);
    expect(await error(swapped)).toStartWith('HISTORY_CHANGED:');
    const other = await get(tarballPath('1.2.0'));
    expect(other.status).toBe(403);
    expect(await error(other)).toBe('the tarball package.json is other@1.2.0, not hello@1.2.0');
  });

  test('403: a signed tarball that is not a gzip tar', async () => {
    await publish(reader, { did: DID, version: '1.2.0', tarball: enc.encode('not a tgz'), signers: [key.signer] });
    const r = await get(tarballPath('1.2.0'));
    expect(r.status).toBe(403);
    expect(await error(r)).toStartWith('the signed tarball is not an npm pack tarball');
  });
});

describe('HTTP results', () => {
  test('400: the name fails parse()', async () => {
    expect((await get('/@didpkg/HELLO_web_example.com')).status).toBe(400);
  });

  test('403: a denylisted DID, also before resolution', async () => {
    const r = await make({ denylist: [DID] })(new Request(`${ORIGIN}/${INSTALL}`));
    expect(r.status).toBe(403);
    expect(await error(r)).toBe(`DID_RESOLUTION: ${DID} is on the denylist (SECURITY.md)`);
    expect(DENYLIST).toHaveLength(2);
    const denied = format(DENYLIST[0]!, NAME);
    expect((await get(`/${denied}`)).status).toBe(403);
  });

  test('403: a deactivated DID and a bad index proof', async () => {
    resolver.set(DID, [key], true);
    expect(await error(await get(`/${INSTALL}`))).toStartWith('DID_DEACTIVATED:');
    resolver.set(DID, [await newKey(DID, 'didpkg-1')]);
    expect(await error(await get(`/${INSTALL}`))).toStartWith('INDEX_SIGNATURE:');
  });

  test('404: unknown DID, package and version, a hash-form name, a non-didpkg path and attestations', async () => {
    expect((await get(`/${format('did:web:example.org', NAME)}`)).status).toBe(404);
    expect(await error(await get(`/${format(DID, 'nope')}`))).toStartWith('INDEX_MISSING:');
    const unlisted = await get(tarballPath('9.9.9'));
    expect(unlisted.status).toBe(404);
    expect(await error(unlisted)).toStartWith('NOT_LISTED:');
    reader.tarballs.delete(`${DID}/${NAME}@1.0.0`);
    const lost = await get(tarballPath('1.0.0'));
    expect(lost.status).toBe(404);
    expect(await error(lost)).toStartWith('TARBALL_MISSING:');
    expect(await error(await get(`/@didpkg/hello__${'a'.repeat(51)}q`))).toBe('a hash-form name needs a DID binding (Phase 2)');
    expect((await get('/left-pad')).status).toBe(404);
    expect((await get(`/-/npm/v1/attestations/${INSTALL}@1.0.0`)).status).toBe(404);
  });

  test('405: publish and other methods', async () => {
    expect((await get(`/${INSTALL}`, 'PUT')).status).toBe(405);
    expect((await get(tarballPath('1.0.0'), 'DELETE')).status).toBe(405);
  });

  test('502: no endpoint gave usable bytes, or the DID method failed', async () => {
    const down = Object.assign(reader.clone(), {
      getIndexes: async () => { throw new SourceError('UNAVAILABLE', 'no endpoint gave the index of hello'); },
    });
    const r = await make({ source: down })(new Request(`${ORIGIN}/${INSTALL}`));
    expect(r.status).toBe(502);
    expect(await error(r)).toBe('UNAVAILABLE: no endpoint gave the index of hello');
    const failing = { resolve: async () => ({ didDocument: null, didDocumentMetadata: {}, didResolutionMetadata: { error: { type: 'https://www.w3.org/ns/did#INTERNAL_ERROR' } } }) };
    expect((await make({ resolver: failing })(new Request(`${ORIGIN}/${INSTALL}`))).status).toBe(502);
  });

  test('500: a defect, with the message', async () => {
    const broken = Object.assign(reader.clone(), { getIndexes: async () => { throw new TypeError('defect'); } });
    const r = await make({ source: broken })(new Request(`${ORIGIN}/${INSTALL}`));
    expect(r.status).toBe(500);
    expect(await error(r)).toBe('defect');
  });
});
