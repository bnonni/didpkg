// The Phase 1 demo (PLAN.md Phase 1 item 5, exit criteria 1 and 2). Publisher A makes a did:dht identity,
// then signs `demo/hello` and publishes it to its DWN and to a static mirror. User B has no keys. B installs
// the package by name through `didpkg shim start` with npm, pnpm and bun, each with a cold cache, and Node
// loads it. Publisher W makes a did:web identity, hosts its did.json on a TLS site, and publishes the same
// tarball to the same DWN and to that site. B installs the package of W with npm. Then the DWN stops, and
// a new shim installs both packages from the mirrors.
// All servers are on 127.0.0.1: a Pkarr relay, the pinned dwn-server 0.1.45, a static server, and the TLS
// site of W behind a CONNECT proxy (see tls.ts).
// Run from the repo root after `npm install`: npm run demo. It needs npm, pnpm 11, Node and openssl on the PATH.
// DIDPKG_BIN=<path> runs that didpkg command in place of src/cli.ts on Bun, for example the npm package bin on Node.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDwn } from '../packages/adapter-dwn/test/server.ts';
import { putRelay } from '../packages/cli/test/relay.ts';
import { makeCerts, proxyEnv, startProxy, WEB_HOST } from './tls.ts';

const LIMIT_MS = 5 * 60_000;
const EXPECTED = 'hello from didpkg';
const cli = fileURLToPath(new URL('../packages/cli/src/cli.ts', import.meta.url));
const didpkgCmd = process.env.DIDPKG_BIN ? [process.env.DIDPKG_BIN] : [process.execPath, cli];
const pkgSrc = fileURLToPath(new URL('./hello', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-demo-'));
const t0 = performance.now();
const stops: (() => unknown)[] = [];

/** Async, because the relay and the static server run in this process. Throws on a non-zero exit. */
async function run(cmd: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, env: { PATH: process.env.PATH!, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} (exit ${code})\n${(err || out).trim()}`);
  return out;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const value = await fn();
  console.log(`ok   ${name} (${Math.round(performance.now() - t)} ms)`);
  return value;
}

/** A new HOME for each install, thus each package manager starts with a cold cache and no user config. */
function newHome(name: string): string {
  const home = join(tmp, name);
  mkdirSync(home);
  return home;
}

/** A static mirror: GET of a file in `dir`, on http, or on https with `tls`. It counts the tarball and did.json reads. */
function startMirror(dir: string, tls?: { cert: string; key: string }) {
  const reads = { tgz: 0, didJson: 0 };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    ...(tls ? { tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) } } : {}),
    async fetch(req) {
      const path = normalize(decodeURIComponent(new URL(req.url).pathname));
      if (path.split('/').includes('..')) return new Response('bad path', { status: 400 });
      const file = Bun.file(join(dir, path));
      if (path.endsWith('.tgz')) reads.tgz++;
      if (path.endsWith('/did.json')) reads.didJson++;
      return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
    },
  });
  return { url: tls ? `https://${WEB_HOST}` : `http://127.0.0.1:${server.port}`, port: server.port!, reads, stop: () => server.stop(true) };
}

/** User B's shim. Its first stdout line is JSON with the URL. Its request log goes to a file. */
async function startShim(home: string, relayUrl: string, env: Record<string, string>) {
  const log = join(home, 'shim.log');
  const p = Bun.spawn([...didpkgCmd, 'shim', 'start', '--port', '0', '--relay', relayUrl, '--allow-loopback'], {
    env: { PATH: process.env.PATH!, HOME: home, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: Bun.file(log),
  });
  const stop = async () => {
    p.kill('SIGTERM');
    await p.exited;
  };
  stops.push(stop);
  const first = await p.stdout.getReader().read();
  if (!first.value) throw new Error(`the shim did not start: ${readFileSync(log, 'utf8').trim()}`);
  const { url } = JSON.parse(new TextDecoder().decode(first.value)) as { url: string };
  return { url, stop };
}

/** An app folder with one .npmrc line for the @didpkg scope. */
function newApp(home: string, shimUrl: string): string {
  const app = join(home, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true }));
  writeFileSync(join(app, '.npmrc'), `@didpkg:registry=${shimUrl}/\n`);
  return app;
}

/** Installs the package in a new app with a cold cache, then Node loads it. */
async function install(home: string, shimUrl: string, cmd: string[]) {
  const app = newApp(home, shimUrl);
  await run(cmd, app, { HOME: home });
  const loaded = (await run(['node', '-p', `require(${JSON.stringify(cmd.at(-1))})`], app, { HOME: home })).trim();
  if (loaded !== EXPECTED) throw new Error(`node loaded ${JSON.stringify(loaded)}, expected ${JSON.stringify(EXPECTED)}`);
}

const npmFlags = ['--no-audit', '--no-fund', '--no-update-notifier', '--fetch-retries', '0'];

try {
  for (const tool of ['npm', 'pnpm', 'node', 'openssl']) if (!Bun.which(tool)) throw new Error(`${tool} is not on the PATH`);
  const pnpmMajor = Number((await run(['pnpm', '--version'], tmp, { HOME: tmp })).split('.')[0]);
  if (pnpmMajor < 11) throw new Error(`pnpm 11 or later is necessary (found ${pnpmMajor})`);

  const { relay, dwn, mirror, site, webMirror, webSite, webEnv } = await step('start the relay, the static mirror, the TLS site, the proxy and the dwn-server', async () => {
    const relay = putRelay();
    stops.push(relay.stop);
    const site = join(tmp, 'site');
    const webSite = join(tmp, 'web-site');
    mkdirSync(join(webSite, '.well-known'), { recursive: true });
    mkdirSync(site);
    const mirror = startMirror(site);
    stops.push(mirror.stop);
    const certs = await makeCerts(tmp, WEB_HOST);
    const webMirror = startMirror(webSite, certs);
    stops.push(webMirror.stop);
    const proxy = await startProxy(WEB_HOST, webMirror.port);
    stops.push(proxy.stop);
    const webEnv = proxyEnv(proxy.url, certs.ca);
    const dwn = await startDwn({ relayUrl: relay.url, env: webEnv });
    stops.push(dwn.stop);
    return { relay, dwn, mirror, site, webMirror, webSite, webEnv };
  });

  // Publisher A: the passphrases come from the environment, so no prompt opens.
  const envA = { HOME: newHome('home-a'), DIDPKG_PASSPHRASE: 'demo release passphrase', DIDPKG_UPDATE_PASSPHRASE: 'demo update passphrase' };
  const didpkg = async (...args: string[]) => JSON.parse(await run([...didpkgCmd, ...args], tmp, envA));
  const id = await step('A: didpkg id create (did:dht, #dwn and DIDPackageRepository services)', () =>
    didpkg('id', 'create', 'demo', '--dwn', dwn.url, '--repo', `${mirror.url}/`, '--relay', relay.url));
  const tarball = await step('A: npm pack demo/hello', async () => {
    const [packed] = JSON.parse(await run(['npm', 'pack', '--json', '--pack-destination', tmp, pkgSrc], tmp, { HOME: envA.HOME })) as { filename: string }[];
    return join(tmp, packed!.filename);
  });
  const published = await step('A: didpkg publish --to dwn --to dir:site', () =>
    didpkg('publish', 'demo', tarball, '--to', 'dwn', '--to', `dir:${site}`, '--relay', relay.url));
  const name = published.installName as string;
  console.log(`     publisher ${id.did}\n     install name ${name}`);

  // Publisher W: did:web. The did.json goes on the TLS site before the publish, because the DWN resolves the DID.
  const envW = { HOME: newHome('home-w'), DIDPKG_PASSPHRASE: 'demo web passphrase' };
  const didpkgW = async (...args: string[]) => JSON.parse(await run([...didpkgCmd, ...args], tmp, envW));
  const idW = await step(`W: didpkg id create --web ${WEB_HOST} (#dwn and DIDPackageRepository services)`, () =>
    didpkgW('id', 'create', 'web', '--web', WEB_HOST, '--dwn', dwn.url, '--repo', `${webMirror.url}/`));
  if (idW.documentUrl !== `${webMirror.url}/.well-known/did.json`) throw new Error(`the did.json URL is ${idW.documentUrl}`);
  copyFileSync(idW.files.document, join(webSite, '.well-known', 'did.json'));
  const publishedW = await step('W: didpkg publish --to dwn --to dir:web-site (no relay)', () =>
    didpkgW('publish', 'web', tarball, '--to', 'dwn', '--to', `dir:${webSite}`));
  if (publishedW.relays.length !== 0) throw new Error('a did:web publish sent a relay PUT');
  if (webMirror.reads.didJson === 0) throw new Error('the DWN did not resolve the did:web DID');
  const nameW = publishedW.installName as string;
  console.log(`     publisher ${idW.did}\n     install name ${nameW}`);

  // User B: no keys, a cold cache for each package manager.
  const shim = await step('B: didpkg shim start', () => startShim(newHome('home-b'), relay.url, webEnv));
  await step('B: npm install, then Node loads it', () => install(newHome('home-npm'), shim.url, ['npm', 'install', ...npmFlags, name]));
  await step('B: pnpm add, then Node loads it', () => install(newHome('home-pnpm'), shim.url, ['pnpm', 'add', name]));
  await step('B: bun add, then Node loads it', () => install(newHome('home-bun'), shim.url, [process.execPath, 'add', name]));
  const didJsonReads = webMirror.reads.didJson;
  await step('B: npm install of the did:web package, then Node loads it', () => install(newHome('home-npm-w'), shim.url, ['npm', 'install', ...npmFlags, nameW]));
  if (webMirror.reads.didJson === didJsonReads) throw new Error('the shim did not resolve the did:web DID');
  await shim.stop();
  if (mirror.reads.tgz + webMirror.reads.tgz !== 0) throw new Error('the shim read a tarball from a mirror while the DWN was up (DWN first)');

  await step('stop the DWN', async () => {
    await dwn.stop();
    const up = await fetch(`${dwn.url}/health`).then(() => true, () => false);
    if (up) throw new Error('the DWN still answers');
  });
  const shim2 = await step('B: a new didpkg shim start (cold)', () => startShim(newHome('home-b2'), relay.url, webEnv));
  await step('B: npm install from the mirror, then Node loads it', () => install(newHome('home-mirror'), shim2.url, ['npm', 'install', ...npmFlags, name]));
  if (mirror.reads.tgz === 0) throw new Error('the mirror gave no tarball');
  await step('B: npm install of the did:web package from its TLS site', () => install(newHome('home-mirror-w'), shim2.url, ['npm', 'install', ...npmFlags, nameW]));
  if (webMirror.reads.tgz === 0) throw new Error('the TLS site gave no tarball');

  const ms = Math.round(performance.now() - t0);
  if (ms > LIMIT_MS) throw new Error(`the demo took ${ms} ms, the limit is ${LIMIT_MS} ms`);
  console.log(`PASS (${ms} ms)`);
} catch (e) {
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
