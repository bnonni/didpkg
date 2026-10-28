// The static HTTPS reader (ADR 0003 sections 3 and 7) on a local static server.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Endpoint, StorageReader, StoredFile } from '@didpkg/core/source';
import { httpsAdapter, layoutPath } from '../src/index.ts';
import { serveDir, type StaticServer } from './serve.ts';

const endpoint = (url: string, type: Endpoint['type'] = 'DIDPackageRepository'): Endpoint =>
  ({ did: 'did:example:pub', serviceId: 'did:example:pub#pkg', type, url });
const bytes = (s: string) => new TextEncoder().encode(s);

let dir: string;
let server: StaticServer | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'didpkg-https-'));
  await mkdir(join(dir, 'hello'));
  await writeFile(join(dir, 'hello/index.json'), '{"i":1}');
  await writeFile(join(dir, 'hello/1.0.0.json'), '{"r":1}');
  await writeFile(join(dir, 'hello/1.0.0.tgz'), new Uint8Array(1000).fill(7));
  await writeFile(join(dir, 'hello/1.0.0+b.1.tgz'), 'build');
});
afterEach(async () => {
  server?.stop();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

function reader(override?: Parameters<typeof serveDir>[1]): StorageReader {
  server = serveDir(dir, override);
  return httpsAdapter({ allowLoopback: true }).reader(endpoint(server.base), { fetch });
}

async function copies(r: StorageReader, file: StoredFile, maxBytes = 1 << 20, signal = AbortSignal.timeout(2000)) {
  const out: Uint8Array[] = [];
  for await (const b of r.read(file, { signal, maxBytes })) out.push(b);
  return out;
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('no error');
}

test('canRead: a public https repository only, unless the loopback test option is on', () => {
  const plain = httpsAdapter();
  const loop = httpsAdapter({ allowLoopback: true });
  const cases: [string, Endpoint['type'], boolean, boolean][] = [
    ['https://mirror.example/pkgs/', 'DIDPackageRepository', true, true],
    ['https://mirror.example/pkgs/', 'DecentralizedWebNode', false, false],
    ['http://mirror.example/pkgs/', 'DIDPackageRepository', false, false],
    ['ftp://mirror.example/pkgs/', 'DIDPackageRepository', false, false],
    ['https://10.0.0.1/', 'DIDPackageRepository', false, false],
    ['https://192.168.1.1/', 'DIDPackageRepository', false, false],
    ['https://[fd00::1]/', 'DIDPackageRepository', false, false],
    ['https://localhost/', 'DIDPackageRepository', false, true],
    ['http://127.0.0.1:8080/', 'DIDPackageRepository', false, true],
    ['http://127.1.2.3/', 'DIDPackageRepository', false, true],
    ['http://[::1]:8080/', 'DIDPackageRepository', false, true],
    ['http://10.0.0.1/', 'DIDPackageRepository', false, false],
    ['ws://127.0.0.1/', 'DIDPackageRepository', false, false],
    ['not a url', 'DIDPackageRepository', false, false],
  ];
  for (const [url, type, plainResult, loopResult] of cases) {
    expect([url, type, plain.canRead(endpoint(url, type)), loop.canRead(endpoint(url, type))]).toEqual([url, type, plainResult, loopResult]);
  }
  expect(plain.kind).toBe('https');
  expect(() => plain.reader(endpoint('http://127.0.0.1:8080/'), { fetch })).toThrow(TypeError);
});

test('read: the exact stored bytes of each file, relative to the base path', async () => {
  const r = reader();
  expect(await copies(r, { kind: 'index', name: 'hello' })).toEqual([bytes('{"i":1}')]);
  expect(await copies(r, { kind: 'release', name: 'hello', version: '1.0.0' })).toEqual([bytes('{"r":1}')]);
  expect(await copies(r, { kind: 'tarball', name: 'hello', version: '1.0.0' })).toEqual([new Uint8Array(1000).fill(7)]);
  expect(await copies(r, { kind: 'tarball', name: 'hello', version: '1.0.0+b.1' })).toEqual([bytes('build')]);
  expect(server!.paths).toEqual(['/repo/hello/index.json', '/repo/hello/1.0.0.json', '/repo/hello/1.0.0.tgz', '/repo/hello/1.0.0%2Bb.1.tgz']);
});

test('read: 404 and 410 mean absent; each other status is a failed endpoint', async () => {
  expect(await copies(reader(), { kind: 'index', name: 'absent' })).toEqual([]);
  for (const status of [410, 403, 500, 204, 206]) {
    server?.stop();
    const r = reader(() => new Response(status === 204 ? null : 'x', { status }));
    if (status === 410) expect(await copies(r, { kind: 'index', name: 'hello' })).toEqual([]);
    else expect((await failure(copies(r, { kind: 'index', name: 'hello' }))).message).toEndWith(`: HTTP ${status}`);
  }
});

test('read: a copy larger than maxBytes fails the endpoint', async () => {
  const r = reader();
  const file: StoredFile = { kind: 'tarball', name: 'hello', version: '1.0.0' };
  expect((await failure(copies(r, file, 999))).message).toContain('larger than 999 bytes');
  expect((await copies(r, file, 1000))[0]!.length).toBe(1000);
});

test('read: a redirect on the same host is followed; a redirect to another host fails', async () => {
  const other = serveDir(dir);
  try {
    const r = reader((url) => {
      if (url.pathname === '/repo/moved/index.json') return Response.redirect('/repo/hello/index.json', 302);
      if (url.pathname === '/repo/away/index.json') return Response.redirect(`${other.base}hello/index.json`, 302);
    });
    expect(await copies(r, { kind: 'index', name: 'moved' })).toEqual([bytes('{"i":1}')]);
    expect((await failure(copies(r, { kind: 'index', name: 'away' }))).message).toContain('a redirect to');
    expect(other.paths).toEqual([]);
  } finally {
    other.stop();
  }
});

test('read: the caller signal stops a slow endpoint', async () => {
  const r = reader(() => new Promise<Response>(() => {}));
  const t0 = Date.now();
  expect((await failure(copies(r, { kind: 'index', name: 'hello' }, 1 << 20, AbortSignal.timeout(50)))).message).toEndWith('aborted');
  expect(Date.now() - t0).toBeLessThan(1000);
});

// A tarball read can take longer than the 5 s default of fetchBytes (ADR 0003 section 5: 30 s).
test('read: no own timer, so only the caller signal sets the time limit', async () => {
  const r = reader();
  const original = AbortSignal.timeout;
  const timers: number[] = [];
  AbortSignal.timeout = (ms: number) => {
    timers.push(ms);
    return original.call(AbortSignal, ms);
  };
  try {
    expect(await copies(r, { kind: 'index', name: 'hello' }, 1 << 20, new AbortController().signal)).toHaveLength(1);
  } finally {
    AbortSignal.timeout = original;
  }
  expect(timers).toEqual([]);
});

test('layoutPath: the static layout v1, and no unsafe segment', () => {
  expect(layoutPath({ kind: 'index', name: 'hello' })).toEqual(['hello', 'index.json']);
  expect(layoutPath({ kind: 'release', name: 'hello', version: '1.0.0-rc.1' })).toEqual(['hello', '1.0.0-rc.1.json']);
  expect(layoutPath({ kind: 'tarball', name: 'a.b-c', version: '1.0.0+b' })).toEqual(['a.b-c', '1.0.0+b.tgz']);
  for (const [name, version] of [['..', '1.0.0'], ['.', '1.0.0'], ['', '1.0.0'], ['a/b', '1.0.0'], ['a\\b', '1.0.0'], ['.hidden', '1.0.0'], ['hello', '../1'], ['hello', '1/0'], ['hello', '']]) {
    expect(() => layoutPath({ kind: 'release', name: name!, version: version! })).toThrow(TypeError);
  }
  expect(() => layoutPath({ kind: 'index', name: '..' })).toThrow(TypeError);
});
