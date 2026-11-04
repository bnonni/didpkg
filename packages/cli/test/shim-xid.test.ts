// A XID publisher end to end: `didpkg publish` to a folder, a static server on the folder as the mirror and
// the XID resolver, then `npm install` through `didpkg shim start` and `didpkg drl`. Then a key rotation with a TOFU pin.
// Each lock and each open of a key costs one Argon2id run (about 0.5 s).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sri, type Pin } from '@didpkg/core/trust';
import { startDwn, startRelay } from '../../adapter-dwn/test/server.ts';
import { serveDir, type StaticServer } from '../../adapter-https/test/serve.ts';
import { drl, type DrlOptions } from '../src/drl.ts';
import { createXid, updateXid } from '../src/id/xid.ts';
import { shimHandler } from '../src/shim/shim.ts';
import { readSide } from '../src/shim/start.ts';
import { npmTgz } from './tgz.ts';

setDefaultTimeout(60_000);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-shim-xid-'));
const home = join(tmp, 'home');
const site = join(tmp, 'site');
const PASS = 'release passphrase 1';
const UPDATE_PASS = 'update passphrase 1';
const env = { DIDPKG_HOME: home };
const tgz = (version: string) => {
  const file = join(tmp, `hello-${version}.tgz`);
  writeFileSync(file, npmTgz({ name: 'hello', version, description: 'a XID package' }));
  return file;
};
let mirror: StaticServer;
let shim: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
let shimUrl: string;
let xid: string;
let installName: string;

