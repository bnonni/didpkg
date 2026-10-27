import { expect, test } from 'bun:test';
import { fetchBytes, FetchError, isPrivateHost, MAX_RESPONSE_BYTES } from '../../src/did/fetch.ts';
import { fakeFetch, hangingFetch } from './helpers.ts';

const hostOf = (url: string) => new URL(url).hostname;

test('isPrivateHost: literal private, loopback and link-local addresses', () => {
  const priv = ['http://localhost', 'http://a.localhost', 'http://127.0.0.1', 'http://0x7f.1', 'http://2130706433', 'http://10.1.2.3',
    'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.1.1', 'http://169.254.169.254', 'http://100.64.0.1', 'http://0.0.0.0',
    'http://224.0.0.1', 'http://[::1]', 'http://[::]', 'http://[fd00::1]', 'http://[fe80::1]', 'http://[::ffff:127.0.0.1]', 'http://[::ffff:10.0.0.1]'];
  const pub = ['https://relay.pkarr.org', 'https://8.8.8.8', 'https://172.32.0.1', 'https://100.128.0.1', 'https://[2606:4700::1111]',
    'https://[::ffff:8.8.8.8]', 'https://localhost.example.com'];
  for (const u of priv) expect([u, isPrivateHost(hostOf(u))]).toEqual([u, true]);
  for (const u of pub) expect([u, isPrivateHost(hostOf(u))]).toEqual([u, false]);
});

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as FetchError;
  }
  throw new Error('no error');
};

test('fetchBytes: https only, no private address, no credentials', async () => {
  const { fetch, calls } = fakeFetch({});
  expect((await reason(fetchBytes('http://example.com/x', { fetch }))).message).toContain('only https');
  expect((await reason(fetchBytes('https://127.0.0.1/x', { fetch }))).message).toContain('private address');
  expect((await reason(fetchBytes('https://u:p@example.com/x', { fetch }))).message).toContain('credentials');
  expect(calls).toEqual([]);
  const ok = fakeFetch({ 'http://127.0.0.1:1/x': new Response('hi') });
  expect((await fetchBytes('http://127.0.0.1:1/x', { fetch: ok.fetch, allowPrivateHosts: true })).body).toEqual(new TextEncoder().encode('hi'));
});

test('fetchBytes returns 4xx and 5xx statuses', async () => {
  const { fetch } = fakeFetch({ 'https://a.example/x': new Response('no', { status: 503 }) });
  expect((await fetchBytes('https://a.example/x', { fetch })).status).toBe(503);
  expect((await fetchBytes('https://a.example/y', { fetch })).status).toBe(404);
});

test('fetchBytes follows a redirect on the same host only', async () => {
  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
  const { fetch, calls } = fakeFetch({
    'https://a.example/1': redirect('/2'),
    'https://a.example/2': new Response('done'),
    'https://a.example/out': redirect('https://b.example/x'),
    'https://a.example/down': redirect('http://a.example/x'),
    'https://a.example/loop': redirect('/loop'),
  });
  const r = await fetchBytes('https://a.example/1', { fetch });
  expect([r.status, r.url, new TextDecoder().decode(r.body)]).toEqual([200, 'https://a.example/2', 'done']);
  expect((await reason(fetchBytes('https://a.example/out', { fetch }))).message).toContain('redirect to b.example is not allowed');
  expect((await reason(fetchBytes('https://a.example/down', { fetch }))).message).toContain('only https');
  const loop = await reason(fetchBytes('https://a.example/loop', { fetch }));
  expect([loop.message.includes('more than 3 redirects'), loop.transient]).toEqual([true, false]);
  expect(calls).not.toContain('https://b.example/x');
});

test('fetchBytes stops at the size limit', async () => {
  const big = new Uint8Array(MAX_RESPONSE_BYTES + 1);
  const stream = () => new Response(new ReadableStream({ start(c) { c.enqueue(big.subarray(0, 1000)); c.enqueue(big); c.close(); } }));
  const { fetch } = fakeFetch({
    'https://a.example/declared': new Response(big),
    'https://a.example/stream': stream,
    'https://a.example/small': new Response(new Uint8Array(10)),
  });
  const declared = await reason(fetchBytes('https://a.example/declared', { fetch }));
  expect([declared.message.includes('larger than'), declared.transient]).toEqual([true, false]);
  expect((await reason(fetchBytes('https://a.example/stream', { fetch }))).message).toContain('larger than');
  expect((await reason(fetchBytes('https://a.example/small', { fetch, maxBytes: 9 }))).message).toContain('larger than 9 bytes');
  expect((await fetchBytes('https://a.example/small', { fetch, maxBytes: 10 })).body.length).toBe(10);
});

test('fetchBytes: a timeout and a network failure are transient', async () => {
  const t0 = Date.now();
  const slow = await reason(fetchBytes('https://a.example/x', { fetch: hangingFetch, timeoutMs: 50 }));
  expect([slow.message, slow.transient]).toEqual(['a.example: no response in 50 ms', true]);
  expect(Date.now() - t0).toBeLessThan(1000);
  const controller = new AbortController();
  const aborted = reason(fetchBytes('https://a.example/x', { fetch: hangingFetch, signal: controller.signal }));
  controller.abort();
  expect((await aborted).message).toBe('a.example: aborted');
  const down = await reason(fetchBytes('https://a.example/x', { fetch: async () => { throw new TypeError('fetch failed'); } }));
  expect([down.message, down.transient]).toEqual(['a.example: fetch failed', true]);
});
