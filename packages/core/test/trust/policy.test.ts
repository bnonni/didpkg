// Trust policy v1 under key rotation, compromise, yank, revoke, rollback and a hostile storage host.
// A port of the spike script research/phase3/did-trust-model/06-rotation-revocation.ts. The spike
// scenarios C1 and I used a resolver with method history (L3, Phase 3). Here a co-signed rotation
// (L2) replaces C1, and the other scenarios use a resolver with the current document only.
import { beforeAll, describe, expect, test } from 'bun:test';
import { verifyRelease, type PolicyMode, type TrustStore } from '../../src/trust/index.ts';
import { outcome } from './helpers.ts';
import { FakeResolver, MemReader, NAME, newKey, publish, reindex, tgz, type Key } from './sim.ts';

const verify = (o: { did: string; version: string; resolver: FakeResolver; reader: MemReader; trust: TrustStore; mode?: PolicyMode; exactPin?: boolean }) =>
  verifyRelease({ name: NAME, ...o });

describe('A and B: a key rotation with no method history (did:web, did:dht)', () => {
  const did = 'did:web:pkg.example';
  const resolver = new FakeResolver();
  const reader = new MemReader();
  const pinned: TrustStore = new Map();
  let k1: Key, k2: Key;
  let beforeRotation: MemReader;

  beforeAll(async () => {
    [k1, k2] = [await newKey(did, 'didpkg-1'), await newKey(did, 'didpkg-2')];
    resolver.set(did, [k1]);
    await publish(reader, { did, version: '1.0.0', tarball: tgz('a1'), signers: [k1.signer] });
    await verifyRelease({ did, name: NAME, version: '1.0.0', resolver, reader, trust: pinned }); // A0: TOFU pins key 1
    resolver.set(did, [k2]); // the DID update: key 1 out, key 2 in
    beforeRotation = reader.clone();
  });

  test('A0: the first install pins key 1', () => {
    expect(pinned.get(`${did}/${NAME}`)?.keys).toEqual([k1.multikey]);
  });

  test('A1: the old key co-signs the index of the new key, so the pinned user installs', async () => {
    const host = beforeRotation.clone();
    await reindex(host, { did, signers: [k2.signer, k1.signer] }); // a proof set: the new key and the old key
    const r = await verify({ did, version: '1.0.0', resolver, reader: host, trust: structuredClone(pinned) });
    expect([r.continuity, r.manifestKey, r.warnings]).toEqual(['co-signed', 'index', []]);
  });

  test('A2-A4: no co-signature (the old key is lost)', async () => {
    const host = beforeRotation.clone();
    await reindex(host, { did, signers: [k2.signer] });
    const base = { did, version: '1.0.0', resolver, reader: host };
    expect(await outcome(() => verify({ ...base, trust: structuredClone(pinned) }))).toBe('KEY_CHANGED');
    const warned = await verify({ ...base, trust: structuredClone(pinned), mode: 'warn' });
    expect([warned.continuity, warned.warnings.map((w) => w.code)]).toEqual(['accepted-in-warn-mode', ['KEY_CHANGED']]);
    expect((await verify({ ...base, trust: new Map() })).continuity).toBe('first-use'); // A4: a new user has no pin
  });

  test('B: a did:web domain takeover serves a new DID document, key and index', async () => {
    const thief = await newKey(did, 'didpkg-1');
    const takeover = new FakeResolver();
    takeover.set(did, [thief]);
    const evil = new MemReader();
    await publish(evil, { did, version: '1.0.0', tarball: tgz('evil'), signers: [thief.signer] });
    const base = { did, version: '1.0.0', resolver: takeover, reader: evil };
    expect(await outcome(() => verify({ ...base, trust: structuredClone(pinned) }))).toBe('KEY_CHANGED');
    // B2: only warn mode passes, with two warnings. npm then fails on the lockfile integrity.
    const warned = await verify({ ...base, trust: structuredClone(pinned), mode: 'warn' });
    expect(warned.warnings.map((w) => w.code)).toEqual(['KEY_CHANGED', 'HISTORY_CHANGED']);
  });
});

