// The npm packument of a verified index (ADR 0003 section 8).
import { beforeAll, describe, expect, test } from 'bun:test';
import { format } from '../../src/name/index.ts';
import { buildPackument, type TarballUrlInput } from '../../src/source/index.ts';
import { contentDigest, sri, verifyIndex } from '../../src/trust/index.ts';
import { outcome } from '../trust/helpers.ts';
import { FakeResolver, MemReader, NAME, newKey, publish, reindex, tgz, type Key } from '../trust/sim.ts';

const did = 'did:web:pkg.example';
const installName = format(did, NAME);
const url = ({ installName, release }: TarballUrlInput) => `http://127.0.0.1:4873/${installName}/-/x-${release.version}.tgz`;
const resolver = new FakeResolver();
let k1: Key;

async function packument(reader: MemReader, tarballUrl = url) {
  const verified = await verifyIndex({ did, name: NAME, resolver, reader, trust: new Map() });
  return buildPackument({ verified, reader, tarballUrl });
}

/** A package with the given versions, in publish order. Each version gets its own publish time. */
async function host(versions: string[], npm: Record<string, Record<string, unknown>> = {}) {
  const reader = new MemReader();
  for (const [i, version] of versions.entries()) {
    await publish(reader, { did, version, tarball: tgz(version), signers: [k1.signer], created: `2026-10-0${i + 1}T10:00:00Z`, npm: npm[version] });
  }
  return reader;
}

beforeAll(async () => {
  k1 = await newKey(did, 'didpkg-1');
  resolver.set(did, [k1]);
});

describe('a package with each release status', () => {
  let reader: MemReader;

  beforeAll(async () => {
    reader = await host(['0.9.0', '1.0.0', '1.2.0', '1.1.0', '2.0.0', '2.1.0-beta.1'], {
      '1.2.0': { dependencies: { left: '^1.0.0' }, bin: { hello: 'cli.js' }, name: 'other', version: '9.9.9', dist: { tarball: 'https://evil.example/x.tgz' }, deprecated: 'old' },
    });
    await reindex(reader, {
      did, signers: [k1.signer],
      status: { '0.9.0': { status: 'revoked' }, '1.0.0': { status: 'deprecated', message: '' }, '1.1.0': { status: 'deprecated', message: 'use 1.2.0' }, '2.0.0': { status: 'yanked' } },
      distTags: { latest: '2.0.0', next: '2.1.0-beta.1', old: '0.9.0' },
    });
  });

  test('it lists the active and deprecated versions in SemVer order, and omits yanked and revoked versions', async () => {
    const p = await packument(reader);
    expect([p._id, p.name]).toEqual([installName, installName]);
    expect(Object.keys(p.versions)).toEqual(['1.0.0', '1.1.0', '1.2.0', '2.1.0-beta.1']);
    expect(p.time).toEqual({
      '1.0.0': '2026-10-02T10:00:00Z', '1.1.0': '2026-10-04T10:00:00Z', '1.2.0': '2026-10-03T10:00:00Z', '2.1.0-beta.1': '2026-10-06T10:00:00Z',
    });
  });

  test('each version is the signed npm fields plus name, version and dist; the index owns deprecated', async () => {
    const p = await packument(reader);
    const dist = async (version: string) => ({ integrity: await sri('sha512', tgz(version)), tarball: `http://127.0.0.1:4873/${installName}/-/x-${version}.tgz` });
    expect(p.versions['1.0.0']).toEqual({
      dependencies: {}, hasInstallScript: false, name: installName, version: '1.0.0', deprecated: 'deprecated', dist: await dist('1.0.0'),
    });
    expect(p.versions['1.1.0']?.deprecated).toBe('use 1.2.0');
    expect(p.versions['1.2.0']).toEqual({
      dependencies: { left: '^1.0.0' }, bin: { hello: 'cli.js' }, name: installName, version: '1.2.0', dist: await dist('1.2.0'),
    });
  });

  test('a dist-tag of an omitted version is dropped; latest is then the highest version with no prerelease', async () => {
    expect((await packument(reader))['dist-tags']).toEqual({ next: '2.1.0-beta.1', latest: '1.2.0' });
  });

  test('a listed latest stays, also if a higher version is listed', async () => {
    const copy = reader.clone();
    await reindex(copy, { did, signers: [k1.signer], distTags: { latest: '1.1.0' } });
    expect((await packument(copy))['dist-tags']).toEqual({ latest: '1.1.0' });
  });

  test('tarballUrl gets the install name, the verified release and the DID document, one time per listed version', async () => {
    const calls: TarballUrlInput[] = [];
    await packument(reader, (input) => (calls.push(input), 'u'));
    const index = (await reader.getIndex(did, NAME))!;
    expect(calls.map((c) => [c.installName, c.release.version, contentDigest(c.release), c.didDocument.id])).toEqual(
      ['1.0.0', '1.1.0', '1.2.0', '2.1.0-beta.1'].map((v) => [installName, v, index.releases[v]!.digest, did]),
    );
  });

  test('it does not read the manifest of a yanked or revoked version', async () => {
    const copy = reader.clone();
    copy.releases.delete(`${did}/${NAME}@2.0.0`);
    copy.releases.delete(`${did}/${NAME}@0.9.0`);
    expect(Object.keys((await packument(copy)).versions)).toEqual(['1.0.0', '1.1.0', '1.2.0', '2.1.0-beta.1']);
  });
});

