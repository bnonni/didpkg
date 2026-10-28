// The publisher flow. A port of the spike script research/phase3/did-trust-model/07-publish.ts: it
// makes 4 snapshots of an untrusted store (v1, yank, revoke, swap), and each snapshot gives the
// verifier result that the npm end-to-end test expects. The npm part is in the shim tests (C10, C11).
import { beforeAll, describe, expect, test } from 'bun:test';
import { base64urlnopad } from '@scure/base';
import * as ed from '@noble/ed25519';
import { DidResolver } from '../../src/did/resolver.ts';
import { jwkDriver } from '../../src/did/drivers/jwk.ts';
import { keyDriver } from '../../src/did/drivers/key.ts';
import { ed25519Signer, toMultikey, verifyRelease, type TrustStore } from '../../src/trust/index.ts';
import { outcome } from './helpers.ts';
import { FakeResolver, MemReader, NAME, newKey, publish, reindex, tgz } from './sim.ts';

describe('the 4 snapshots of the spike npm end-to-end test (did:web)', () => {
  const did = 'did:web:pkg.example';
  const resolver = new FakeResolver();
  const v1 = new MemReader();
  let yank: MemReader, revoke: MemReader, swap: MemReader;
  const run = (reader: MemReader, version: string, o: { trust?: TrustStore; exactPin?: boolean } = {}) =>
    outcome(() => verifyRelease({ did, name: NAME, version, resolver, reader, trust: new Map(), ...o }));

  beforeAll(async () => {
    const k1 = await newKey(did, 'didpkg-1');
    resolver.set(did, [k1]);
    await publish(v1, { did, version: '1.0.0', tarball: tgz('hello-1.0.0'), signers: [k1.signer] });
    await publish(v1, { did, version: '1.1.0', tarball: tgz('hello-1.1.0'), signers: [k1.signer] });
    yank = v1.clone();
    await reindex(yank, { did, signers: [k1.signer], status: { '1.1.0': { status: 'yanked', message: 'broken build, use 1.0.0' } } });
    revoke = yank.clone();
    await reindex(revoke, { did, signers: [k1.signer], status: { '1.1.0': { status: 'revoked', message: 'malicious code, CVE-2026-0002' } } });
    swap = revoke.clone(); // the latest signed state, but the host swaps the 1.0.0 tarball bytes
    swap.tarballs.set(`${did}/${NAME}@1.0.0`, tgz('hello-1.1.0'));
  });

  test('v1: both versions install, and the manifests form a hash chain', async () => {
    expect([await run(v1, '1.0.0'), await run(v1, '1.1.0')]).toEqual(['ok', 'ok']);
    const second = v1.releases.get(`${did}/${NAME}@1.1.0`)!;
    expect(second.previous).toEqual({ version: '1.0.0', digest: v1.history[0]!.releases['1.0.0']!.digest });
  });

  test('yank: a range install fails, a lockfile pin installs, and latest moves back', async () => {
    expect([await run(yank, '1.1.0'), await run(yank, '1.1.0', { exactPin: true }), await run(yank, '1.0.0')]).toEqual(['YANKED', 'ok', 'ok']);
    expect((await yank.getIndex(did, NAME))?.distTags).toEqual({ latest: '1.0.0' });
  });

  test('revoke: a lockfile pin fails too', async () => {
    expect(await run(revoke, '1.1.0', { exactPin: true })).toBe('REVOKED');
  });

  test('swap: the tarball fails before one byte goes to npm', async () => {
    expect(await run(swap, '1.0.0')).toBe('INTEGRITY');
  });

  test('v1 doubles as the rollback snapshot after the revoke', async () => {
    const trust: TrustStore = new Map();
    expect(await run(revoke, '1.0.0', { trust })).toBe('ok');
    expect(await run(v1, '1.1.0', { trust, exactPin: true })).toBe('ROLLBACK');
  });
});

describe('the real DidResolver: Multikey (did:key) and JWK (did:jwk) publishers', () => {
  const resolver = new DidResolver({ drivers: [keyDriver(), jwkDriver()] });

  test('a did:key publisher', async () => {
    const { secretKey, publicKey } = await ed.keygenAsync();
    const multikey = toMultikey({ alg: 'Ed25519', bytes: publicKey });
    const did = `did:key:${multikey}`;
    const reader = new MemReader();
    await publish(reader, { did, version: '1.0.0', tarball: tgz('key'), signers: [ed25519Signer(secretKey, `${did}#${multikey}`)] });
    const r = await verifyRelease({ did, name: NAME, version: '1.0.0', resolver, reader, trust: new Map() });
    expect([r.manifestKey, r.epochKey]).toEqual(['current-key', multikey]);
  });

  test('a did:jwk publisher: the pin holds the Multikey form of the JWK', async () => {
    const { secretKey, publicKey } = await ed.keygenAsync();
    const jwk = { crv: 'Ed25519', kty: 'OKP', x: base64urlnopad.encode(publicKey) };
    const did = 'did:jwk:' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(jwk)));
    const reader = new MemReader();
    await publish(reader, { did, version: '1.0.0', tarball: tgz('jwk'), signers: [ed25519Signer(secretKey, `${did}#0`)] });
    const trust: TrustStore = new Map();
    const r = await verifyRelease({ did, name: NAME, version: '1.0.0', resolver, reader, trust });
    expect([r.manifestKey, trust.get(`${did}/${NAME}`)?.keys]).toEqual(['current-key', [toMultikey({ alg: 'Ed25519', bytes: publicKey })]]);
  });
});
