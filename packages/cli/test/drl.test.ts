// `didpkg drl`: the checks of the shim for one version, then the URL of the signed tarball copy.
import { beforeEach, expect, test } from 'bun:test';
import { format } from '@didpkg/core/name';
import type { FoundTarball } from '@didpkg/core/source';
import { sri } from '@didpkg/core/trust';
import { FakeResolver, MemReader, NAME, newKey, publish, reindex, type Key } from '../../core/test/trust/sim.ts';
import { drl, type DrlOptions } from '../src/drl.ts';
import { DENYLIST } from '../src/shim/shim.ts';
import { npmTgz } from './tgz.ts';

const DID = 'did:web:example.com';
const INSTALL = format(DID, NAME);

let reader: MemReader;
let resolver: FakeResolver;
let key: Key;
/** false: the copy has no URL, as from a reader with no `copies`. */
let withUrl: boolean;

// A static mirror over the publisher store.
const source: DrlOptions['source'] = {
  getIndexes: (did, name) => reader.getIndexes(did, name),
  getRelease: (did, name, version) => reader.getRelease(did, name, version),
  async findTarball(did, name, version): Promise<FoundTarball | null> {
    const bytes = await reader.getTarball(did, name, version);
    if (!bytes) return null;
    const endpoint = { did, serviceId: `${did}#pkg`, type: 'DIDPackageRepository' as const, url: 'https://mirror.example/' };
    return { bytes, endpoint, ...(withUrl && { url: `https://mirror.example/${name}/${version}.tgz` }) };
  },
};
const run = (spec: string) => drl({ spec, resolver, source });

async function failure(spec: string): Promise<string> {
  try {
    await run(spec);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('no error');
}

beforeEach(async () => {
  reader = new MemReader();
  resolver = new FakeResolver();
  key = await newKey(DID, 'didpkg-1');
  resolver.set(DID, [key]);
  withUrl = true;
  for (const version of ['1.0.0', '1.1.0']) {
    await publish(reader, { did: DID, version, tarball: npmTgz({ name: NAME, version }), signers: [key.signer] });
  }
});

test('<install-name>@<version>: the URL of the signed copy and the signed sha512', async () => {
  const r = await run(`${INSTALL}@1.0.0`);
  expect(r).toEqual({
    did: DID, name: NAME, version: '1.0.0',
    url: `https://mirror.example/${NAME}/1.0.0.tgz`,
    endpoint: `${DID}#pkg`,
    integrity: await sri('sha512', reader.tarballs.get(`${DID}/${NAME}@1.0.0`)!),
    warnings: [],
  });
});

test('<install-name> with no version: the latest dist-tag of the signed index', async () => {
  expect((await run(INSTALL)).version).toBe('1.1.0');
  await reindex(reader, { did: DID, signers: [key.signer], distTags: { latest: '1.0.0' } });
  expect((await run(INSTALL)).version).toBe('1.0.0');
});

test('the policy errors of the shim, with their codes', async () => {
  await reindex(reader, { did: DID, signers: [key.signer], status: { '1.0.0': { status: 'yanked' } } });
  expect(await failure(`${INSTALL}@1.0.0`)).toStartWith('YANKED:');
  expect(await failure(`${INSTALL}@9.9.9`)).toStartWith('NOT_LISTED:');
  expect(await failure(`${format(DID, 'nope')}@1.0.0`)).toStartWith('INDEX_MISSING:');
  resolver.set(DID, [await newKey(DID, 'didpkg-1')]);
  expect(await failure(`${INSTALL}@1.1.0`)).toStartWith('INDEX_SIGNATURE:');
});

test('a DID error, a denied DID and a hash-form name', async () => {
  expect(await failure(`${format('did:web:example.org', NAME)}@1.0.0`)).toBe('did:web:example.org: NOT_FOUND');
  expect(await failure(`${format(DENYLIST[0]!, NAME)}@1.0.0`)).toBe(`DID_RESOLUTION: ${DENYLIST[0]} is on the denylist (SECURITY.md)`);
  expect(await failure(`@didpkg/hello__${'a'.repeat(51)}q@1.0.0`)).toBe('a hash-form name needs a DID binding');
});

test('a signed tarball of another package, and a copy with no URL, give no URL', async () => {
  await publish(reader, { did: DID, version: '1.2.0', tarball: npmTgz({ name: 'other', version: '1.2.0' }), signers: [key.signer] });
  expect(await failure(`${INSTALL}@1.2.0`)).toBe(`the tarball package.json is other@1.2.0, not ${NAME}@1.2.0`);
  withUrl = false;
  expect(await failure(`${INSTALL}@1.0.0`)).toBe(`no endpoint gives a URL for the tarball of ${NAME}@1.0.0`);
});
