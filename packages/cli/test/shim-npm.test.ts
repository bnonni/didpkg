// `didpkg shim start` with the npm CLI: publish to the pinned dwn-server, then `npm install` and `npm ci`
// through the shim, on a cold cache and with one .npmrc line (PLAN.md Phase 1 item 4). Then the cases of
// exit criterion 3: a swapped tarball, a wrapped tarball (fake-registry.mjs), a revoked and a yanked version.
// pnpm and `bun add` too.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DidResolver } from '@didpkg/core/did';
import { dhtDriver } from '@didpkg/core/did/dht';
import { PackageSource, type StorageAdapter } from '@didpkg/core/source';
import { ed25519Signer, parseIndex, signIndex, sri, type DidPkgIndex, type ReleaseStatus } from '@didpkg/core/trust';
import { dwnAdapter, INDEX_TTL_MS } from '@didpkg/adapter-dwn';
import { DwnWriter, ed25519MessageSigner } from '@didpkg/adapter-dwn/writer';
import { startDwn } from '../../adapter-dwn/test/server.ts';
import { createDht } from '../src/id/dht.ts';
import { decryptKey } from '../src/id/keyfile.ts';
import { idPaths, readIdentity } from '../src/id/store.ts';
import { shimHandler } from '../src/shim/shim.ts';
import { putRelay } from './relay.ts';
import { tgzOf } from './tgz.ts';

setDefaultTimeout(60_000);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-shim-'));
const home = join(tmp, 'home');
const PASS = 'release passphrase 1';
const relay = putRelay();
const tgz: Record<string, string> = {};
let dwn: Awaited<ReturnType<typeof startDwn>>;
let shim: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
let shimUrl: string;
let did: string;
let installName: string;