describe('latest when no listed tag is left', () => {
  test('only prereleases: latest is the highest prerelease', async () => {
    const reader = await host(['1.0.0-rc.1', '1.0.0-rc.2']);
    await reindex(reader, { did, signers: [k1.signer], distTags: {} });
    expect((await packument(reader))['dist-tags']).toEqual({ latest: '1.0.0-rc.2' });
  });

  test('build metadata: equal precedence sorts by code unit, and a "-" in build metadata is not a prerelease', async () => {
    const reader = await host(['1.0.0+build-2', '1.1.0-rc.1', '1.0.0+build-1']);
    await reindex(reader, { did, signers: [k1.signer], distTags: {} });
    const p = await packument(reader);
    expect([Object.keys(p.versions), p['dist-tags']]).toEqual([['1.0.0+build-1', '1.0.0+build-2', '1.1.0-rc.1'], { latest: '1.0.0+build-2' }]);
  });

  test('no listed version: no versions and no dist-tags', async () => {
    const reader = await host(['1.0.0']);
    await reindex(reader, { did, signers: [k1.signer], status: { '1.0.0': { status: 'yanked' } } });
    expect(await packument(reader)).toEqual({ _id: installName, name: installName, 'dist-tags': {}, time: {}, versions: {} });
  });
});

describe('a hostile storage host', () => {
  let reader: MemReader;

  beforeAll(async () => {
    reader = await host(['1.0.0', '1.1.0', '1.2.0']);
  });

  test('a missing manifest fails the packument, so the host cannot hide one version', async () => {
    const copy = reader.clone();
    copy.releases.delete(`${did}/${NAME}@1.2.0`);
    expect(await outcome(() => packument(copy))).toBe('MANIFEST_MISSING');
  });

  test('a manifest that is not the signed manifest fails', async () => {
    const copy = reader.clone();
    const release = copy.releases.get(`${did}/${NAME}@1.1.0`)!;
    copy.releases.set(`${did}/${NAME}@1.1.0`, { ...release, npm: { scripts: { postinstall: 'curl evil' } } });
    expect(await outcome(() => packument(copy))).toBe('MANIFEST_DIGEST');
  });

  test('if more versions fail, the error of the lowest version is the result', async () => {
    const copy = reader.clone();
    copy.releases.delete(`${did}/${NAME}@1.0.0`);
    copy.releases.set(`${did}/${NAME}@1.2.0`, { ...copy.releases.get(`${did}/${NAME}@1.2.0`)!, npm: {} });
    expect(await outcome(() => packument(copy))).toBe('MANIFEST_MISSING');
    copy.releases.set(`${did}/${NAME}@1.0.0`, { ...reader.releases.get(`${did}/${NAME}@1.0.0`)!, npm: {} });
    copy.releases.delete(`${did}/${NAME}@1.2.0`);
    expect(await outcome(() => packument(copy))).toBe('MANIFEST_DIGEST');
  });

  test('a manifest proof by a method of another DID fails, as in the tarball route', async () => {
    const other = await newKey('did:web:other.example', 'didpkg-1');
    const copy = new MemReader();
    await publish(copy, { did, version: '1.0.0', tarball: tgz('1.0.0'), signers: [other.signer], indexSigners: [k1.signer] });
    expect(await outcome(() => packument(copy))).toBe('MANIFEST_SIGNATURE');
  });
});
