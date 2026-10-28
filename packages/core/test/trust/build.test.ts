// The publisher builders: checkVersion, latestOf, signRelease and signIndex.
import { expect, test } from 'bun:test';
import {
  checkVersion, contentDigest, latestOf, parseIndex, parseRelease, signIndex, signRelease, sri, verifyProof,
  type IndexEntry,
} from '../../src/trust/index.ts';
import { didDoc, newKey, tgz } from './sim.ts';

const did = 'did:example:pub';
const entry = (status: IndexEntry['status']): IndexEntry => ({ digest: `sha256-${'A'.repeat(43)}=`, status });

test('checkVersion: SemVer 2.0.0 with no build metadata', () => {
  for (const v of ['1.0.0', '1.0.0-beta.1', '0.0.0-a-b']) expect(() => checkVersion(v)).not.toThrow();
  expect(() => checkVersion('1.0.0+b')).toThrow('1.0.0+b: a version with build metadata is not published');
  expect(() => checkVersion('1.0.0-rc.1+b.2')).toThrow('build metadata');
  for (const v of ['1.0', 'v1.0.0', '01.0.0']) expect(() => checkVersion(v)).toThrow('not a SemVer 2.0.0 version');
});

test('latestOf: the highest live stable version, else the highest live prerelease', () => {
  expect(latestOf({ '1.0.0': entry('active'), '1.2.0': entry('deprecated'), '2.0.0-beta.1': entry('active'), '1.10.0': entry('yanked') })).toBe('1.2.0');
  expect(latestOf({ '1.0.0': entry('revoked'), '2.0.0-beta.1': entry('active'), '2.0.0-beta.2': entry('active') })).toBe('2.0.0-beta.2');
  expect(latestOf({ '1.0.0': entry('yanked') })).toBeUndefined();
});

test('signRelease and signIndex: the chain, the sequence, the tags and the proof', async () => {
  const key = await newKey(did, 'didpkg-1');
  const doc = didDoc(did, [key]);
  const r1 = await signRelease({ publisher: did, name: 'hello', version: '1.0.0', tarball: tgz('1'), npm: {}, head: null }, [key.signer]);
  expect(parseRelease(r1)).toMatchObject({ previous: null, dist: { integrity: await sri('sha512', tgz('1')), size: tgz('1').length } });
  expect(r1.published).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(r1.proof).toMatchObject({ created: r1.published, verificationMethod: key.vm });
  await verifyProof(r1, doc);

  const i1 = await signIndex({ publisher: did, name: 'hello', head: null, releases: { '1.0.0': { digest: contentDigest(r1), status: 'active' } } }, [key.signer]);
  expect(parseIndex(i1)).toMatchObject({ sequence: 1, previous: null, distTags: { latest: '1.0.0' } });
  await verifyProof(i1, doc);

  // Other tags stay. `latest` follows the release list, and a prerelease does not take it.
  const tagged = await signIndex({ publisher: did, name: 'hello', head: i1, distTags: { latest: '1.0.0', next: '1.0.0' } }, [key.signer]);
  const r2 = await signRelease({ publisher: did, name: 'hello', version: '2.0.0-beta.1', tarball: tgz('2'), npm: {}, head: tagged, published: '2026-10-28T12:00:00Z' }, [key.signer]);
  expect(r2.previous).toEqual({ version: '1.0.0', digest: contentDigest(r1) });
  expect(r2.proof).toMatchObject({ created: '2026-10-28T12:00:00Z' });
  const i3 = await signIndex({
    publisher: did, name: 'hello', head: tagged, releases: { ...tagged.releases, '2.0.0-beta.1': { digest: contentDigest(r2), status: 'active' } },
  }, [key.signer]);
  expect(i3).toMatchObject({ sequence: 3, previous: contentDigest(tagged), distTags: { next: '1.0.0', latest: '1.0.0' } });

  const revoked = await signIndex({ publisher: did, name: 'hello', head: i3, releases: { ...i3.releases, '1.0.0': { ...i3.releases['1.0.0']!, status: 'revoked' } } }, [key.signer]);
  expect(revoked.distTags).toEqual({ next: '1.0.0', latest: '2.0.0-beta.1' });
});
