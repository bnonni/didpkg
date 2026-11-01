// did:btcr2 driver with a fake Esplora API. The fixture is a testnet4 x1 DID with one update in a beacon signal.
import { DidBtcr2 } from '@did-btcr2/method';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { btcr2Driver, type Btcr2DriverOptions, type Sidecar } from '../../src/did/drivers/btcr2.ts';
import { DID_ERROR_NS } from '../../src/did/errors.ts';
import type { FetchLike } from '../../src/did/fetch.ts';
import type { DidResolutionResult } from '../../src/did/types.ts';
import { BTCR2_ESPLORA as ESPLORA, btcr2Fixture, fakeFetch, hangingFetch } from './helpers.ts';

const ctx = { signal: new AbortController().signal };
const code = (r: DidResolutionResult) => r.didResolutionMetadata.error?.type.slice(DID_ERROR_NS.length);
const detail = (r: DidResolutionResult) => r.didResolutionMetadata.error?.detail;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const services = (r: DidResolutionResult) => r.didDocument?.service?.map((s) => [s.id, s.serviceEndpoint]);

const f = await btcr2Fixture();
const full: Sidecar = { genesisDocument: f.genesisDocument, updates: [f.update] };
const driver = (fetch: FetchLike, options: Btcr2DriverOptions = {}) => btcr2Driver({ fetch, sidecar: async () => copy(full), ...options });
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z');

test('an x1 DID with one update resolves to version 2', async () => {
  const { fetch, calls } = f.esplora();
  const r = await driver(fetch).resolve(f.did, {}, ctx);
  expect(r.didResolutionMetadata).toEqual({ source: ESPLORA, verification: 'partial' });
  expect(r.didDocumentMetadata).toEqual({ versionId: '2', confirmations: f.tip - f.signal.blockHeight + 1, updated: iso(f.signal.mediantime), deactivated: false });
  expect(r.didDocument?.id).toBe(f.did);
  expect(services(r)?.slice(-2)).toEqual([[`${f.did}#pkg`, 'https://pkg.example.com/'], [`${f.did}#pkg-2`, 'https://mirror.example.com/']]);
  expect(calls).toContain(`${ESPLORA}/block/${f.signal.blockHash}`);
  expect(calls.every((u) => u.startsWith(`${ESPLORA}/`))).toBe(true);
});

test('versionId 1 gives the genesis document with no updated time', async () => {
  const r = await driver(f.esplora().fetch).resolve(f.did, { versionId: '1' }, ctx);
  expect(r.didResolutionMetadata.error).toBeUndefined();
  expect(r.didDocumentMetadata).toEqual({ versionId: '1', confirmations: 0, deactivated: false });
  expect(services(r)?.at(-1)).toEqual([`${f.did}#pkg`, 'https://pkg.example.com/']);
});

test('a signal with fewer confirmations than minConf does not count', async () => {
  const r = await driver(f.esplora().fetch, { minConf: f.tip - f.signal.blockHeight + 2 }).resolve(f.did, {}, ctx);
  expect(r.didDocumentMetadata).toEqual({ versionId: '1', confirmations: 0, deactivated: false });
});

test('no genesis document in the sidecar data gives NOT_FOUND', async () => {
  for (const sidecar of [undefined, async () => ({ updates: [f.update] })]) {
    const r = await driver(f.esplora().fetch, { sidecar }).resolve(f.did, {}, ctx);
    expect(code(r)).toBe('NOT_FOUND');
    expect(detail(r)).toContain('no genesis document');
  }
});

test('a signal with no update in the sidecar data gives NOT_FOUND (MISSING_UPDATE_DATA)', async () => {
  const r = await driver(f.esplora().fetch, { sidecar: async () => ({ genesisDocument: f.genesisDocument }) }).resolve(f.did, {}, ctx);
  expect(code(r)).toBe('NOT_FOUND');
  expect(detail(r)).toContain(`MISSING_UPDATE_DATA: the sidecar data has no BTCR2 Signed Update with the hash ${f.signal.signalBytes}`);
});

