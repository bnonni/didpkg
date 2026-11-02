// `didpkg shim start` with a did:btcr2 publisher and CAS off. The Sidecar Data comes from the publisher identity, a
// mirror (a loopback server on the `didpkg publish --to dir:` folder) or the copy of a verified resolve. Then npm
// installs the package on a cold cache. A stub Esplora API shows no beacon signal.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sidecarFile } from '@didpkg/core/did/btcr2';
import { createBtcr2 } from '../src/id/btcr2.ts';
import { idPaths, readIdentity } from '../src/id/store.ts';
import { publish } from '../src/publish/publish.ts';
import { startShim, type StartShimOptions } from '../src/shim/start.ts';
import { npmTgz } from './tgz.ts';

setDefaultTimeout(60_000);
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-shim-btcr2-'));
const site = join(tmp, 'site');
const PASS = 'release passphrase 1';
const keys = { passphrase: PASS, updatePassphrase: 'update passphrase 1', iterations: 1000 };
const requests: string[] = [];
let esploraDown = false;
let wrongSidecar = '';

/** The folder of `didpkg publish --to dir:`, as a static host. `/wrong/` gives the Sidecar Data of another DID for each name. */
const host = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const { pathname } = new URL(req.url);
    requests.push(pathname);
    if (pathname.startsWith('/wrong/')) return new Response(wrongSidecar);
    const file = Bun.file(join(site, ...pathname.split('/').filter(Boolean).map(decodeURIComponent)));
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  },
});
const esplora = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (esploraDown) return new Response('down', { status: 500 });
    if (pathname.endsWith('/blocks/tip/height')) return new Response('150000');
    if (pathname.includes('/address/') && pathname.endsWith('/txs/chain')) return Response.json([]);
    return new Response('not found', { status: 404 });
  },
});
const mirror = host.url.href.replace(/\/$/, '');
let did: string;
let installName: string;
let file: string;

beforeAll(async () => {
  const pubHome = join(tmp, 'pub');
  const r = await createBtcr2({ alias: 'pub', network: 'testnet4', repos: [`${mirror}/`], env: { DIDPKG_HOME: pubHome }, ...keys });
  const out = await publish({ identity: readIdentity(idPaths('pub', { DIDPKG_HOME: pubHome })), tarball: npmTgz({ name: 'hello', version: '1.0.0' }), to: [`dir:${site}`], passphrase: async () => PASS });
  expect(out.targets).toEqual([{ url: `dir:${site}`, ok: true }]);
  const other = await createBtcr2({ alias: 'other', network: 'testnet4', repos: [`${mirror}/`], env: { DIDPKG_HOME: join(tmp, 'other') }, ...keys });
  wrongSidecar = readFileSync(other.files.sidecar, 'utf8');
  ({ did, installName } = { did: r.did, installName: out.installName });
  file = sidecarFile(did);
});

afterAll(async () => {
  await Promise.all([host.stop(true), esplora.stop(true)]);
  rmSync(tmp, { recursive: true, force: true });
});

/** A shim with CAS off. It gives the packument status and the log. */
async function packument(o: Omit<StartShimOptions, 'port'>) {
  const log: string[] = [];
  const shim = await startShim({ port: 0, allowLoopback: true, cas: [], esplora: { testnet4: esplora.url.href }, log: (l) => log.push(l), ...o });
  try {
    const res = await fetch(`${shim.url}/${installName}`);
    return { status: res.status, body: await res.text(), log };
  } finally {
    await shim.stop();
  }
}

const newHome = (name: string) => {
  const dir = join(tmp, name);
  mkdirSync(dir);
  return dir;
};

describe('the did:btcr2 Sidecar Data in the shim', () => {
  test('npm installs the package: the Sidecar Data comes from the mirror, and the shim keeps a copy', async () => {
    const home = newHome('app-home');
    const shim = await startShim({ port: 0, allowLoopback: true, cas: [], esplora: { testnet4: esplora.url.href }, sidecar: [`${mirror}/`], home });
    try {
      const app = join(tmp, 'app');
      mkdirSync(app);
      writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true }));
      writeFileSync(join(app, '.npmrc'), `@didpkg:registry=${shim.url}/\n`);
      // Async: a sync spawn blocks this process, and thus the servers in it.
      const p = Bun.spawn(['npm', 'install', installName, '--cache', join(tmp, 'npm-cache'), '--fetch-retries', '0', '--no-audit', '--no-fund', '--no-update-notifier'], {
        cwd: app, env: { PATH: process.env.PATH!, HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      expect(err).not.toContain('ERR');
      expect(code).toBe(0);
      const pkg = JSON.parse(readFileSync(join(app, 'node_modules', ...installName.split('/'), 'package.json'), 'utf8'));
      expect(pkg.version).toBe('1.0.0');
    } finally {
      await shim.stop();
    }
    expect(requests).toContain(`/${file}`);
    expect(readFileSync(join(home, 'sidecar', file), 'utf8')).toBe(readFileSync(join(site, file), 'utf8'));
  });

  test('with no mirror, no copy and CAS off, the DID is not found', async () => {
    const r = await packument({ home: newHome('empty'), sidecar: [] });
    expect(r.status).toBe(404);
    expect(r.body).toContain(`${did}: NOT_FOUND`);
  });

  test('the copy of a verified resolve works with no mirror; with a mirror, the mirror comes first', async () => {
    expect((await packument({ home: join(tmp, 'app-home') })).status).toBe(200);
    const before = requests.filter((p) => p === `/${file}`).length;
    expect((await packument({ home: join(tmp, 'app-home'), sidecar: [mirror] })).status).toBe(200);
    expect(requests.filter((p) => p === `/${file}`).length).toBe(before + 1);
  });

  test('the publisher identity gives its own Sidecar Data, and the shim keeps no copy of it', async () => {
    const home = join(tmp, 'pub');
    const n = requests.length;
    expect((await packument({ home, sidecar: [] })).status).toBe(200);
    expect(requests.slice(n).filter((p) => p.endsWith('.sidecar.json'))).toEqual([]);
    expect(existsSync(join(home, 'sidecar'))).toBe(false);
  });

  test('a mirror with no file or with the data of another DID does not count; the next mirror gives the data', async () => {
    const r = await packument({ home: newHome('skip'), sidecar: [`${mirror}/missing`, `${mirror}/wrong`, mirror] });
    expect(r.status).toBe(200);
    expect(r.log).toContain(`sidecar: ${mirror}/wrong/${file}: not the Sidecar Data of ${did}`);
    expect(r.log.filter((l) => l.includes('/missing/'))).toEqual([]);
  });

  test('a failed resolve keeps no copy', async () => {
    const home = newHome('failed');
    esploraDown = true;
    try {
      expect((await packument({ home, sidecar: [mirror] })).status).toBe(502);
    } finally {
      esploraDown = false;
    }
    expect(existsSync(join(home, 'sidecar'))).toBe(false);
  });

  test('a copy with the data of another DID does not count', async () => {
    const home = newHome('bad-copy');
    mkdirSync(join(home, 'sidecar'));
    writeFileSync(join(home, 'sidecar', file), wrongSidecar);
    const r = await packument({ home, sidecar: [] });
    expect(r.status).toBe(404);
    expect(r.log).toContain(`sidecar: ${join(home, 'sidecar', file)}: not the Sidecar Data of ${did}`);
  });
});
