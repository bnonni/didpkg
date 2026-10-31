// did:plc driver with a fake fetch. The vectors are audit logs and documents from plc.directory (2026-10-31).
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base64urlnopad } from '@scure/base';
import { expect, test } from 'bun:test';
import { DID_ERROR_NS } from '../../src/did/errors.ts';
import { plcDriver } from '../../src/did/drivers/plc.ts';
import type { DidResolutionResult } from '../../src/did/types.ts';
import { fakeFetch, hangingFetch, jsonResponse, plcFixture } from './helpers.ts';
import vectors from './vectors/plc.json' with { type: 'json' };

const ctx = { signal: new AbortController().signal };
const code = (r: DidResolutionResult) => r.didResolutionMetadata.error?.type.slice(DID_ERROR_NS.length);
const detail = (r: DidResolutionResult) => r.didResolutionMetadata.error?.detail;
const endpoint = (r: DidResolutionResult) => r.didDocument?.service?.find((s) => s.id === '#pkg')?.serviceEndpoint;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const resolveLog = (did: string, log: unknown) => plcDriver({ fetch: fakeFetch({ [`https://plc.directory/${did}/log/audit`]: jsonResponse(log) }).fetch }).resolve(did, {}, ctx);

test('the document from each vector log is the document of the directory', async () => {
  for (const [did, v] of Object.entries(vectors)) {
    const { fetch, calls } = fakeFetch({ [`https://plc.directory/${did}/log/audit`]: jsonResponse(v.auditLog) });
    const r = await plcDriver({ fetch }).resolve(did, {}, ctx);
    expect(r.didResolutionMetadata).toEqual({ source: calls[0], verification: 'partial' });
    expect(r.didDocument).toEqual(v.document as never);
    expect(calls).toEqual([`https://plc.directory/${did}/log/audit`]);
  }
  // The genesis operation of this DID is a legacy create operation.
  const legacy = await resolveLog('did:plc:yk4dd2qkboz2yv6tpubpc6co', vectors['did:plc:yk4dd2qkboz2yv6tpubpc6co'].auditLog);
  expect(legacy.didDocumentMetadata).toEqual({ created: '2022-11-17T01:07:13Z', updated: '2025-12-19T19:50:27Z' });
});

test('a new DID gives the release key, the #pkg service and no updated time', async () => {
  const f = await plcFixture();
  const r = await resolveLog(f.did, f.log);
  expect(r.didDocument).toEqual({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: f.did,
    alsoKnownAs: ['at://pkg.example.com'],
    verificationMethod: [{ id: `${f.did}#didpkg-1`, type: 'Multikey', controller: f.did, publicKeyMultibase: f.releaseKey }],
    service: [{ id: '#pkg', type: 'DIDPackageRepository', serviceEndpoint: 'https://pkg.example.com/' }],
  });
  expect(r.didDocumentMetadata).toEqual({ created: '2026-01-01T00:00:00Z' });
});

test('the recovery key and the rotation key both sign updates, and a nullified operation does not count', async () => {
  const f = await plcFixture();
  const two = f.update(f.log, 'https://two.example.com/', 'recovery');
  expect(endpoint(await resolveLog(f.did, two))).toBe('https://two.example.com/');
  const nullified = f.update(f.log, 'https://evil.example.com/');
  nullified[1]!.nullified = true;
  const r = await resolveLog(f.did, f.update(nullified, 'https://three.example.com/', 'recovery'));
  expect([endpoint(r), r.didDocumentMetadata]).toEqual(['https://three.example.com/', { created: '2026-01-01T00:00:00Z', updated: '2026-01-04T00:00:00Z' }]);
});

test('a tombstone gives no document and deactivated true', async () => {
  const f = await plcFixture();
  const r = await resolveLog(f.did, f.tombstone(f.log));
  expect([r.didResolutionMetadata.error, r.didDocument, r.didDocumentMetadata.deactivated]).toEqual([undefined, null, true]);
  const after = f.tombstone(f.log);
  after.push(f.entry(f.sign(f.operation('https://late.example.com/', after[1]!.cid))));
  expect(detail(await resolveLog(f.did, after))).toBe('operation 2 comes after the tombstone');
});