test('an update with a bad signature gives INVALID_DID_DOCUMENT (INVALID_DID_UPDATE)', async () => {
  const bad = copy(f.update);
  const proof = bad.proof as unknown as { proofValue: string };
  proof.proofValue = proof.proofValue.slice(0, 10) + (proof.proofValue[10] === 'a' ? 'b' : 'a') + proof.proofValue.slice(11);
  const signalBytes = bytesToHex(sha256(new TextEncoder().encode(canonicalize(bad)!)));
  const r = await driver(f.esplora([{ ...f.signal, signalBytes }]).fetch, { sidecar: async () => ({ genesisDocument: f.genesisDocument, updates: [bad] }) }).resolve(f.did, {}, ctx);
  expect(code(r)).toBe('INVALID_DID_DOCUMENT');
  expect(detail(r)).toStartWith('INVALID_DID_UPDATE: ');
});

test('a k1 DID with no signal gives the deterministic document', async () => {
  const { fetch } = f.esplora([]);
  const r = await btcr2Driver({ fetch }).resolve(f.k1, {}, ctx);
  expect(r.didResolutionMetadata.error).toBeUndefined();
  expect(r.didDocument?.assertionMethod).toEqual([`${f.k1}#initialKey`]);
  expect(r.didDocumentMetadata).toEqual({ versionId: '1', confirmations: 0, deactivated: false });
});

test('a bad identifier gives INVALID_DID with no request', async () => {
  const { fetch, calls } = fakeFetch({});
  for (const did of ['did:btcr2:x1qqqq', f.did.slice(0, -1) + (f.did.endsWith('q') ? 'p' : 'q')]) {
    expect(code(await driver(fetch).resolve(did, {}, ctx))).toBe('INVALID_DID');
  }
  expect(calls).toEqual([]);
});

test('a network with no Esplora API gives INTERNAL_ERROR', async () => {
  const did = DidBtcr2.create(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey()), { idType: 'KEY', network: 'regtest' });
  const r = await btcr2Driver({ fetch: fakeFetch({}).fetch }).resolve(did, {}, ctx);
  expect(code(r)).toBe('INTERNAL_ERROR');
  expect(detail(r)).toBe('no Esplora API for the network regtest');
  expect(r.didResolutionMetadata.transient).toBeUndefined();
});

test('the esplora option replaces the default of the network', async () => {
  const other = 'https://esplora.example.com/api';
  const { fetch, calls } = fakeFetch({});
  const r = await driver(fetch, { esplora: { testnet4: `${other}/` } }).resolve(f.did, {}, ctx);
  expect(r.didResolutionMetadata.source).toBe(other);
  expect(calls[0]).toBe(`${other}/blocks/tip/height`);
});

test('HTTP 503 and a timeout are transient; no chain listing is not', async () => {
  const busy = f.esplora(undefined, { [`${ESPLORA}/blocks/tip/height`]: new Response('busy', { status: 503 }) });
  const unavailable = await driver(busy.fetch).resolve(f.did, {}, ctx);
  expect(code(unavailable)).toBe('INTERNAL_ERROR');
  expect(unavailable.didResolutionMetadata.transient).toBe(true);

  const slow = await driver(hangingFetch, { timeoutMs: 20 }).resolve(f.did, {}, ctx);
  expect(code(slow)).toBe('INTERNAL_ERROR');
  expect(slow.didResolutionMetadata.transient).toBe(true);

  const electrum = await driver(fakeFetch({ [`${ESPLORA}/blocks/tip/height`]: new Response(String(f.tip)) }).fetch).resolve(f.did, {}, ctx);
  expect(code(electrum)).toBe('INTERNAL_ERROR');
  expect(detail(electrum)).toContain('/address/:address/txs/chain');
  expect(electrum.didResolutionMetadata.transient).toBeUndefined();
});

test('a sidecar function that throws gives INTERNAL_ERROR', async () => {
  const r = await driver(f.esplora().fetch, { sidecar: async () => { throw new Error('disk error'); } }).resolve(f.did, {}, ctx);
  expect(code(r)).toBe('INTERNAL_ERROR');
  expect(detail(r)).toBe('disk error');
});