/** Async: a sync spawn blocks this process, and thus the relay in it. */
async function run(cmd: string[], cwd = tmp, env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, {
    cwd, env: { PATH: process.env.PATH!, HOME: home, DIDPKG_HOME: home, DIDPKG_PASSPHRASE: PASS, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
/** A cold npm cache each time. No retry, because npm waits 10 s before it retries a 5xx. */
const npm = (cwd: string, ...args: string[]) =>
  run(['npm', ...args, '--cache', join(tmp, `npm-cache-${Math.random()}`), '--fetch-retries', '0', '--no-audit', '--no-fund', '--no-update-notifier'], cwd);
const node = (cwd: string) => Bun.spawnSync(['node', '-p', `require(${JSON.stringify(installName)})`], { cwd }).stdout.toString();
const pkgDir = (cwd: string) => join(cwd, 'node_modules', ...installName.split('/'));

/** An app folder with one .npmrc line for the @didpkg scope. */
function newApp(name: string, registry = shimUrl): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', private: true }));
  writeFileSync(join(dir, '.npmrc'), `@didpkg:registry=${registry}/\n`);
  return dir;
}

/** The next signed index with new statuses, written to the DWN with the release key, as `didpkg publish` does. */
async function setStatus(statuses: Record<string, ReleaseStatus>) {
  const { releaseKey } = readIdentity(idPaths('pub', { DIDPKG_HOME: home }));
  const seed = await decryptKey(releaseKey, PASS);
  const reader = dwnAdapter({ allowLoopback: true }).reader({ did, serviceId: `${did}#dwn`, type: 'DecentralizedWebNode', url: dwn.url }, { fetch });
  let head: DidPkgIndex | null = null;
  for await (const bytes of reader.read({ kind: 'index', name: 'hello' }, { signal: AbortSignal.timeout(10_000), maxBytes: 1 << 20 })) {
    const index = parseIndex(JSON.parse(new TextDecoder().decode(bytes)));
    if (!head || index.sequence > head.sequence) head = index;
  }
  const releases = Object.fromEntries(Object.entries(head!.releases).map(([v, e]) => [v, { ...e, status: statuses[v] ?? e.status }]));
  const index = await signIndex({ publisher: did, name: 'hello', head, releases }, [ed25519Signer(seed, releaseKey.keyId)]);
  const writer = new DwnWriter({ dwnUrl: dwn.url, did, signer: ed25519MessageSigner(seed, releaseKey.keyId) });
  await writer.writeIndex({ name: 'hello', index: new TextEncoder().encode(JSON.stringify(index)) });
}

/**
 * The shim handler in this process, with a tamper switch. `storage`: the DWN gives the 1.2.0 tarball bytes
 * for each tarball. `wire`: the response wraps the tarball in a second tar, as drpm.tools did (fake-registry.mjs).
 */
function tamperShim() {
  let mode: 'none' | 'storage' | 'wire' = 'none';
  const dwns = dwnAdapter({ allowLoopback: true });
  const adapter: StorageAdapter = {
    kind: dwns.kind,
    canRead: (e) => dwns.canRead(e),
    reader: (e, deps) => {
      const reader = dwns.reader(e, deps);
      return {
        async *read(file, o) {
          for await (const bytes of reader.read(file, o)) yield mode === 'storage' && file.kind === 'tarball' ? readFileSync(tgz['1.2.0']!) : bytes;
        },
      };
    },
  };
  const resolver = new DidResolver({ drivers: [dhtDriver({ relays: [relay.url], allowPrivateRelays: true })] });
  let handler: (req: Request) => Promise<Response>;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const res = await handler(req);
      const file = new URL(req.url).pathname.split('/').at(-1)!;
      if (mode !== 'wire' || !file.endsWith('.tgz') || res.status !== 200) return res;
      return new Response(tgzOf(file, new Uint8Array(await res.arrayBuffer())), { headers: { 'content-type': 'application/octet-stream' } });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  handler = shimHandler({ origin: url, resolver, source: new PackageSource({ resolver, adapters: [adapter] }), trust: new Map() });
  return { url, set: (m: typeof mode) => { mode = m; }, stop: () => server.stop(true) };
}

beforeAll(async () => {
  dwn = await startDwn({ relayUrl: relay.url });
  await createDht({
    alias: 'pub', dwn: dwn.url, relays: [relay.url], env: { DIDPKG_HOME: home }, iterations: 1000, passphrase: PASS, updatePassphrase: 'update passphrase 2',
  });
  for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
    const pkg = join(tmp, `pkg-${version}`, 'package');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'hello', version, main: 'index.js' }));
    writeFileSync(join(pkg, 'index.js'), `module.exports = "hello ${version}";\n`);
    tgz[version] = join(tmp, `hello-${version}.tgz`);
    expect(Bun.spawnSync(['tar', '-czf', tgz[version], '-C', join(tmp, `pkg-${version}`), 'package']).exitCode).toBe(0);
    const published = await run([process.execPath, cli, 'publish', 'pub', tgz[version], '--to', 'dwn', '--relay', relay.url]);
    expect(published.err).toBe('');
    ({ did, installName } = JSON.parse(published.out));
  }

  shim = Bun.spawn([process.execPath, cli, 'shim', 'start', '--port', '0', '--relay', relay.url, '--allow-loopback'], {
    env: { PATH: process.env.PATH!, HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const first = await shim.stdout.getReader().read();
  ({ url: shimUrl } = JSON.parse(new TextDecoder().decode(first.value)));
});

afterAll(async () => {
  shim?.kill('SIGTERM');
  await shim?.exited;
  await dwn?.stop();
  relay.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('shim start', () => {
  test('binds 127.0.0.1 only and refuses another Host header', async () => {
    expect(new URL(shimUrl).hostname).toBe('127.0.0.1');
    const r = await fetch(`${shimUrl}/${installName}`, { headers: { host: 'evil.example' } });
    expect(r.status).toBe(421);
  });

  test('refuses a request target that is not a path (absolute form) with 400', async () => {
    const { host, port } = new URL(shimUrl);
    const head = await new Promise<string>((resolve, reject) => {
      let data = '';
      const s = connect(Number(port), '127.0.0.1', () => s.write(`GET http://evil.example/${installName} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      s.on('data', (d) => (data += d.toString())).on('end', () => resolve(data)).on('error', reject);
    });
    expect(head).toStartWith('HTTP/1.1 400 ');
  });

  test('npm install, then npm ci from the lockfile', async () => {
    const app = newApp('app');
    const add = await npm(app, 'install', installName);
    expect(add.err).not.toContain('ERR');
    expect(add.code).toBe(0);
    expect(JSON.parse(readFileSync(join(pkgDir(app), 'package.json'), 'utf8'))).toMatchObject({ name: 'hello', version: '1.2.0' });
    const lock = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8'));
    const resolved = new URL(lock.packages[`node_modules/${installName}`].resolved);
    expect(resolved.origin).toBe(shimUrl);
    expect([...resolved.searchParams.keys()]).toEqual(['rec', 'vm']);

    rmSync(join(app, 'node_modules'), { recursive: true });
    const ci = await npm(app, 'ci');
    expect(ci.code).toBe(0);
    expect(node(app)).toBe('hello 1.2.0\n');
  });

  test.skipIf(!Bun.which('pnpm'))('pnpm add, then pnpm install --frozen-lockfile', async () => {
    const app = newApp('app-pnpm');
    const pnpm = (...args: string[]) => run(['pnpm', ...args, '--store-dir', join(tmp, `pnpm-store-${Math.random()}`)], app);
    const add = await pnpm('add', installName);
    expect(add.code).toBe(0);
    expect(node(app)).toBe('hello 1.2.0\n');
    rmSync(join(app, 'node_modules'), { recursive: true });
    const frozen = await pnpm('install', '--frozen-lockfile');
    expect(frozen.code).toBe(0);
    expect(node(app)).toBe('hello 1.2.0\n');
  });

  test('bun add, then bun install --frozen-lockfile', async () => {
    const app = newApp('app-bun');
    const bun = (...args: string[]) => run([process.execPath, ...args], app, { BUN_INSTALL_CACHE_DIR: join(tmp, `bun-cache-${Math.random()}`) });
    const add = await bun('add', installName);
    expect(add.code).toBe(0);
    expect(node(app)).toBe('hello 1.2.0\n');
    rmSync(join(app, 'node_modules'), { recursive: true });
    const frozen = await bun('install', '--frozen-lockfile');
    expect(frozen.code).toBe(0);
    expect(node(app)).toBe('hello 1.2.0\n');
  });
});

describe('exit criterion 3', () => {
  test('the shim never wraps a tarball: each version gives the published bytes (fake-registry.mjs)', async () => {
    const doc = (await (await fetch(`${shimUrl}/${installName}`)).json()) as { versions: Record<string, { dist: { tarball: string; integrity: string } }> };
    expect(Object.keys(doc.versions).sort()).toEqual(Object.keys(tgz));
    for (const [version, path] of Object.entries(tgz)) {
      const { dist } = doc.versions[version]!;
      const bytes = new Uint8Array(await (await fetch(dist.tarball)).arrayBuffer());
      expect(bytes).toEqual(new Uint8Array(readFileSync(path)));
      expect(dist.integrity).toBe(await sri('sha512', bytes));
    }
  });

  test('a swapped tarball fails npm ci with 502, a wrapped tarball with EINTEGRITY, and no file is installed', async () => {
    const t = tamperShim();
    try {
      const app = newApp('app-tamper', t.url);
      expect((await npm(app, 'install', `${installName}@1.0.0`)).code).toBe(0);
      for (const [mode, code] of [['storage', 'E502'], ['wire', 'EINTEGRITY']] as const) {
        t.set(mode);
        rmSync(join(app, 'node_modules'), { recursive: true, force: true });
        const ci = await npm(app, 'ci');
        expect(ci.code).not.toBe(0);
        expect(ci.err).toContain(code);
        expect(existsSync(pkgDir(app))).toBe(false);
      }
    } finally {
      t.stop();
    }
  });

  test('after a new index: npm ci of a yanked version passes, of a revoked version fails with E403', async () => {
    const yanked = newApp('app-yanked');
    const revoked = newApp('app-revoked');
    expect((await npm(yanked, 'install', `${installName}@1.0.0`)).code).toBe(0);
    expect((await npm(revoked, 'install', `${installName}@1.1.0`)).code).toBe(0);
    await setStatus({ '1.0.0': 'yanked', '1.1.0': 'revoked' });
    // The DWN reader of the shim caches an index. The new index reaches the shim after this time.
    await Bun.sleep(INDEX_TTL_MS + 500);

    for (const app of [yanked, revoked]) rmSync(join(app, 'node_modules'), { recursive: true });
    const ok = await npm(yanked, 'ci');
    expect(ok.code).toBe(0);
    expect(node(yanked)).toBe('hello 1.0.0\n');
    const no = await npm(revoked, 'ci');
    expect(no.code).not.toBe(0);
    expect(no.err).toContain('E403');
    expect(existsSync(pkgDir(revoked))).toBe(false);

    // With no lockfile pin, the packument does not list a yanked version.
    const fresh = await npm(newApp('app-fresh'), 'install', `${installName}@1.0.0`);
    expect(fresh.code).not.toBe(0);
    expect(fresh.err).toContain('ETARGET');
  });
});
