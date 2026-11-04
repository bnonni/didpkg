// The DID resolver of the didpkg DWN (deploy/dwn). A did:webvh publisher and a did:plc publisher have a Multikey release key.
// Each writes to a dwn-server that runs deploy/dwn/start.ts. The stock main.js of dwn-server refuses them.
// The DID hosts are web.didpkg.test and plc.directory: each dwn-server gets the CONNECT proxy and the demo CA of
// demo/tls.ts, and the proxy sends both names to a local TLS site. Thus the did:plc driver reads the audit log of the site.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58, base64urlnopad } from '@scure/base';
import { makeCerts, proxyEnv, startProxy, WEB_HOST } from '../../demo/tls.ts';
import { failure } from '../../packages/core/src/did/errors.ts';
import { PLC_DIRECTORY } from '../../packages/core/src/did/drivers/plc.ts';
import { plcFixture, webvhFixture } from '../../packages/core/test/did/helpers.ts';
import { DwnWriter, ed25519MessageSigner } from '../../packages/adapter-dwn/src/writer.ts';
import { startDwn, startRelay } from '../../packages/adapter-dwn/test/server.ts';
import { jwkMethods, toEnbox } from '../dwn/resolver.ts';

const dir = mkdtempSync(join(tmpdir(), 'didpkg-dwn-webvh-'));
const PLC_HOST = new URL(PLC_DIRECTORY).host;
const certs = await makeCerts(dir, [WEB_HOST, PLC_HOST]);
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
const site = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  tls: { cert: Bun.file(certs.cert), key: Bun.file(certs.key) },
  fetch: (req) => files[`${new URL(req.url).hostname}${new URL(req.url).pathname}`]?.() ?? new Response('not found', { status: 404 }),
});
const proxy = await startProxy([WEB_HOST, PLC_HOST], site.port!);
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
