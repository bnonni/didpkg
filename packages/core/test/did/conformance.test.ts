// The conformance suite passes for 6 drivers.
import { expect, test } from 'bun:test';
import { DidJwk, DidKey } from '@enbox/dids';
import { runDriverConformance } from '../../src/did/conformance.ts';
import { btcr2Driver } from '../../src/did/drivers/btcr2.ts';
import { dhtDriver } from '../../src/did/drivers/dht.ts';
import { jwkDriver } from '../../src/did/drivers/jwk.ts';
import { keyDriver } from '../../src/did/drivers/key.ts';
import { plcDriver } from '../../src/did/drivers/plc.ts';
import { webDriver } from '../../src/did/drivers/web.ts';
import { webvhDriver } from '../../src/did/drivers/webvh.ts';
import type { FetchLike } from '../../src/did/fetch.ts';
import type { DidMethodDriver } from '../../src/did/types.ts';
import { btcr2Fixture, bytesResponse, dhtFixture, fakeFetch, jsonResponse, plcFixture, textResponse, webvhFixture } from './helpers.ts';
import vectors from './vectors/plc.json' with { type: 'json' };

test('did:key passes', async () => {
  const fails = await runDriverConformance(keyDriver(), {
    valid: ['did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme', (await DidKey.create()).uri],
    invalid: ['did:key:z', 'did:key:abc', 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2do'],
  });
  expect(fails).toEqual([]);
});

test('did:jwk passes', async () => {
  const fails = await runDriverConformance(jwkDriver(), {
    valid: [(await DidJwk.create()).uri, (await DidJwk.create({ options: { algorithm: 'secp256k1' } })).uri],
    invalid: ['did:jwk:e30', 'did:jwk:bm90LWpzb24'],
  });
  expect(fails).toEqual([]);
});

test('did:dht passes', async () => {
  const a = await dhtFixture();
  const b = await dhtFixture();
  const missing = await dhtFixture();
  const relay = 'https://relay.example';
  const { fetch } = fakeFetch({ [`${relay}/${a.id}`]: bytesResponse(await a.payload()), [`${relay}/${b.id}`]: bytesResponse(await b.payload()) });
  const fails = await runDriverConformance(dhtDriver({ relays: [relay], fetch }), {
    valid: [a.did, b.did],
    invalid: ['did:dht:abc', `did:dht:${a.id}y`],
    notFound: [missing.did],
  });
  expect(fails).toEqual([]);
});

test('did:web passes', async () => {
  const did = 'did:web:bnonni.github.io:didpkg-pages';
  const { fetch } = fakeFetch({
    'https://bnonni.github.io/didpkg-pages/did.json': jsonResponse({
      id: did,
      verificationMethod: [{ id: '#didpkg-1', type: 'Multikey', controller: did, publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' }],
      assertionMethod: ['#didpkg-1'],
      service: [{ id: '#pkg', type: 'DIDPackageRepository', serviceEndpoint: 'https://bnonni.github.io/didpkg-pages/' }],
    }),
  });
  const fails = await runDriverConformance(webDriver({ fetch }), {
    valid: [did],
    invalid: ['did:web:example.com%3A0', 'did:web:a::b'],
    notFound: ['did:web:none.example'],
  });
  expect(fails).toEqual([]);
});

test('did:webvh passes', async () => {
  const a = await webvhFixture();
  const b = await webvhFixture('pkg.example.com:8443', ['dids', 'bob']);
  const gone = await webvhFixture('gone.example.com');
  const { fetch } = fakeFetch({
    [a.url]: textResponse(a.jsonl(await a.update(a.log, 'https://two.example.com/'))),
    [b.url]: textResponse(b.jsonl(b.log)),
    [gone.url]: textResponse(gone.jsonl(await gone.deactivate(gone.log))),
  });
  const scid = a.did.split(':')[2];
  const fails = await runDriverConformance(webvhDriver({ fetch }), {
    valid: [a.did, b.did],
    invalid: ['did:webvh:abc', `did:webvh:${scid}`],
    notFound: [a.did.replace('pkg.example.com', 'none.example.com')],
    deactivated: [gone.did],
  });
  expect(fails).toEqual([]);
});

test('did:plc passes', async () => {
  const a = await plcFixture();
  const gone = await plcFixture();
  const legacy = 'did:plc:yk4dd2qkboz2yv6tpubpc6co';
  const { fetch } = fakeFetch({
    [a.url]: jsonResponse(a.update(a.log, 'https://two.example.com/', 'recovery')),
    [`https://plc.directory/${legacy}/log/audit`]: jsonResponse(vectors[legacy].auditLog),
    [gone.url]: jsonResponse(gone.tombstone(gone.log)),
  });
  const fails = await runDriverConformance(plcDriver({ fetch }), {
    valid: [a.did, legacy],
    invalid: ['did:plc:abc', legacy.toUpperCase().replace('DID:PLC:', 'did:plc:'), 'did:plc:ewvi7nxzyoun6zhxrhs64oi1'],
    notFound: ['did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'],
    deactivated: [gone.did],
  });
  expect(fails).toEqual([]);
});

test('did:btcr2 passes', async () => {
  const a = await btcr2Fixture();
  const b = await btcr2Fixture();
  const fetches = [a.esplora().fetch, b.esplora([]).fetch];
  const fetch: FetchLike = async (url, init) => {
    for (const f of fetches) {
      const res = await f(url, init);
      if (res.status !== 404) return res;
    }
    return new Response('not found', { status: 404 });
  };
  const sidecar = async (did: string) => (did === a.did ? { genesisDocument: a.genesisDocument, updates: [a.update] } : undefined);
  const fails = await runDriverConformance(btcr2Driver({ fetch, sidecar }), {
    valid: [a.did, b.k1],
    invalid: ['did:btcr2:x1qqqq', a.did.slice(0, -1) + (a.did.endsWith('q') ? 'p' : 'q'), 'did:btcr2:' + a.did.slice(10).toUpperCase() + 'q'],
    notFound: [b.did],
  });
  expect(fails).toEqual([]);
});

test('a broken driver fails with one message per defect', async () => {
  const broken: DidMethodDriver = {
    method: 'Bad',
    verification: 'magic' as never,
    history: false,
    freshMs: -1,
    async resolve(did) {
      if (did.endsWith(':throw')) throw new Error('boom');
      if (did.endsWith(':gone')) return { didResolutionMetadata: {}, didDocument: { id: did }, didDocumentMetadata: { deactivated: true } };
      if (did.endsWith(':nf')) return { didResolutionMetadata: { error: { type: 'notFound' } }, didDocument: null, didDocumentMetadata: {} };
      return {
        didResolutionMetadata: {},
        didDocument: {
          id: did,
          verificationMethod: [{ id: 'did:other:1#k', type: 'Multikey', controller: did, publicKeyMultibase: 'z' }],
          assertionMethod: ['#missing'],
          service: [{ id: '#s', type: 'X' } as never],
          created: new Date(0) as never,
        },
        didDocumentMetadata: {},
      };
    },
  };
  const fails = await runDriverConformance(broken, { valid: ['did:Bad:1', 'did:Bad:throw'], notFound: ['did:Bad:nf'], deactivated: ['did:Bad:gone'] });
  const expected = [
    'method "Bad" is not a DID method name',
    'verification "magic" is not known',
    'freshMs is not a number >= 0',
    'did:Bad:1: the result has a value that is not JSON',
    'verification method id "did:other:1#k" is not a fragment of the DID',
    'assertionMethod refers to #missing, which is not in verificationMethod',
    'service #s has no serviceEndpoint',
    'did:Bad:throw: resolve threw boom',
    'did:Bad:nf: the driver gives notFound, not NOT_FOUND',
    'did:Bad:gone: a deactivated DID gives a didDocument',
  ];
  for (const e of expected) expect([e, fails.some((f) => f.includes(e))]).toEqual([e, true]);
});