test('a changed operation, a key that is not a rotation key and a broken chain fail', async () => {
  const f = await plcFixture();
  const changed = copy(f.update(f.log, 'https://two.example.com/'));
  (changed[1]!.operation.services as { pkg: { endpoint: string } }).pkg.endpoint = 'https://evil.example.com/';
  changed[1]!.cid = f.entry(changed[1]!.operation).cid;
  expect(detail(await resolveLog(f.did, changed))).toBe('operation 1: no rotation key signed it');

  const other = [...f.log, f.entry(f.sign(f.operation('https://evil.example.com/', f.log[0]!.cid), 'other'))];
  expect(detail(await resolveLog(f.did, other))).toBe('operation 1: no rotation key signed it');

  const fork = f.update(f.log, 'https://two.example.com/');
  fork.push(f.entry(f.sign(f.operation('https://three.example.com/', f.log[0]!.cid))));
  expect(detail(await resolveLog(f.did, fork))).toBe('operation 2 does not point to the operation before it');

  const badCid = copy(f.log);
  badCid[0]!.cid = fork[1]!.cid;
  expect(detail(await resolveLog(f.did, badCid))).toStartWith('operation 0 has the cid');
});

test('a high-S signature and a padded signature fail', async () => {
  const f = await plcFixture();
  const log = f.update(f.log, 'https://two.example.com/');
  const sig = base64urlnopad.decode(log[1]!.operation.sig as string);
  const s = BigInt('0x' + Buffer.from(sig.subarray(32)).toString('hex'));
  const highS = Uint8Array.of(...sig.subarray(0, 32), ...Buffer.from((secp256k1.Point.Fn.ORDER - s).toString(16).padStart(64, '0'), 'hex'));
  for (const bad of [base64urlnopad.encode(highS), `${log[1]!.operation.sig as string}=`]) {
    const tampered = copy(log);
    tampered[1]!.operation.sig = bad;
    tampered[1]!.cid = f.entry(tampered[1]!.operation).cid;
    expect(code(await resolveLog(f.did, tampered))).toBe('INVALID_DID_DOCUMENT');
  }
});

test('the log of another DID and a legacy create after the genesis fail', async () => {
  const f = await plcFixture();
  const g = await plcFixture();
  const swapped = g.log.map((e) => ({ ...e, did: f.did }));
  expect(detail(await resolveLog(f.did, swapped))).toBe('the hash of the genesis operation is not the DID');
  expect(detail(await resolveLog(f.did, g.log))).toBe('audit log entry 0 is for another DID');

  const legacy = vectors['did:plc:yk4dd2qkboz2yv6tpubpc6co'].auditLog[0]!.operation;
  const late = [...f.log, f.entry(f.sign({ ...legacy, prev: f.log[0]!.cid }))];
  expect(detail(await resolveLog(f.did, late))).toBe('operation 1 has the type "create"');
});

test('HTTP 404, 503, 403, a timeout, an empty log and a body that is not JSON', async () => {
  const f = await plcFixture();
  const at = (body: string, status = 200) => plcDriver({ fetch: fakeFetch({ [f.url]: new Response(body, { status }) }).fetch }).resolve(f.did, {}, ctx);
  expect(code(await at('{"message":"DID not registered"}', 404))).toBe('NOT_FOUND');
  const r503 = await at('', 503);
  expect([code(r503), r503.didResolutionMetadata.transient]).toEqual(['INTERNAL_ERROR', true]);
  const r403 = await at('', 403);
  expect([code(r403), r403.didResolutionMetadata.transient]).toEqual(['INTERNAL_ERROR', undefined]);
  const late = await plcDriver({ fetch: hangingFetch, timeoutMs: 20 }).resolve(f.did, {}, ctx);
  expect([code(late), late.didResolutionMetadata.transient]).toEqual(['INTERNAL_ERROR', true]);
  expect(code(await at('[]'))).toBe('NOT_FOUND');
  expect(code(await at('<html>'))).toBe('INVALID_DID_DOCUMENT');
  expect(code(await at('{"did":1}'))).toBe('INVALID_DID_DOCUMENT');
});

test('a DID that is not 24 lowercase base32 characters fails with no request', async () => {
  const { fetch, calls } = fakeFetch({});
  const d = plcDriver({ fetch });
  for (const did of ['did:plc:EWVI7NXZYOUN6ZHXRHS64OIZ', 'did:plc:ewvi7nxzyoun6zhxrhs64oi', 'did:plc:ewvi7nxzyoun6zhxrhs64oi0', 'did:plc:ewvi7nxzyoun6zhxrhs64oiz:x']) {
    expect(code(await d.resolve(did, {}, ctx))).toBe('INVALID_DID');
  }
  expect(calls).toEqual([]);
});

test('the directory option sets the audit log URL', async () => {
  const f = await plcFixture();
  const { fetch, calls } = fakeFetch({ [`https://plc.example.com/${f.did}/log/audit`]: jsonResponse(f.log) });
  const r = await plcDriver({ fetch, directory: 'https://plc.example.com/' }).resolve(f.did, {}, ctx);
  expect([r.didDocument?.id, calls]).toEqual([f.did, [`https://plc.example.com/${f.did}/log/audit`]]);
});
