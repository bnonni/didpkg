// `didpkg shim start` with the npm CLI: publish to the pinned dwn-server, then `npm install` and `npm ci`
// through the shim, on a cold cache and with one .npmrc line (PLAN.md Phase 1 item 4).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDwn } from '../../adapter-dwn/test/server.ts';
import { createDht } from '../src/id/dht.ts';
import { putRelay } from './relay.ts';

setDefaultTimeout(60_000);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-shim-'));
const home = join(tmp, 'home');
const app = join(tmp, 'app');
const PASS = 'release passphrase 1';
const relay = putRelay();
let dwn: Awaited<ReturnType<typeof startDwn>>;
let shim: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
let shimUrl: string;
let installName: string;

/** Async: a sync spawn blocks this process, and thus the relay in it. */
async function run(cmd: string[], cwd = tmp) {
  const p = Bun.spawn(cmd, {
    cwd, env: { PATH: process.env.PATH!, HOME: home, DIDPKG_HOME: home, DIDPKG_PASSPHRASE: PASS }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
const npm = (...args: string[]) => run(['npm', ...args, '--cache', join(tmp, `npm-cache-${Math.random()}`), '--no-audit', '--no-fund', '--no-update-notifier'], app);

beforeAll(async () => {
  dwn = await startDwn({ relayUrl: relay.url });
  await createDht({
    alias: 'pub', dwn: dwn.url, relays: [relay.url], env: { DIDPKG_HOME: home }, iterations: 1000, passphrase: PASS, updatePassphrase: 'update passphrase 2',
  });
  const pkg = join(tmp, 'pkg', 'package');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'hello', version: '1.0.0', main: 'index.js' }));
  writeFileSync(join(pkg, 'index.js'), 'module.exports = "hello 1.0.0";\n');
  const tgz = join(tmp, 'hello-1.0.0.tgz');
  expect(Bun.spawnSync(['tar', '-czf', tgz, '-C', join(tmp, 'pkg'), 'package']).exitCode).toBe(0);
  const published = await run([process.execPath, cli, 'publish', 'pub', tgz, '--to', 'dwn', '--relay', relay.url]);
  expect(published.err).toBe('');
  installName = JSON.parse(published.out).installName;

  shim = Bun.spawn([process.execPath, cli, 'shim', 'start', '--port', '0', '--relay', relay.url, '--allow-loopback'], {
    env: { PATH: process.env.PATH!, HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const first = await shim.stdout.getReader().read();
  ({ url: shimUrl } = JSON.parse(new TextDecoder().decode(first.value)));
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true }));
  writeFileSync(join(app, '.npmrc'), `@didpkg:registry=${shimUrl}/\n`);
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

  test('npm install, then npm ci from the lockfile', async () => {
    const add = await npm('install', installName);
    expect(add.err).not.toContain('ERR');
    expect(add.code).toBe(0);
    const installed = JSON.parse(readFileSync(join(app, 'node_modules', ...installName.split('/'), 'package.json'), 'utf8'));
    expect(installed).toMatchObject({ name: 'hello', version: '1.0.0' });
    const lock = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8'));
    const resolved = new URL(lock.packages[`node_modules/${installName}`].resolved);
    expect(resolved.origin).toBe(shimUrl);
    expect([...resolved.searchParams.keys()]).toEqual(['rec', 'vm']);

    rmSync(join(app, 'node_modules'), { recursive: true });
    const ci = await npm('ci');
    expect(ci.code).toBe(0);
    expect(Bun.spawnSync(['node', '-p', `require(${JSON.stringify(installName)})`], { cwd: app }).stdout.toString()).toBe('hello 1.0.0\n');
  });
});