describe('C-I: compromise, yank, revoke, rollback and a hostile host', () => {
  const did = 'did:dht:example';
  const resolver = new FakeResolver();
  const reader = new MemReader();
  const pinned: TrustStore = new Map();
  let k1: Key, k2: Key;
  let oldHead: MemReader;

  beforeAll(async () => {
    [k1, k2] = [await newKey(did, 'didpkg-1'), await newKey(did, 'didpkg-2')];
    resolver.set(did, [k1]);
    await publish(reader, { did, version: '1.0.0', tarball: tgz('c1'), signers: [k1.signer] });
    await publish(reader, { did, version: '1.1.0', tarball: tgz('c2'), signers: [k1.signer] });
    await verifyRelease({ did, name: NAME, version: '1.1.0', resolver, reader, trust: pinned }); // C0
    oldHead = reader.clone();
    resolver.set(did, [k2]);
    await reindex(reader, { did, signers: [k2.signer, k1.signer] });
  });

  test('C1: after a co-signed rotation, the pinned user installs an old release', async () => {
    const r = await verify({ did, version: '1.0.0', resolver, reader, trust: structuredClone(pinned) });
    expect([r.continuity, r.manifestKey]).toEqual(['co-signed', 'index']);
  });

  test('D1: a thief signs a new index with the rotated-out key 1', async () => {
    const thief = oldHead.clone();
    await publish(thief, { did, version: '1.2.0', tarball: tgz('malware'), signers: [k1.signer], created: '2026-03-15T00:00:00Z' });
    expect(await outcome(() => verify({ did, version: '1.2.0', resolver, reader: thief, trust: new Map() }))).toBe('INDEX_SIGNATURE');
  });

  test('D2: a thief manifest next to the real index is not listed', async () => {
    const thief = oldHead.clone();
    await publish(thief, { did, version: '1.2.0', tarball: tgz('malware'), signers: [k1.signer] });
    const mixed = reader.clone();
    mixed.releases = thief.releases;
    mixed.tarballs = thief.tarballs;
    expect(await outcome(() => verify({ did, version: '1.2.0', resolver, reader: mixed, trust: new Map() }))).toBe('NOT_LISTED');
  });

  describe('E-I: after a release by key 2, a yank and a revoke', () => {
    beforeAll(async () => {
      await publish(reader, { did, version: '1.3.0', tarball: tgz('c3'), signers: [k2.signer] });
      await reindex(reader, {
        did, signers: [k2.signer],
        status: { '1.1.0': { status: 'yanked', message: 'broken build' }, '1.0.0': { status: 'revoked', message: 'CVE-2026-0001' } },
      });
    });
    const run = (version: string, o: { reader?: MemReader; trust?: TrustStore; exactPin?: boolean } = {}) =>
      outcome(() => verify({ did, version, resolver, reader, trust: new Map(), ...o }));

    test('E1-E4: yank and revoke obey the signed index', async () => {
      expect((await reader.getIndex(did, NAME))?.distTags).toEqual({ latest: '1.3.0' });
      expect(await run('1.1.0')).toBe('YANKED');
      expect(await run('1.1.0', { exactPin: true })).toBe('ok');
      expect(await run('1.0.0', { exactPin: true })).toBe('REVOKED');
      const r = await verify({ did, version: '1.3.0', resolver, reader, trust: new Map() });
      expect([r.manifestKey, r.continuity]).toEqual(['current-key', 'first-use']);
    });

    test('E2: an exact pin of a yanked version gives a warning', async () => {
      const r = await verify({ did, version: '1.1.0', resolver, reader, trust: new Map(), exactPin: true });
      expect(r.warnings.map((w) => w.code)).toEqual(['YANKED']);
    });

    test('F1: the host serves an older index of the same key (it hides the revocation)', async () => {
      const trust: TrustStore = new Map();
      await verify({ did, version: '1.3.0', resolver, reader, trust });
      const frozen = reader.clone();
      frozen.putIndex(reader.history.at(-2)!);
      expect(await run('1.0.0', { reader: frozen, trust })).toBe('ROLLBACK');
    });

    test('F2: the host serves a second index with the pinned sequence', async () => {
      const trust: TrustStore = new Map();
      await verify({ did, version: '1.3.0', resolver, reader, trust });
      const fork = reader.clone();
      const head = (await reader.getIndex(did, NAME))!;
      await reindex(fork, { did, signers: [k2.signer], sequence: head.sequence, status: { '1.0.0': { status: 'active' } } });
      expect(await run('1.0.0', { reader: fork, trust })).toBe('EQUIVOCATION');
    });

    test('G1: the host swaps the tarball bytes', async () => {
      const swap = reader.clone();
      swap.tarballs.set(`${did}/${NAME}@1.3.0`, tgz('c3-trojan'));
      expect(await run('1.3.0', { reader: swap })).toBe('INTEGRITY');
      const same = reader.clone(); // the same length, other bytes
      same.tarballs.set(`${did}/${NAME}@1.3.0`, tgz('x3'));
      expect(await run('1.3.0', { reader: same })).toBe('INTEGRITY');
    });

    test('H1: the host swaps the manifest (it adds a dependency)', async () => {
      const swap = reader.clone();
      const m = structuredClone(reader.releases.get(`${did}/${NAME}@1.3.0`)!);
      m.npm = { dependencies: { 'evil-dep': '*' } };
      swap.releases.set(`${did}/${NAME}@1.3.0`, m);
      expect(await run('1.3.0', { reader: swap })).toBe('MANIFEST_DIGEST');
    });

    test('the host drops the manifest or the tarball', async () => {
      const host = reader.clone();
      host.tarballs.delete(`${did}/${NAME}@1.3.0`);
      expect(await run('1.3.0', { reader: host })).toBe('TARBALL_MISSING');
      host.releases.delete(`${did}/${NAME}@1.3.0`);
      expect(await run('1.3.0', { reader: host })).toBe('MANIFEST_MISSING');
      expect(await run('1.3.0', { reader: new MemReader() })).toBe('INDEX_MISSING');
    });

    test('I1: a deactivated DID fails', async () => {
      const gone = new FakeResolver();
      gone.set(did, [k2], true);
      expect(await outcome(() => verify({ did, version: '1.3.0', resolver: gone, reader, trust: new Map() }))).toBe('DID_DEACTIVATED');
    });
  });
});

