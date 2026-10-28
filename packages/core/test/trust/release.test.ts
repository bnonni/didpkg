import { beforeAll, expect, test } from 'bun:test';
import { contentDigest, parseIndex, parseRelease, proofsOf, signObject, type DidPkgIndex, type DidPkgRelease } from '../../src/trust/index.ts';
import { failure, outcome } from './helpers.ts';
import { MemReader, NAME, newKey, publish, tgz, type Key } from './sim.ts';

const did = 'did:web:pkg.example';
let k1: Key, k2: Key;
let release: DidPkgRelease, index: DidPkgIndex;

beforeAll(async () => {
  [k1, k2] = [await newKey(did, 'didpkg-1'), await newKey(did, 'didpkg-2')];
  const reader = new MemReader();
  index = await publish(reader, { did, version: '1.0.0', tarball: tgz('a'), signers: [k1.signer] });
  release = reader.releases.get(`${did}/${NAME}@1.0.0`)!;
});

const change = <T>(object: T, edit: (copy: Record<string, any>) => void): unknown => {
  const copy = structuredClone(object) as Record<string, any>;
  edit(copy);
  return copy;
};

test('parseRelease and parseIndex give the same object, so the digest covers each member', () => {
  expect(parseRelease(release)).toBe(release);
  expect(parseIndex(index)).toBe(index);
  // A v1 reader accepts an unknown member, and the digest changes with it.
  const extra = change(release, (m) => (m.future = 1));
  expect(contentDigest(parseRelease(extra))).not.toBe(contentDigest(release));
});

test('parseRelease rejects a bad member', async () => {
  const bad = [
    change(release, (m) => delete m.publisher),
    change(release, (m) => (m.type = 'DidPkgIndex')),
    change(release, (m) => (m.specVersion = '2')),
    change(release, (m) => (m.version = '1.0')),
    change(release, (m) => (m.published = '2026-10-23 10:00')),
    change(release, (m) => (m.dist.integrity = 'sha256-abc')),
    change(release, (m) => (m.dist.size = -1)),
    change(release, (m) => (m.npm = null)),
    change(release, (m) => (m.previous = { version: '0.9.0' })),
    change(release, (m) => (m.proof = [])),
    'not an object',
  ];
  for (const value of bad) expect(await outcome(() => parseRelease(value))).toBe('MANIFEST_SCHEMA');
});

test('parseIndex rejects a bad member', async () => {
  const bad = [
    change(index, (ix) => (ix.sequence = 0)),
    change(index, (ix) => (ix.previous = 'sha256-short')),
    change(index, (ix) => (ix.releases['1.0.0'].status = 'deleted')),
    change(index, (ix) => (ix.releases['latest'] = ix.releases['1.0.0'])),
    change(index, (ix) => (ix.distTags = { latest: '9.9.9' })), // a tag must point to a listed version
    change(index, (ix) => delete ix.proof),
  ];
  for (const value of bad) expect(await outcome(() => parseIndex(value))).toBe('INDEX_SCHEMA');
});

test('signObject: two signers give a proof set, and the digest does not change', async () => {
  const one = await signObject(index, [k1.signer]);
  const two = await signObject(index, [k2.signer, k1.signer]);
  expect(proofsOf(two).map((p) => p.verificationMethod)).toEqual([k2.vm, k1.vm]);
  expect(contentDigest(two)).toBe(contentDigest(one));
  expect(await failure(() => signObject(index, []))).toBe('PROOF_GENERATION_ERROR malformed-proof');
});
