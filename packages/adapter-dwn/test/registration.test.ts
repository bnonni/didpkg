// The registration client against the pinned @enbox/dwn-server 0.1.45 with a tenant store, a terms file and proof of work.
// The test difficulty needs about 2^16 hashes; the server default needs about 2^24.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getTerms, register, solve, type Challenge } from '../src/registration.ts';
import { startPublisher } from './server.ts';

const dir = mkdtempSync(join(tmpdir(), 'didpkg-terms-'));
// Not only ASCII: the client must hash the UTF-8 bytes, as the server does.
const text = 'Test terms of service.\nCafé: only didpkg packages. ✓\n';
writeFileSync(join(dir, 'terms.txt'), text);
const EASY = `0000${'F'.repeat(60)}`;
const { fx, dwn, writer, stop } = await startPublisher({
  DWN_REGISTRATION_STORE_URL: 'sqlite://data/registration.db',
  DWN_TTL_CACHE_URL: 'sqlite://data/registration.db',
  DWN_REGISTRATION_PROOF_OF_WORK_ENABLED: 'true',
  DWN_REGISTRATION_PROOF_OF_WORK_INITIAL_MAX_HASH: EASY,
  DWN_TERMS_OF_SERVICE_FILE_PATH: join(dir, 'terms.txt'),
});
afterAll(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

const te = new TextEncoder();
const challenge = async (): Promise<Challenge> => (await fetch(`${dwn.url}/registration/proof-of-work`)).json() as Promise<Challenge>;
const post = (body: unknown) => fetch(`${dwn.url}/registration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('getTerms gives the text of the server and the SHA-256 hex of its UTF-8 bytes', async () => {
  expect(await getTerms(`${dwn.url}/`)).toEqual({ text, hash: bytesToHex(sha256(te.encode(text))) });
});

test('before the registration, a write fails', async () => {
  expect(await writer.installProtocol().then(() => 'accepted', (e: Error) => e.message)).toContain('DWN 401 Not a registered tenant');
});

test('the server refuses a terms hash that is not the hash of its terms', async () => {
  const terms = { text, hash: '0'.repeat(64) };
  expect(await register(dwn.url, fx.did, { terms }).then(() => 'accepted', (e: Error) => e.message))
    .toMatch(/^registration: HTTP 400 .*RegistrationManagerInvalidOrOutdatedTermsOfServiceHash/);
});

test('the server refuses a response nonce that is not a solution', async () => {
  const c = await challenge();
  const registrationData = { did: fx.did, termsOfServiceHash: (await getTerms(dwn.url))!.hash };
  const data = JSON.stringify(registrationData);
  let responseNonce: string;
  do responseNonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  while (BigInt(`0x${bytesToHex(sha256(te.encode(c.challengeNonce + responseNonce + data)))}`) <= BigInt(`0x${EASY}`));
  const res = await post({ registrationData, proofOfWork: { challengeNonce: c.challengeNonce, responseNonce } });
  expect([res.status, await res.text()]).toEqual([400, expect.stringContaining('ProofOfWorkInsufficientSolutionNonce')]);
});

test('solve finds a solution: the SHA-256 is not more than the maximum', async () => {
  const c = await challenge();
  const nonce = await solve(c, 'request data');
  expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  expect(BigInt(`0x${bytesToHex(sha256(te.encode(c.challengeNonce + nonce + 'request data')))}`) <= BigInt(`0x${EASY}`)).toBe(true);
});

test('solve reports progress and stops at an abort', async () => {
  const progress: number[] = [];
  const impossible = { challengeNonce: 'A'.repeat(64), maximumAllowedHashValue: '0'.repeat(64) };
  const ac = new AbortController();
  const onProgress = (n: number) => { progress.push(n); ac.abort(); };
  expect(await solve(impossible, 'x', { signal: ac.signal, onProgress }).then(() => 'solved', (e: Error) => e.name)).toBe('AbortError');
  expect(progress).toEqual([65536]);
  expect(await solve({ ...impossible, challengeNonce: 'not hex' }, 'x').catch((e: Error) => e.message)).toBe('proof-of-work challenge: not 64 hex digits');
});

test('after the registration with the terms, the DID writes', async () => {
  const terms = (await getTerms(dwn.url))!;
  await register(dwn.url, fx.did, { terms });
  await writer.installProtocol();
  await writer.publish({ name: 'hello', version: '1.0.0', release: te.encode('{}'), tarball: te.encode('tgz'), index: te.encode('{}') });
  // A second registration of the same DID is a no-op.
  await register(dwn.url, fx.did, { terms });
});
