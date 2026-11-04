// A XID publisher on the pinned @enbox/dwn-server 0.1.45. The tenant is the did:key of the DWN key (Auth) of the
// XID document. The writer writes the protocol v2 with Gordian Envelope records. Then PackageSource and the XID
// verifier read the DWN through the endpoint of the XID document.
import { afterAll, expect, test } from 'bun:test';
import { PackageSource, xidEndpoints } from '@didpkg/core/source';
import {
  envelopeBytes, readXidDocument, signXidIndex, signXidRelease, verifyXidIndex, verifyXidRelease, xidContentDigest, type XidPkgIndex,
} from '@didpkg/core/xid';
import { docBytes, privateKeys } from '../../core/test/xid/fixture.ts';
import { DIDPKG_PROTOCOL, DIDPKG_PROTOCOL_V2, dwnAdapter, protocolDefinitionV2 } from '../src/index.ts';
import { DwnWriter, ed25519MessageSigner } from '../src/writer.ts';
import { startDwn, startRelay } from './server.ts';

const relay = startRelay(new Map());
const dwn = await startDwn({ relayUrl: relay.url });
afterAll(async () => {
  await dwn.stop();
  relay.stop();
});

const NAME = 'hello';
const info = readXidDocument(docBytes({ dwn: dwn.url }));
const xid = info.xid;
const tenant = info.keys.find((k) => k.nickname === 'dwn')!.didKey!;
const seed = privateKeys(4).signingPrivateKey.asEd25519()!.bytes;
const signer = ed25519MessageSigner(seed, `${tenant}#${tenant.slice('did:key:'.length)}`);
const writer = new DwnWriter({ dwnUrl: dwn.url, did: tenant, signer, format: 'envelope' });
await writer.installProtocol();

const tgz = (v: string) => new TextEncoder().encode(`tarball ${v} `.repeat(50));
const resolver = { resolve: async (x: string) => readXidDocument(info.bytes, x) };
const source = new PackageSource({ resolver: { resolve: async () => { throw new Error('no DID here'); } }, xidResolver: resolver, adapters: [dwnAdapter({ allowLoopback: true })] });

let head: XidPkgIndex | null = null;
for (const version of ['1.0.0', '1.1.0']) {
  const release = await signXidRelease({ publisher: xid, name: NAME, version, tarball: tgz(version), npm: {}, head }, [privateKeys(2)]);
  head = signXidIndex({ publisher: xid, name: NAME, head, releases: { ...head?.releases, [version]: { digest: xidContentDigest(release), status: 'active' } } }, [privateKeys(2)]);
  await writer.publish({ name: NAME, version, release: envelopeBytes(release), tarball: tgz(version), index: envelopeBytes(head), format: 'envelope' });
}

test('the protocol v2 definition is the ADR 0003 section 9 JSON', async () => {
  const adr = await Bun.file(new URL('../../../docs/adr/0003-storage-contract.md', import.meta.url)).text();
  const block = adr.slice(adr.indexOf('### 9.')).match(/```json\n([\s\S]*?)```/)![1]!;
  expect(protocolDefinitionV2).toEqual(JSON.parse(block));
});

test('the XID document gives the DWN endpoint first; its tenant is the did:key of the DWN key', () => {
  expect(tenant).toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/);
  expect(xidEndpoints(info).map((e) => [e.type, e.did, e.url])).toEqual([['DecentralizedWebNode', tenant, dwn.url]]);
});

test('an install from the DWN of a XID publisher: the verifier selects seq 2, and the tarball URL is a v2 DRL', async () => {
  const index = await verifyXidIndex({ xid, name: NAME, resolver, reader: source, trust: new Map() });
  expect([index.index.sequence, Object.keys(index.index.releases)]).toEqual([2, ['1.0.0', '1.1.0']]);
  const { release } = await verifyXidRelease({ xid, name: NAME, version: '1.0.0', resolver, reader: source, trust: new Map() });
  const found = (await source.findTarball(xid, NAME, '1.0.0', release.dist))!;
  expect(found.bytes).toEqual(tgz('1.0.0'));
  expect(found.url).toStartWith(`${dwn.url}/${tenant}/read/protocols/${Buffer.from(DIDPKG_PROTOCOL_V2).toString('base64url')}/package/release/tarball?`);
  expect(new Uint8Array(await (await fetch(found.url!)).arrayBuffer())).toEqual(tgz('1.0.0'));
});

test('the records are only in the protocol v2; a writer writes one record form', async () => {
  const count = async (protocol: string) => {
    const q = new URLSearchParams({ 'filter.protocol': protocol, 'filter.protocolPath': 'package', 'filter.tags.name': NAME });
    return ((await (await fetch(`${dwn.url}/${tenant}/query?${q}`)).json()) as { entries?: unknown[] }).entries?.length ?? 0;
  };
  expect([await count(DIDPKG_PROTOCOL), await count(DIDPKG_PROTOCOL_V2)]).toEqual([0, 1]);
  const bytes = new Uint8Array(1);
  await expect(writer.writeIndex({ name: NAME, index: bytes })).rejects.toThrow('writes envelope records, not json');
  const v1 = new DwnWriter({ dwnUrl: dwn.url, did: tenant, signer });
  await expect(v1.publish({ name: NAME, version: '2.0.0', release: bytes, tarball: bytes, index: bytes, format: 'envelope' })).rejects.toThrow('writes json records, not envelope');
});
