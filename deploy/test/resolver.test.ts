// The DID resolver of the didpkg DWN (deploy/dwn). A did:webvh, a did:plc and a did:btcr2 publisher have a Multikey release key.
// Each writes to a dwn-server that runs deploy/dwn/start.ts. The stock main.js of dwn-server refuses them.
// The DID hosts are web.didpkg.test, plc.directory, the Esplora host and the CAS hosts of the did:btcr2 driver.
// Each dwn-server gets the CONNECT proxy and the demo CA of demo/tls.ts, and the proxy sends each name to a local TLS site.
// Thus the did:plc driver reads the audit log of the site, and the did:btcr2 driver reads its beacon signals and CAS blocks.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base58, base64urlnopad } from '@scure/base';
import canonicalize from 'canonicalize';
import { makeCerts, proxyEnv, startProxy, WEB_HOST } from '../../demo/tls.ts';
import { failure } from '../../packages/core/src/did/errors.ts';
import { CAS_GATEWAYS, casCid } from '../../packages/core/src/did/drivers/btcr2.ts';
import { PLC_DIRECTORY } from '../../packages/core/src/did/drivers/plc.ts';
import { BTCR2_ESPLORA, btcr2Fixture, plcFixture, webvhFixture } from '../../packages/core/test/did/helpers.ts';
import { DwnWriter, ed25519MessageSigner } from '../../packages/adapter-dwn/src/writer.ts';
import { startDwn, startRelay } from '../../packages/adapter-dwn/test/server.ts';
import { jwkMethods, toEnbox } from '../dwn/resolver.ts';

const dir = mkdtempSync(join(tmpdir(), 'didpkg-dwn-webvh-'));
const PLC_HOST = new URL(PLC_DIRECTORY).host;
const ESPLORA_HOST = new URL(BTCR2_ESPLORA).host;
const CAS_HOSTS = CAS_GATEWAYS.map((g) => new URL(g).host);
const hosts = [WEB_HOST, PLC_HOST, ESPLORA_HOST, ...CAS_HOSTS];
const certs = await makeCerts(dir, hosts);
const fx = await webvhFixture(WEB_HOST, ['pkgs']);
const plc = await plcFixture();
// A forged log: the operation gets another release key, and the signature and the cid stay the same.
const forged = await plcFixture();
const forgedOp = { ...forged.log[0]!.operation, verificationMethods: { 'didpkg-1': `did:key:${plc.releaseKey}` } };
const files: Record<string, () => Response> = {
  [`${WEB_HOST}/pkgs/did.jsonl`]: () => new Response(fx.jsonl(fx.log)),
  [`${PLC_HOST}/${plc.did}/log/audit`]: () => Response.json(plc.log),
  [`${PLC_HOST}/${forged.did}/log/audit`]: () => Response.json([{ ...forged.log[0]!, operation: forgedOp }]),
};
// The did:btcr2 publisher has an update in a beacon signal. Each CAS gateway has the genesis document and the update.
const btc = await btcr2Fixture({ release: true });
const forgedBtc = await btcr2Fixture({ release: true });
const jcs = (v: unknown) => new TextEncoder().encode(canonicalize(v)!);
const cidOf = (bytes: Uint8Array) => casCid(bytesToHex(sha256(bytes)));
const updateCid = casCid(btc.signal.signalBytes);
const blocks: Record<string, Uint8Array> = {
  [cidOf(jcs(btc.genesisDocument))]: jcs(btc.genesisDocument),
  [updateCid]: jcs(btc.update),
  // A forged block: the genesis document of forgedBtc with the release key of btc. Its hash is not the DID.
  [cidOf(jcs(forgedBtc.genesisDocument))]: jcs({ ...forgedBtc.genesisDocument, verificationMethod: btc.genesisDocument.verificationMethod }),
};
const casReads: string[] = [];
const esplora = btc.esplora().fetch;
const site = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  tls: { cert: Bun.file(certs.cert), key: Bun.file(certs.key) },
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.hostname === ESPLORA_HOST) return esplora(`https://${url.hostname}${url.pathname}${url.search}`, {});
    const cid = CAS_HOSTS.includes(url.hostname) && url.pathname.startsWith('/ipfs/') ? url.pathname.slice('/ipfs/'.length) : undefined;
    if (cid && blocks[cid]) {
      casReads.push(cid);
      return new Response(blocks[cid]);
    }
    return files[`${url.hostname}${url.pathname}`]?.() ?? new Response('not found', { status: 404 });
  },
});
const proxy = await startProxy(hosts, site.port!);
const relay = startRelay(new Map());
const env = proxyEnv(proxy.url, certs.ca);
const dwn = await startDwn({ relayUrl: relay.url, env, main: fileURLToPath(new URL('../dwn/start.ts', import.meta.url)) });
const stock = await startDwn({ relayUrl: relay.url, env });
afterAll(async () => {
  await Promise.all([dwn.stop(), stock.stop(), proxy.stop()]);
  site.stop(true);
  relay.stop();
  rmSync(dir, { recursive: true, force: true });
});

