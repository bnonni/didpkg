// DwnWriter against the pinned @enbox/dwn-server 0.1.45 (a child process). The publisher is a new did:dht per run,
// served by a fake relay. The writer signs with #didpkg-1. The reads are the anonymous DRL routes of ADR 0003 section 6.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import { RecordsWrite } from '@enbox/dwn-sdk-js';
import { dhtFixture } from '../../core/test/did/helpers.ts';
import { DIDPKG_PROTOCOL, protocolDefinition } from '../src/index.ts';
import { DwnWriter, ed25519MessageSigner } from '../src/writer.ts';
import { startDwn, startRelay } from './server.ts';

const fx = await dhtFixture();
const keyId = `${fx.did}#didpkg-1`;
const seed = await (async () => {
  const vm = fx.document.verificationMethod!.find((v) => v.id === keyId)!;
  const { privateKeys } = await fx.bearer.export();
  return new Uint8Array(Buffer.from(privateKeys!.find((k) => k.x === vm.publicKeyJwk!.x)!.d!, 'base64url'));
})();
const signer = ed25519MessageSigner(seed, keyId);
const relay = startRelay(new Map([[fx.id, await fx.payload()]]));
let dwn: Awaited<ReturnType<typeof startDwn>>;
let writer: DwnWriter;

beforeAll(async () => {
  dwn = await startDwn({ relayUrl: relay.url });
  writer = new DwnWriter({ dwnUrl: dwn.url, did: fx.did, signer });
  await writer.installProtocol();
}, 30_000);
afterAll(async () => {
  await dwn?.stop();
  relay.stop();
});

const te = new TextEncoder();
const json = (v: unknown) => te.encode(JSON.stringify(v));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

type Entry = { recordId: string; contextId: string };
async function query(params: Record<string, string>): Promise<Entry[]> {
  const r = await fetch(`${dwn.url}/${fx.did}/query?${qs({ 'filter.protocol': DIDPKG_PROTOCOL, ...params })}`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { entries?: Entry[] }).entries ?? [];
}
const packages = (name: string) => query({ 'filter.protocolPath': 'package', 'filter.tags.name': name });
async function read(path: string, params: Record<string, string>): Promise<Uint8Array | null> {
  const r = await fetch(`${dwn.url}/${fx.did}/read/protocols/${Buffer.from(DIDPKG_PROTOCOL).toString('base64url')}/${path}?${qs(params)}`);
  if (r.status === 404) return null;
  expect(r.status).toBe(200);
  return new Uint8Array(await r.arrayBuffer());
}
/** The index, the release and the tarball of one version, as a reader in one package context gets them. */
async function files(contextId: string, version: string) {
  const v = { 'filter.contextId': contextId, 'filter.tags.version': version };
  return {
    index: await read('package/index', { 'filter.contextId': contextId }),
    release: await read('package/release', v),
    tarball: await read('package/release/tarball', v),
  };
}

const name = 'hello';
const v1 = { name, version: '1.0.0', release: json({ name, version: '1.0.0' }), tarball: random(3000), index: json({ name, sequence: 1 }) };
const v2 = { name, version: '1.1.0+b.1', release: json({ name, version: '1.1.0+b.1' }), tarball: random(70_000), index: json({ name, sequence: 2 }) };

test('the protocol definition is the ADR 0003 section 6 JSON', async () => {
  const adr = await Bun.file(new URL('../../../docs/adr/0003-storage-contract.md', import.meta.url)).text();
  const block = adr.slice(adr.indexOf('### 6.')).match(/```json\n([\s\S]*?)```/)![1]!;
  expect(protocolDefinition).toEqual(JSON.parse(block));
});

test('publish writes the release, the tarball and the index; the anonymous reads give the exact bytes', async () => {
  await writer.publish(v1);
  const [pkg, ...more] = await packages(name);
  expect(more).toEqual([]);
  expect(await files(pkg!.contextId, '1.0.0')).toEqual({ index: v1.index, release: v1.release, tarball: v1.tarball });

  // Another name has its own context, so its 1.0.0 is not a conflict.
  const other = { name: 'other', version: '1.0.0', release: json({ name: 'other', version: '1.0.0' }), tarball: random(10), index: json({ name: 'other', sequence: 1 }) };
  await writer.publish(other);
  const [otherPkg] = await packages('other');
  expect(otherPkg!.contextId).not.toBe(pkg!.contextId);
  expect(await files(otherPkg!.contextId, '1.0.0')).toEqual({ index: other.index, release: other.release, tarball: other.tarball });

  await writer.publish(v2);
  expect((await packages(name)).map((e) => e.contextId)).toEqual([pkg!.contextId]);
  expect(await files(pkg!.contextId, '1.1.0+b.1')).toEqual({ index: v2.index, release: v2.release, tarball: v2.tarball });
  expect((await files(pkg!.contextId, '1.0.0')).release).toEqual(v1.release);
  expect(await files(pkg!.contextId, '2.0.0')).toEqual({ index: v2.index, release: null, tarball: null });
});

