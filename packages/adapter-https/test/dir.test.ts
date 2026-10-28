// The dir: writer (ADR 0003 sections 3 and 7), and the round trip: writer, static server, https
// reader, PackageSource and the verifier.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DidDocument } from '@didpkg/core/did';
import { PackageSource, type PublishInput } from '@didpkg/core/source';
import { verifyRelease, type Pin } from '@didpkg/core/trust';
import { FakeResolver, MemReader, NAME, didDoc, newKey, publish, tgz } from '../../core/test/trust/sim.ts';
import { DirWriter } from '../src/dir.ts';
import { httpsAdapter } from '../src/index.ts';
import { serveDir } from './serve.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const input = (o: Partial<PublishInput> = {}): PublishInput =>
  ({ name: 'hello', version: '1.0.0', release: bytes('{"r":1}'), tarball: bytes('tgz-1'), index: bytes('{"i":1}'), ...o });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'didpkg-dir-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = (rel: string) => readFile(join(dir, rel)).then((b) => new Uint8Array(b), () => undefined);
const files = async () => (await readdir(dir, { recursive: true })).sort();

test('publish: the exact bytes at the layout paths, and no temporary file', async () => {
  const writer = new DirWriter(dir);
  await writer.publish(input());
  await writer.publish(input({ version: '1.1.0+b.1', release: bytes('{"r":2}'), tarball: bytes('tgz-2'), index: bytes('{"i":2}') }));
  expect(await files()).toEqual(['hello', 'hello/1.0.0.json', 'hello/1.0.0.tgz', 'hello/1.1.0+b.1.json', 'hello/1.1.0+b.1.tgz', 'hello/index.json']);
  expect(await read('hello/1.0.0.json')).toEqual(bytes('{"r":1}'));
  expect(await read('hello/1.0.0.tgz')).toEqual(bytes('tgz-1'));
  expect(await read('hello/1.1.0+b.1.tgz')).toEqual(bytes('tgz-2'));
  expect(await read('hello/index.json')).toEqual(bytes('{"i":2}'));
});

test('publish: the same bytes again is a no-op; writeIndex replaces only the index', async () => {
  const writer = new DirWriter(dir);
  await writer.publish(input());
  await writer.publish(input({ index: bytes('{"i":2}') }));
  expect(await read('hello/index.json')).toEqual(bytes('{"i":2}'));
  await writer.writeIndex({ name: 'hello', index: bytes('{"i":3}') });
  expect(await read('hello/index.json')).toEqual(bytes('{"i":3}'));
  expect(await read('hello/1.0.0.json')).toEqual(bytes('{"r":1}'));
});

test('publish: a published version does not change, and the order is tarball, release, index', async () => {
  const writer = new DirWriter(dir);
  await writer.publish(input());
  await writer.publish(input());
  // A different tarball for 2.0.0 is there: no release write and no index write.
  await mkdir(join(dir, 'hello'), { recursive: true });
  await writeFile(join(dir, 'hello/2.0.0.tgz'), 'other');
  await expect(writer.publish(input({ version: '2.0.0', index: bytes('{"i":2}') }))).rejects.toThrow('a different file exists');
  expect([await read('hello/2.0.0.tgz'), await read('hello/2.0.0.json'), await read('hello/index.json')])
    .toEqual([bytes('other'), undefined, bytes('{"i":1}')]);
  // A different release for 3.0.0 is there: the tarball write comes first, and no index write.
  await writeFile(join(dir, 'hello/3.0.0.json'), 'other');
  await expect(writer.publish(input({ version: '3.0.0', index: bytes('{"i":3}') }))).rejects.toThrow('a different file exists');
  expect([await read('hello/3.0.0.tgz'), await read('hello/3.0.0.json'), await read('hello/index.json')])
    .toEqual([bytes('tgz-1'), bytes('other'), bytes('{"i":1}')]);
  expect((await files()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
});

test('writeIndex: a failed write leaves no temporary file', async () => {
  await mkdir(join(dir, 'hello/index.json'), { recursive: true });
  await expect(new DirWriter(dir).writeIndex({ name: 'hello', index: bytes('{}') })).rejects.toThrow();
  expect(await files()).toEqual(['hello', 'hello/index.json']);
});

test('publish and writeIndex: an unsafe name or version writes nothing', async () => {
  const writer = new DirWriter(dir);
  await expect(writer.publish(input({ name: '../x' }))).rejects.toThrow(TypeError);
  await expect(writer.publish(input({ version: '../1.0.0' }))).rejects.toThrow(TypeError);
  await expect(writer.writeIndex({ name: '..', index: bytes('{}') })).rejects.toThrow(TypeError);
  expect(await files()).toEqual([]);
});

test('round trip: DirWriter, a static server, the https reader and verifyRelease', async () => {
  const did = 'did:example:pub';
  const key = await newKey(did, 'didpkg-1');
  const mem = new MemReader();
  for (const version of ['1.0.0', '1.1.0+b.1']) await publish(mem, { did, version, tarball: tgz(version), signers: [key.signer] });
  // The CLI serializes each signed object one time (ADR 0003 section 3 item 3).
  const writer = new DirWriter(dir);
  const index = bytes(JSON.stringify(mem.indexes.get(`${did}/${NAME}`)));
  for (const version of ['1.0.0', '1.1.0+b.1']) {
    const key = `${did}/${NAME}@${version}`;
    await writer.publish({ name: NAME, version, release: bytes(JSON.stringify(mem.releases.get(key))), tarball: mem.tarballs.get(key)!, index });
  }

  const server = serveDir(dir);
  try {
    const resolver = new FakeResolver();
    resolver.docs.set(did, {
      doc: { ...didDoc(did, [key]), service: [{ id: '#pkg', type: 'DIDPackageRepository', serviceEndpoint: server.base }] } as DidDocument,
    });
    const source = new PackageSource({ resolver, adapters: [httpsAdapter({ allowLoopback: true })] });
    expect(await source.endpoints(did)).toHaveLength(1);
    for (const version of ['1.0.0', '1.1.0+b.1']) {
      const verified = await verifyRelease({ did, name: NAME, version, resolver, reader: source, trust: new Map<string, Pin>() });
      expect([verified.release.version, verified.tarball]).toEqual([version, tgz(version)]);
    }
    // No adapter reads a loopback endpoint without the test option.
    const strict = new PackageSource({ resolver, adapters: [httpsAdapter()] });
    expect(await strict.endpoints(did)).toEqual([]);
  } finally {
    server.stop();
  }
});