const keyId = `${fx.did}#didpkg-1`;
const writer = (dwnUrl: string, p: { did: string; releaseSecret: Uint8Array } = fx) =>
  new DwnWriter({ dwnUrl, did: p.did, signer: ed25519MessageSigner(p.releaseSecret, `${p.did}#didpkg-1`) });

test('a did:webvh publisher with a Multikey release key writes to the didpkg DWN', async () => {
  const w = writer(dwn.url);
  await w.installProtocol();
  await w.writeIndex({ name: 'hello', index: new TextEncoder().encode('{"releases":{}}') });
});

test('the stock dwn-server refuses the same publisher', async () => {
  await expect(writer(stock.url).installProtocol()).rejects.toThrow(/webvh/);
});

test('a did:plc publisher with a Multikey release key writes to the didpkg DWN', async () => {
  const w = writer(dwn.url, plc);
  await w.installProtocol();
  await w.writeIndex({ name: 'hello', index: new TextEncoder().encode('{"releases":{}}') });
});

test('the stock dwn-server refuses the did:plc publisher', async () => {
  await expect(writer(stock.url, plc).installProtocol()).rejects.toThrow(/Method not supported: plc/);
});

test('the didpkg DWN checks the did:plc audit log: a forged operation fails', async () => {
  const w = writer(dwn.url, { did: forged.did, releaseSecret: plc.releaseSecret });
  await expect(w.installProtocol()).rejects.toThrow(/invalidDidDocument/);
});

test('a did:btcr2 publisher with a Multikey release key writes to the didpkg DWN: CAS gives the genesis document and the update', async () => {
  const w = writer(dwn.url, btc);
  await w.installProtocol();
  await w.writeIndex({ name: 'hello', index: new TextEncoder().encode('{"releases":{}}') });
  expect(casReads).toContain(updateCid);
});

test('the stock dwn-server refuses the did:btcr2 publisher', async () => {
  await expect(writer(stock.url, btc).installProtocol()).rejects.toThrow(/Method not supported: btcr2/);
});

test('the didpkg DWN checks the hash of the did:btcr2 genesis document: a forged CAS block fails', async () => {
  const w = writer(dwn.url, { did: forgedBtc.did, releaseSecret: btc.releaseSecret });
  await expect(w.installProtocol()).rejects.toThrow(/notFound/);
});

test('an Ed25519 Multikey method becomes a JsonWebKey method with no other member', () => {
  const doc = jwkMethods(fx.doc as Parameters<typeof jwkMethods>[0]);
  const x = base64urlnopad.encode(base58.decode(fx.releaseKey.slice(1)).subarray(2));
  expect(doc.verificationMethod).toEqual([{ id: keyId, type: 'JsonWebKey', controller: fx.did, publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x } }]);
  expect(doc.assertionMethod).toEqual(fx.doc.assertionMethod as string[]);
  expect(doc.service).toEqual(fx.doc.service as never);
  // A secp256k1 Multikey method (did:key test vector) does not change.
  const k1 = { id: '#k1', type: 'Multikey', controller: fx.did, publicKeyMultibase: 'zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme' };
  expect(jwkMethods({ id: fx.did, verificationMethod: [k1], authentication: [k1] })).toEqual({ id: fx.did, verificationMethod: [k1], authentication: [k1] });
});

test('a resolution error gets the Enbox code; a transient error gets the cause networkUnavailable', () => {
  expect(toEnbox(failure('NOT_FOUND', 'no log')).didResolutionMetadata).toEqual({ error: 'notFound', errorMessage: 'no log' });
  expect(toEnbox(failure('INVALID_DID_DOCUMENT', 'bad entry')).didResolutionMetadata.error).toBe('invalidDidDocument');
  expect(toEnbox(failure('INTERNAL_ERROR', 'timeout', { transient: true })).didResolutionMetadata)
    .toEqual({ error: 'internalError', errorMessage: 'timeout', errorCause: 'networkUnavailable' });
});