describe('a key of another DID', () => {
  const did = 'did:web:pkg.example';
  const other = 'did:web:evil.example';
  let mine: Key, theirs: Key;
  const resolver = new FakeResolver();

  beforeAll(async () => {
    [mine, theirs] = [await newKey(did, 'didpkg-1'), await newKey(other, 'didpkg-1')];
    resolver.set(did, [mine]);
    resolver.set(other, [theirs]);
  });

  test('an index signed by a key of another DID fails', async () => {
    const reader = new MemReader();
    await publish(reader, { did, version: '1.0.0', tarball: tgz('a'), signers: [theirs.signer] });
    expect(await outcome(() => verify({ did, version: '1.0.0', resolver, reader, trust: new Map() }))).toBe('INDEX_SIGNATURE');
  });

  test('a manifest signed by a key of another DID fails, even if the index lists it', async () => {
    const reader = new MemReader();
    await publish(reader, { did, version: '1.0.0', tarball: tgz('a'), signers: [theirs.signer], indexSigners: [mine.signer] });
    expect(await outcome(() => verify({ did, version: '1.0.0', resolver, reader, trust: new Map() }))).toBe('MANIFEST_SIGNATURE');
  });

  test('a resolver that returns the document of another DID fails', async () => {
    const reader = new MemReader();
    await publish(reader, { did: other, version: '1.0.0', tarball: tgz('a'), signers: [theirs.signer] });
    const liar = new FakeResolver();
    liar.docs.set(did, resolver.docs.get(other)!);
    expect(await outcome(() => verify({ did, version: '1.0.0', resolver: liar, reader, trust: new Map() }))).toBe('DID_RESOLUTION');
  });

  test('the index of another DID or package fails', async () => {
    const reader = new MemReader();
    await publish(reader, { did: other, version: '1.0.0', tarball: tgz('a'), signers: [theirs.signer] });
    reader.indexes.set(`${did}/${NAME}`, reader.indexes.get(`${other}/${NAME}`)!);
    expect(await outcome(() => verify({ did, version: '1.0.0', resolver, reader, trust: new Map() }))).toBe('INDEX_FIELDS');
  });
});