test('a publish again with the same bytes is a no-op: one record per file', async () => {
  await writer.publish({ ...v1, index: v2.index });
  const [pkg] = await packages(name);
  const count = async (protocolPath: string, extra: Record<string, string> = {}) =>
    (await query({ 'filter.protocolPath': protocolPath, 'filter.contextId': pkg!.contextId, ...extra })).length;
  expect([
    await count('package/index'),
    await count('package/release', { 'filter.tags.version': '1.0.0' }),
    await count('package/release/tarball', { 'filter.tags.version': '1.0.0' }),
  ]).toEqual([1, 1, 1]);
});

test('refuses to replace a published release or tarball, and then writes no index', async () => {
  const index = json({ name, sequence: 3 });
  await expect(writer.publish({ ...v1, release: json({ name, version: '1.0.0', x: 1 }), index })).rejects.toThrow('hello@1.0.0 release: a different file exists');
  await expect(writer.publish({ ...v1, tarball: random(3000), index })).rejects.toThrow('hello@1.0.0 tarball: a different file exists');
  const [pkg] = await packages(name);
  expect(await files(pkg!.contextId, '1.0.0')).toEqual({ index: v2.index, release: v1.release, tarball: v1.tarball });
});

test('writeIndex updates the one index record in place', async () => {
  const [pkg] = await packages(name);
  const before = await query({ 'filter.protocolPath': 'package/index', 'filter.contextId': pkg!.contextId });
  const index = json({ name, sequence: 4 });
  await writer.writeIndex({ name, index });
  const after = await query({ 'filter.protocolPath': 'package/index', 'filter.contextId': pkg!.contextId });
  expect(after.map((e) => e.recordId)).toEqual(before.map((e) => e.recordId));
  expect((await files(pkg!.contextId, '1.0.0')).index).toEqual(index);
});

/** A record that the writer did not write, as after a race of two publishes. */
const paths = { package: 'package', index: 'package/index', release: 'package/release' } as const;
async function rawWrite(type: keyof typeof paths, data: Uint8Array, o: { tags?: Record<string, string>; parentContextId?: string }) {
  const w = await RecordsWrite.create({
    protocol: DIDPKG_PROTOCOL, protocolPath: paths[type], schema: protocolDefinition.types[type].schema,
    dataFormat: 'application/json', data, published: true, signer, ...o,
  });
  const reply = await new HttpDwnRpcClient().sendDwnRequest({ dwnUrl: dwn.url, targetDid: fx.did, message: w.message, data });
  expect(reply.status.code).toBe(202);
  return w.message;
}

test('two index records in one context: the writer updates the newest, which a reader reads', async () => {
  const [pkg] = await packages(name);
  const second = await rawWrite('index', json({ name, sequence: 0 }), { parentContextId: pkg!.contextId });
  expect((await files(pkg!.contextId, '1.0.0')).index).toEqual(json({ name, sequence: 0 }));
  const index = json({ name, sequence: 5 });
  await writer.writeIndex({ name, index });
  expect((await files(pkg!.contextId, '1.0.0')).index).toEqual(index);
  const records = await query({ 'filter.protocolPath': 'package/index', 'filter.contextId': pkg!.contextId });
  expect(records.length).toBe(2);
  expect(records.map((e) => e.recordId)).toContain(second.recordId);
});

test('two release records for one version, one with other bytes: the writer refuses', async () => {
  const [pkg] = await packages(name);
  await rawWrite('release', json({ name, version: '1.1.0+b.1', x: 2 }), { tags: { version: '1.1.0+b.1' }, parentContextId: pkg!.contextId });
  await expect(writer.publish(v2)).rejects.toThrow('hello@1.1.0+b.1 release: a different file exists');
});

test('two package records with one name: the writer writes to the oldest', async () => {
  const [oldest] = await packages(name);
  const second = { message: await rawWrite('package', json({ name }), { tags: { name } }) };
  const index = json({ name, sequence: 6 });
  await writer.writeIndex({ name, index });
  expect((await packages(name)).map((e) => e.contextId)).toEqual([oldest!.contextId, second.message.contextId]);
  expect((await files(oldest!.contextId, '1.0.0')).index).toEqual(index);
  expect((await files(second.message.contextId, '1.0.0')).index).toBeNull();
});

test('the DWN refuses a writer with a key that is not in the DID document', async () => {
  const rogue = new DwnWriter({ dwnUrl: dwn.url, did: fx.did, signer: ed25519MessageSigner(random(32), keyId) });
  await expect(rogue.publish({ ...v1, name: 'rogue' })).rejects.toThrow(/^query package: DWN 401 /);
  await expect(rogue.installProtocol()).rejects.toThrow(/^ProtocolsConfigure: DWN 401 /);
  expect(await packages('rogue')).toEqual([]);
});
