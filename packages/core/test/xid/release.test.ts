// The release verifier for a XID publisher: Envelope records and indexes, the release key rules,
// elision and key rotation. The shared policy has its full tests in test/trust/policy.test.ts.
import { describe, expect, test } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { PrivateKeyBase } from '@blockchaincommons/components';
import type { Signer } from '@blockchaincommons/components';
import { releaseFields, type IndexEntry, type ReleaseReader, type TrustStore } from '../../src/trust/index.ts';
import {
  envelopeBytes, parseXidIndex, parseXidRelease, readXidDocument, signXidIndex, signXidObject, signXidRelease,
  verifyXidIndex, verifyXidRelease, xidContentDigest, type XidPkgIndex, type XidPkgRelease,
} from '../../src/xid/index.ts';
import { outcome } from '../trust/helpers.ts';
import { NAME, T0, tgz } from '../trust/sim.ts';
import { docBytes, privateKeys, toHex, type DocOptions } from './fixture.ts';

const INCEPTION = privateKeys(1);
const RELEASE = privateKeys(2);
const DWN = privateKeys(4);
const NEXT = privateKeys(5);
const STRANGER = PrivateKeyBase.from(new Uint8Array(32).fill(7)).ed25519PrivateKeys();

/** The publisher side and an untrusted host. It keeps the envelope bytes, as a static mirror does. */
class Publisher {
  doc: DocOptions = {};
  xid = readXidDocument(docBytes()).xid;
  head: XidPkgIndex | null = null;
  indexes: Uint8Array[] = [];
  releases = new Map<string, Uint8Array>();
  tarballs = new Map<string, Uint8Array>();

  resolver = { resolve: async () => readXidDocument(docBytes(this.doc)) };
  reader: ReleaseReader = {
    getIndexes: async () => this.indexes.slice(-1),
    getRelease: async (_p, _n, version) => this.releases.get(version) ?? null,
    getTarball: async (_p, _n, version) => this.tarballs.get(version) ?? null,
  };

  async release(version: string, signers: Signer[] = [RELEASE], indexSigners: Signer[] = signers): Promise<XidPkgRelease> {
    const tarball = tgz(version);
    const r = await signXidRelease({ publisher: this.xid, name: NAME, version, tarball, npm: { dependencies: {} }, head: this.head, published: T0 }, signers);
    this.put(r, tarball);
    this.reindex(indexSigners, { [version]: { digest: xidContentDigest(r), status: 'active' } });
    return r;
  }
  put(r: XidPkgRelease, tarball: Uint8Array, bytes = envelopeBytes(r)) {
    this.releases.set(r.version, bytes);
    this.tarballs.set(r.version, tarball);
  }
  reindex(signers: Signer[], add: Record<string, IndexEntry> = {}): XidPkgIndex {
    this.head = signXidIndex({ publisher: this.xid, name: NAME, head: this.head, releases: { ...this.head?.releases, ...add }, updated: T0 }, signers);
    this.indexes.push(envelopeBytes(this.head));
    return this.head;
  }
  verify(version: string, trust: TrustStore = new Map()) {
    return verifyXidRelease({ xid: this.xid, name: NAME, version, resolver: this.resolver, reader: this.reader, trust });
  }
}