async function run(cmd: string[], cwd = tmp) {
  const p = Bun.spawn(cmd, {
    cwd, env: { PATH: process.env.PATH!, HOME: home, DIDPKG_HOME: home, DIDPKG_PASSPHRASE: PASS }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
const publish = (version: string) => run([process.execPath, cli, 'publish', 'pub', tgz(version), '--to', `dir:${site}`]);

beforeAll(async () => {
  mirror = serveDir(site);
  ({ xid } = await createXid({ alias: 'pub', repos: [mirror.base], passphrase: PASS, updatePassphrase: UPDATE_PASS, env }));
  shim = Bun.spawn([process.execPath, cli, 'shim', 'start', '--port', '0', '--xid-resolver', mirror.base, '--allow-loopback'], {
    env: { PATH: process.env.PATH!, HOME: home, DIDPKG_HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const first = await shim.stdout.getReader().read();
  ({ url: shimUrl } = JSON.parse(new TextDecoder().decode(first.value)));
});

afterAll(async () => {
  shim?.kill('SIGTERM');
  await shim?.exited;
  mirror?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

test('publish writes the XID document and the envelope layout, and a second run writes the same bytes', async () => {
  const r = await publish('1.0.0');
  expect(r.code, r.err).toBe(0);
  const out = JSON.parse(r.out);
  installName = out.installName;
  expect(out).toMatchObject({ xid, name: 'hello', version: '1.0.0', installName: `@didpkg/hello_xid_${xid}`, sequence: 1 });
  expect(out.targets).toEqual([{ url: `dir:${site}`, ok: true }]);
  for (const f of [`xid/${xid}.envelope`, 'hello/index.envelope', 'hello/1.0.0.envelope', 'hello/1.0.0.tgz']) expect(existsSync(join(site, f))).toBe(true);
  expect(existsSync(join(site, 'hello/index.json'))).toBe(false);

  const index = readFileSync(join(site, 'hello/index.envelope'));
  const again = await publish('1.0.0');
  expect(again.code, again.err).toBe(0);
  expect(JSON.parse(again.out)).toMatchObject({ release: out.release, sequence: 1 });
  expect(readFileSync(join(site, 'hello/index.envelope')).equals(index)).toBe(true);
});

test('publish refuses --to dwn with no DWN service, and --relay for a XID publisher', async () => {
  expect((await run([process.execPath, cli, 'publish', 'pub', tgz('1.0.0'), '--to', 'dwn'])).err).toContain('the XID document has no DWN service');
  expect((await run([process.execPath, cli, 'publish', 'pub', tgz('1.0.0'), '--to', `dir:${site}`, '--relay', 'https://r.example'])).err)
    .toContain('a XID publisher has no relay');
});

test('npm install through the shim gets the signed integrity', async () => {
  const app = join(tmp, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true }));
  writeFileSync(join(app, '.npmrc'), `@didpkg:registry=${shimUrl}/\n`);
  const r = await run(['npm', 'install', installName, '--cache', join(tmp, 'npm-cache'), '--fetch-retries', '0', '--no-audit', '--no-fund'], app);
  expect(r.code, r.err).toBe(0);
  const lock = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8'));
  const entry = lock.packages[`node_modules/${installName}`];
  expect(entry.integrity).toBe(await sri('sha512', new Uint8Array(readFileSync(join(site, 'hello/1.0.0.tgz')))));
  // A XID release names no key, so the URL has only `rec`.
  expect(entry.resolved).toMatch(new RegExp(`^${shimUrl}/${installName}/-/hello_xid_${xid}-1\\.0\\.0\\.tgz\\?rec=sha256-[^&]+$`));
  expect(JSON.parse(readFileSync(join(app, 'node_modules', ...installName.split('/'), 'package.json'), 'utf8')).version).toBe('1.0.0');
  // The shim keeps the newest XID document in its home.
  expect(readFileSync(join(home, 'xid', `${xid}.envelope`)).equals(readFileSync(join(site, 'xid', `${xid}.envelope`)))).toBe(true);
});

test('drl gives the mirror URL and the signed sha512 of a XID release', async () => {
  const r = await run([process.execPath, cli, 'drl', installName, '--xid-resolver', mirror.base, '--allow-loopback']);
  expect(r.code, r.err).toBe(0);
  expect(JSON.parse(r.out)).toEqual({
    xid, name: 'hello', version: '1.0.0',
    url: `${mirror.base}hello/1.0.0.tgz`,
    endpoint: mirror.base,
    integrity: await sri('sha512', new Uint8Array(readFileSync(join(site, 'hello/1.0.0.tgz')))),
  });

  // A read side with no XID resolver and no cached XID document.
  const failure = (o: Partial<DrlOptions>) => drl({ spec: `${installName}@1.0.0`, ...readSide({ allowLoopback: true }), ...o }).then(
    () => 'no error',
    (e: Error) => e.message,
  );
  expect(await failure({})).toStartWith('XID_NOT_FOUND: no source has the XID document: no XID resolver is set');
  expect(await failure({ xidResolver: undefined })).toBe('KIND_NOT_SUPPORTED: "drl" has no XID resolver');
  expect(await failure({ denylist: [xid] })).toBe(`${xid} is on the denylist (SECURITY.md)`);
});

test('after a release key rotation, the index has both signatures, and a client with a pin on the old key accepts it', async () => {
  const trust = new Map<string, Pin>();
  // A new read side for each step, so no XID document stays in memory.
  const tarball = async (version: string) => {
    const { resolver, xidResolver, source } = readSide({ xidResolvers: [mirror.base], allowLoopback: true });
    const h = shimHandler({ origin: 'http://127.0.0.1:1', resolver, xidResolver, source, trust });
    const res = await h(new Request(`http://127.0.0.1:1/${installName}`));
    const body = await res.json() as { error?: string; versions: Record<string, { dist: { tarball: string } }> };
    if (res.status !== 200) throw new Error(`packument: ${res.status} ${body.error}`);
    return h(new Request(body.versions[version]!.dist.tarball));
  };
  expect((await tarball('1.0.0')).status).toBe(200);
  const old = trust.get(`${xid}/hello`)!;

  await updateXid({ alias: 'pub', rotate: ['release'], passphrase: async () => PASS, updatePassphrase: UPDATE_PASS, env });
  const r = await publish('1.1.0');
  expect(r.code, r.err).toBe(0);
  expect(JSON.parse(r.out).sequence).toBe(2);

  const res = await tarball('1.1.0');
  expect(res.status, await res.clone().text()).toBe(200);
  const pin = trust.get(`${xid}/hello`)!;
  expect(pin.epochKey).not.toBe(old.epochKey);
  expect(pin.keys).toEqual([old.epochKey, pin.epochKey]);
  expect(pin.sequence).toBe(2);
});

test('the shim answers 404 for a XID with no resolver and no cached document', async () => {
  const { resolver, xidResolver, source } = readSide({ allowLoopback: true });
  const res = await shimHandler({ origin: 'http://127.0.0.1:1', resolver, xidResolver, source, trust: new Map() })(
    new Request(`http://127.0.0.1:1/${installName}`));
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toContain('XID_NOT_FOUND');
});

test('publish --to dwn writes the protocol v2 to the did:key tenant, and the shim installs from the DWN', async () => {
  const relay = startRelay(new Map());
  const dwn = await startDwn({ relayUrl: relay.url });
  try {
    const created = await createXid({ alias: 'dpub', dwn: dwn.url, passphrase: PASS, updatePassphrase: UPDATE_PASS, env });
    // The XID resolver of the shim is the static mirror. The DWN holds only the package files.
    writeFileSync(join(site, 'xid', `${created.xid}.envelope`), readFileSync(created.files.document));
    const first = await run([process.execPath, cli, 'publish', 'dpub', tgz('1.0.0'), '--to', 'dwn']);
    expect(first.code, first.err).toBe(0);
    const out = JSON.parse(first.out);
    expect(out.targets).toEqual([{ url: dwn.url, ok: true }]);
    // The same tarball again reads the signed copies from the DWN and writes the same bytes.
    expect(JSON.parse((await run([process.execPath, cli, 'publish', 'dpub', tgz('1.0.0'), '--to', 'dwn'])).out)).toEqual(out);

    const { resolver, xidResolver, source } = readSide({ xidResolvers: [mirror.base], allowLoopback: true });
    const h = shimHandler({ origin: 'http://127.0.0.1:1', resolver, xidResolver, source, trust: new Map() });
    const packument = await (await h(new Request(`http://127.0.0.1:1/${out.installName}`))).json() as { versions: Record<string, { dist: { tarball: string } }> };
    const res = await h(new Request(packument.versions['1.0.0']!.dist.tarball));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(readFileSync(tgz('1.0.0'))));
  } finally {
    await dwn.stop();
    relay.stop();
  }
});
