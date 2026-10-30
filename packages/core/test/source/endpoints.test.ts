// Endpoint selection (ADR 0003 section 4): exact types, the DWN first, document order.
import { expect, test } from 'bun:test';
import type { DidDocument } from '../../src/did/types.ts';
import { MAX_ENDPOINTS, storageEndpoints } from '../../src/source/index.ts';

const DID = 'did:example:pub';
const doc = (service: unknown[]): DidDocument => ({ id: DID, service } as DidDocument);
const list = (d: DidDocument) => storageEndpoints(d).map((e) => `${e.type} ${e.url}`);
const repo = (id: string, serviceEndpoint: unknown, type: unknown = 'DIDPackageRepository') => ({ id, type, serviceEndpoint });

test('the type match is exact: DIDPackageRepository and DecentralizedWebNode only', () => {
  const near = [
    'DidPackageRegistry', 'DidPackageRepository', 'didpackagerepository', 'DIDPackageRepository ', 'DIDPackageRepositories',
    'https://didpkg.dev/ns#DIDPackageRepository', 'DWN', 'decentralizedwebnode',
  ];
  const d = doc([
    ...near.map((type, i) => repo(`#n${i}`, `https://near${i}.example/`, type)),
    repo('#pkg', 'https://pkgs.example/'),
    repo('#set', ['https://a.example/', 'https://b.example/'], ['LinkedDomains', 'DIDPackageRepository']),
    repo('#dwn', 'https://dwn.example', 'DecentralizedWebNode'),
  ]);
  expect(list(d)).toEqual([
    'DecentralizedWebNode https://dwn.example',
    'DIDPackageRepository https://pkgs.example/',
    'DIDPackageRepository https://a.example/',
    'DIDPackageRepository https://b.example/',
  ]);
});

test('the DWN endpoints come first, then the repositories, each in document order', () => {
  const d = doc([
    repo('#pkg', ['https://m1.example/', 'https://m2.example/']),
    repo('#dwn', ['https://dwn1.example', 'https://dwn2.example/'], 'DecentralizedWebNode'),
    repo('#pkg2', 'https://m3.example/'),
  ]);
  expect(list(d)).toEqual([
    'DecentralizedWebNode https://dwn1.example',
    'DecentralizedWebNode https://dwn2.example/',
    'DIDPackageRepository https://m1.example/',
    'DIDPackageRepository https://m2.example/',
    'DIDPackageRepository https://m3.example/',
  ]);
});

test('service ids become absolute DID URLs', () => {
  const d = doc([repo('#pkg', 'https://a.example/'), repo(`${DID}#other`, 'https://b.example/')]);
  expect(storageEndpoints(d).map((e) => [e.did, e.serviceId])).toEqual([[DID, `${DID}#pkg`], [DID, `${DID}#other`]]);
});

test('a repository URL must end with "/"; a DWN URL need not', () => {
  const d = doc([repo('#pkg', ['https://a.example/pkgs', 'https://a.example/pkgs/']), repo('#dwn', 'https://dwn.example/x', 'DecentralizedWebNode')]);
  expect(list(d)).toEqual(['DecentralizedWebNode https://dwn.example/x', 'DIDPackageRepository https://a.example/pkgs/']);
});

test('bad endpoint values are skipped', () => {
  const d = doc([
    repo('#map', { origins: ['https://map.example/'] }),
    repo('#mixed', [42, null, { u: 1 }, 'https://ok.example/']),
    repo('#bad', ['not a url/', 'https://user:pw@cred.example/', 'https://q.example/?x=1/', 'https://f.example/#a/', 'https://f2.example/#']),
    { type: 'DIDPackageRepository', serviceEndpoint: 'https://noid.example/' },
    repo('#dup', ['https://ok.example/', 'https://ok.example/']),
  ]);
  expect(list(d)).toEqual(['DIDPackageRepository https://ok.example/']);
  expect(storageEndpoints({ id: DID })).toEqual([]);
});

test(`at most ${MAX_ENDPOINTS} endpoints`, () => {
  const urls = Array.from({ length: 20 }, (_, i) => `https://m${i}.example/`);
  expect(list(doc([repo('#pkg', urls)]))).toEqual(urls.slice(0, MAX_ENDPOINTS).map((u) => `DIDPackageRepository ${u}`));
});