describe('XID release records and indexes', () => {
  test('a record signed by the release key installs', async () => {
    const p = new Publisher();
    const r = await p.release('1.0.0');
    const v = await p.verify('1.0.0');
    expect([v.continuity, v.manifestKey, v.index.sequence, v.release.version, v.xidDocument.xid]).toEqual(['first-use', 'current-key', 1, '1.0.0', p.xid]);
    expect(v.tarball).toEqual(tgz('1.0.0'));
    expect(v.index.releases['1.0.0']!.digest).toBe(xidContentDigest(r));
  });

  test('the envelope form keeps each member and the publish order', async () => {
    const p = new Publisher();
    const first = await p.release('1.1.0');
    const second = await p.release('1.0.1');
    const { envelope: _e, ...fields } = parseXidRelease(envelopeBytes(second));
    expect(fields).toEqual({
      type: 'DidPkgRelease', specVersion: '1', publisher: p.xid, name: NAME, version: '1.0.1', published: T0,
      dist: second.dist, npm: { dependencies: {} }, previous: { version: '1.1.0', digest: xidContentDigest(first) },
    });
    const index = parseXidIndex(envelopeBytes(p.head!));
    expect(Object.keys(index.releases)).toEqual(['1.1.0', '1.0.1']);
    expect([index.sequence, index.distTags, xidContentDigest(index)]).toEqual([2, { latest: '1.1.0' }, xidContentDigest(p.head!)]);
  });

  test('the bytes are the same on each run', async () => {
    const p = new Publisher();
    const r = await p.release('1.0.0');
    expect(xidContentDigest(r)).toBe('sha256-lsa4U36e6h6HEGjifZJsolp5fJE1LG7yCzoLsG4aORw=');
    expect(toHex(sha256(envelopeBytes(p.head!)))).toBe('85eff9f88cbb7d002656ebc9c998c28f954a39245859f7916e02afa4f1d2e462');
  });

  test('a key with no Sign privilege, or a key that is not in the document, fails', async () => {
    for (const key of [DWN, STRANGER]) {
      const p = new Publisher();
      await p.release('1.0.0', [RELEASE], [key]);
      expect(await outcome(() => p.verify('1.0.0'))).toBe('INDEX_SIGNATURE');
    }
  });

  test('a signature by the inception key fails, also next to a release key signature', async () => {
    for (const signers of [[INCEPTION], [RELEASE, INCEPTION]]) {
      const p = new Publisher();
      await p.release('1.0.0', [RELEASE], signers);
      expect(await outcome(() => p.verify('1.0.0'))).toBe('INDEX_SIGNATURE');
    }
    const p = new Publisher();
    await p.release('1.0.0', [INCEPTION], [RELEASE]);
    expect(await outcome(() => p.verify('1.0.0'))).toBe('MANIFEST_SIGNATURE');
  });

  test('a record with an elided assertion installs, and the digest is the same', async () => {
    const p = new Publisher();
    const tarball = tgz('1.0.0');
    const fields = await releaseFields({ publisher: p.xid, name: NAME, version: '1.0.0', tarball, npm: {}, head: null, published: T0 });
    const r = signXidObject({ ...fields, buildHost: 'private' }, [RELEASE]);
    const elided = r.envelope.elide({ removing: [r.envelope.unwrap().assertionWithPredicate('buildHost')] });
    p.put(r, tarball, elided.toCbor().toData());
    p.reindex([RELEASE], { '1.0.0': { digest: xidContentDigest(r), status: 'active' } });
    const v = await p.verify('1.0.0');
    expect([v.manifestKey, v.release.buildHost, xidContentDigest(v.release)]).toEqual(['current-key', undefined, xidContentDigest(r)]);
  });

  test('a record with an elided member that the schema needs fails', async () => {
    for (const member of ['npm', 'version']) {
      const p = new Publisher();
      const r = await p.release('1.0.0');
      const target = r.envelope.unwrap().assertionWithPredicate(member);
      p.put(r, tgz('1.0.0'), r.envelope.elide({ removing: [member === 'npm' ? target : target.object()] }).toCbor().toData());
      expect(await outcome(() => p.verify('1.0.0'))).toBe('MANIFEST_SCHEMA');
    }
  });

  test('a rotation needs a signature by the old key and the new key', async () => {
    const p = new Publisher();
    await p.release('1.0.0');
    const trust: TrustStore = new Map();
    await p.verify('1.0.0', trust);
    p.doc = { release: 5, seq: 1 };
    await p.release('1.1.0', [NEXT]);
    expect(await outcome(() => p.verify('1.1.0', trust))).toBe('KEY_CHANGED');
    p.reindex([NEXT, RELEASE]);
    const v = await p.verify('1.1.0', trust);
    expect([v.continuity, (await p.verify('1.0.0', trust)).manifestKey]).toEqual(['co-signed', 'index']);
    expect(trust.get(`${p.xid}/${NAME}`)!.keys).toHaveLength(2);
  });

  test('a lower sequence of the pinned key is a rollback', async () => {
    const p = new Publisher();
    await p.release('1.0.0');
    const old = p.indexes[0]!;
    const trust: TrustStore = new Map();
    await p.reindex([RELEASE]);
    await p.verify('1.0.0', trust);
    p.indexes.push(old);
    expect(await outcome(() => p.verify('1.0.0', trust))).toBe('ROLLBACK');
  });

  test('a host cannot change the record, the publisher or the object kind', async () => {
    const p = new Publisher();
    await p.release('1.0.0');
    const other = await signXidRelease({ publisher: p.xid, name: NAME, version: '1.0.0', tarball: tgz('x'), npm: {}, head: null, published: T0 }, [RELEASE]);
    p.put(other, tgz('x'));
    expect(await outcome(() => p.verify('1.0.0'))).toBe('MANIFEST_DIGEST');

    const q = new Publisher();
    await q.release('1.0.0');
    const foreign = new Publisher();
    foreign.doc = { inception: 6 };
    foreign.xid = readXidDocument(docBytes(foreign.doc)).xid;
    await foreign.release('1.0.0');
    q.indexes.push(foreign.indexes[0]!);
    expect(await outcome(() => q.verify('1.0.0'))).toBe('INDEX_FIELDS');

    for (const bad of [new TextEncoder().encode('{"type":"DidPkgIndex"}'), q.indexes[0]!.slice(0, 40)]) {
      q.indexes = [bad];
      expect(await outcome(() => q.verify('1.0.0'))).toBe('INDEX_SCHEMA');
    }
  });

  test('the index must name the requested XID', async () => {
    const p = new Publisher();
    await p.release('1.0.0');
    const v = await verifyXidIndex({ xid: p.xid, name: NAME, resolver: p.resolver, reader: p.reader, trust: new Map() });
    expect([v.index.publisher, v.epochKey.length > 64]).toEqual([p.xid, true]);
  });
});
