// `didpkg publish` on a local Pkarr relay and the pinned dwn-server, with no #0 key on disk.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DidResolver } from '@didpkg/core/did';
import { dhtDriver } from '@didpkg/core/did/dht';
import { PackageSource, type StorageReader, type StoredFile } from '@didpkg/core/source';
import { ed25519Signer, signIndex, signRelease, verifyRelease, type DidPkgIndex, type DidPkgRelease, type Pin } from '@didpkg/core/trust';
import { dwnAdapter } from '@didpkg/adapter-dwn';
import { DirWriter } from '@didpkg/adapter-https/dir';
import { startDwn } from '../../adapter-dwn/test/server.ts';
import { createDht } from '../src/id/dht.ts';
import { decryptKey } from '../src/id/keyfile.ts';
import { idPaths, readIdentity } from '../src/id/store.ts';
import { publish as publishRelease } from '../src/publish/publish.ts';
import { readTarball } from '../src/publish/tarball.ts';
import { putRelay } from './relay.ts';

setDefaultTimeout(30_000);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-publish-'));
const home = join(tmp, 'home');
const site = join(tmp, 'site');
const PASS = 'release passphrase 1';
const relay = putRelay();
let dwn: Awaited<ReturnType<typeof startDwn>>;
let did: string;
let updateSeed: Uint8Array;
let v130: string;

/** An `npm pack` style .tgz from the `tar` tool. `top` is the top folder name. */
function pack(files: Record<string, string>, o: { format?: 'gnu' | 'posix' | 'ustar'; top?: string } = {}): string {
  const dir = mkdtempSync(join(tmp, 'pack-'));
  const top = o.top ?? 'package';
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, top, path, '..'), { recursive: true });
    writeFileSync(join(dir, top, path), text);
  }
  const out = join(dir, 'out.tgz');
  const r = Bun.spawnSync(['tar', '-czf', out, `--format=${o.format ?? 'gnu'}`, '-C', dir, top]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return out;
}
const hello = (version: string, extra: Record<string, unknown> = {}) =>
  pack({ 'package.json': JSON.stringify({ name: 'hello', version, ...extra }), 'index.js': `module.exports = ${JSON.stringify(version)};\n` });

/** Async: a sync spawn blocks this process, and thus the relay in it. */
async function run(args: string[], extra: Record<string, string> = { DIDPKG_PASSPHRASE: PASS }) {
  const p = Bun.spawn([process.execPath, cli, ...args], {
    env: { PATH: process.env.PATH!, DIDPKG_HOME: home, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
const publish = (tgz: string, ...to: string[]) => run(['publish', 'pub', tgz, ...to.flatMap((t) => ['--to', t]), '--relay', relay.url]);

async function bytes(reader: StorageReader, file: StoredFile): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const b of reader.read(file, { signal: AbortSignal.timeout(10_000), maxBytes: 1 << 24 })) out.push(b);
  return out;
}
const dwnReader = () => dwnAdapter({ allowLoopback: true, indexTtlMs: 0 }).reader({ did, serviceId: `${did}#dwn`, type: 'DecentralizedWebNode', url: dwn.url }, { fetch });
const json = <T>(b: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(b)) as T;
/** The index, the release and the tarball of a version, from the DWN and from a folder. */
async function both(version: string, dir = site) {
  const files: StoredFile[] = [{ kind: 'index', name: 'hello' }, { kind: 'release', name: 'hello', version }, { kind: 'tarball', name: 'hello', version }];
  const [d, m] = [dwnReader(), new DirWriter(dir)];
  return { dwn: await Promise.all(files.map((f) => bytes(d, f))), dir: await Promise.all(files.map((f) => bytes(m, f))) };
}

beforeAll(async () => {
  dwn = await startDwn({ relayUrl: relay.url });
  const env = { DIDPKG_HOME: home };
  ({ did } = await createDht({ alias: 'pub', dwn: dwn.url, relays: [relay.url], env, iterations: 1000, passphrase: PASS, updatePassphrase: 'update passphrase 2' }));
  const updateKey = idPaths('pub', env).updateKey;
  updateSeed = await decryptKey(JSON.parse(readFileSync(updateKey, 'utf8')), 'update passphrase 2'); // only for a hostile #0 copy
  rmSync(updateKey); // no #0 key on disk
});
afterAll(async () => {
  await dwn?.stop();
  relay.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('publish', () => {
  test('to the DWN and a folder with no #0 key on disk: the same bytes, and the verifier accepts them', async () => {
    relay.store.clear(); // the re-PUT must send the DID again
    const r = await publish(hello('1.0.0', { bin: './index.js', scripts: { postinstall: 'node index.js' } }), 'dwn', `dir:${site}`);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ did, name: 'hello', version: '1.0.0', sequence: 1, installName: `@didpkg/hello_dht_${did.slice(8)}` });
    expect(out.relays).toEqual([{ url: relay.url, ok: true }]);
    expect(out.targets).toEqual([{ url: dwn.url, ok: true }, { url: `dir:${site}`, ok: true }]);
    expect(existsSync(idPaths('pub', { DIDPKG_HOME: home }).updateKey)).toBe(false);

    const { dwn: d, dir: m } = await both('1.0.0');
    expect(d.map((c) => c.length)).toEqual([1, 1, 1]);
    expect(d).toEqual(m);
    const release = json<DidPkgRelease>(d[1]![0]);
    expect(release.proof).toMatchObject({ verificationMethod: `${did}#didpkg-1` });
    expect(release.npm).toEqual({ bin: { hello: './index.js' }, hasInstallScript: true });

    const resolver = new DidResolver({ drivers: [dhtDriver({ relays: [relay.url], allowPrivateRelays: true })] });
    const source = new PackageSource({ resolver, adapters: [dwnAdapter({ allowLoopback: true })] });
    const v = await verifyRelease({ did, name: 'hello', version: '1.0.0', resolver, reader: source, trust: new Map<string, Pin>() });
    expect(v.tarball).toEqual(m[2]![0]!);
    expect(v.index.distTags).toEqual({ latest: '1.0.0' });
  });

  test('the next version links the last release, and the same publish again writes nothing new', async () => {
    const tgz = hello('1.1.0');
    expect((await publish(tgz, 'dwn', `dir:${site}`)).code).toBe(0);
    const first = await both('1.1.0');
    const index = json<DidPkgIndex>(first.dwn[0]![0]);
    const release = json<DidPkgRelease>(first.dwn[1]![0]);
    expect(index).toMatchObject({ sequence: 2, distTags: { latest: '1.1.0' } });
    expect(release.previous).toEqual({ version: '1.0.0', digest: index.releases['1.0.0']!.digest });

    const again = await publish(tgz, 'dwn', `dir:${site}`);
    expect([again.code, JSON.parse(again.out).sequence]).toEqual([0, 2]);
    expect(await both('1.1.0')).toEqual(first);
  });

  test('after a failed index write, the next run uses the signed release again', async () => {
    const before = join(tmp, 'index-before.json');
    copyFileSync(join(site, 'hello', 'index.json'), before);
    const tgz = hello('1.2.0');
    expect((await publish(tgz, `dir:${site}`)).code).toBe(0);
    copyFileSync(before, join(site, 'hello', 'index.json')); // the folder has the release, but not the index entry
    const released = (await both('1.2.0')).dir[1];

    const r = await publish(tgz, 'dwn', `dir:${site}`);
    expect([r.code, JSON.parse(r.out).sequence]).toEqual([0, 3]);
    const after = await both('1.2.0');
    expect(after.dwn).toEqual(after.dir);
    expect(after.dir[1]).toEqual(released!);
  });

  test('a published version does not change, and a failed read writes nothing', async () => {
    const head = (await both('1.2.0')).dwn[0];
    const other = await publish(hello('1.2.0', { description: 'other bytes' }), 'dwn', `dir:${site}`);
    expect([other.code, other.err]).toEqual([1, 'didpkg: error: hello@1.2.0 is published with a different tarball\n']);

    const file = join(tmp, 'a-file');
    writeFileSync(file, 'x');
    const broken = await publish(hello('1.3.0'), 'dwn', `dir:${file}`);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain('ENOTDIR');
    expect((await both('1.2.0')).dwn[0]).toEqual(head);
  });

  test('a failed target does not stop the other targets, and the exit code is 1', async () => {
    const locked = join(tmp, 'locked');
    mkdirSync(locked, { mode: 0o500 });
    v130 = hello('1.3.0');
    const r = await publish(v130, 'dwn', `dir:${locked}`);
    chmodSync(locked, 0o700);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).targets).toMatchObject([{ url: dwn.url, ok: true }, { url: `dir:${locked}`, ok: false }]);
    expect(r.err).toBe(`didpkg: error: dir:${locked} failed. Run the same publish again: it writes the same bytes.\n`);
    expect(json<DidPkgIndex>((await both('1.3.0')).dwn[0]![0]).sequence).toBe(4);
  });

  test('a folder that missed a publish gets the newest head from the DWN', async () => {
    const before = await both('1.3.0');
    expect(json<DidPkgIndex>(before.dir[0]![0]).sequence).toBe(3);
    await Bun.sleep(1100); // an index made from the old head then has another `updated` second, and other bytes
    const r = await publish(v130, 'dwn', `dir:${site}`);
    expect([r.code, JSON.parse(r.out).sequence]).toEqual([0, 4]);
    const after = await both('1.3.0');
    expect(after.dwn).toEqual(before.dwn);
    expect(after.dir).toEqual(after.dwn);
  });

  test('only own signed copies count: not #0, not another name; a conflict stops the publish', async () => {
    const id = readIdentity(idPaths('pub', { DIDPKG_HOME: home }));
    const release = ed25519Signer(await decryptKey(id.releaseKey, PASS), `${did}#didpkg-1`);
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const dirWith = (files: Record<string, Uint8Array>) => {
      const d = mkdtempSync(join(tmp, 'dir-'));
      for (const [path, b] of Object.entries(files)) {
        mkdirSync(join(d, path, '..'), { recursive: true });
        writeFileSync(join(d, path), b);
      }
      return d;
    };
    const v9 = hello('9.0.0');
    const byUpdateKey = await signIndex({ publisher: did, name: 'hello', head: null, releases: {}, sequence: 99 }, [ed25519Signer(updateSeed, `${did}#0`)]);
    const otherName = await signIndex({ publisher: did, name: 'other', head: null, releases: {}, sequence: 98 }, [release]);
    for (const head of [byUpdateKey, otherName]) {
      const r = await publish(v9, `dir:${dirWith({ 'hello/index.json': enc(head) })}`);
      expect([r.code, JSON.parse(r.out).sequence]).toEqual([0, 1]);
    }

    const listed = await publish(hello('1.0.0'), `dir:${dirWith({ 'hello/index.json': readFileSync(join(site, 'hello', 'index.json')) })}`);
    expect([listed.code, listed.err]).toEqual([1, 'didpkg: error: hello@1.0.0 is in the signed index with a different release\n']);

    const [tarball] = await bytes(dwnReader(), { kind: 'tarball', name: 'hello', version: '1.0.0' });
    const twin = await signRelease({ publisher: did, name: 'hello', version: '1.0.0', tarball: tarball!, npm: {}, head: null, published: '2026-01-01T00:00:00Z' }, [release]);
    const file = join(tmp, 'hello-1.0.0.tgz');
    writeFileSync(file, tarball!);
    const two = await publish(file, 'dwn', `dir:${dirWith({ 'hello/1.0.0.json': enc(twin) })}`);
    expect([two.code, two.err]).toEqual([1, 'didpkg: error: hello@1.0.0: the targets hold 2 different signed releases\n']);
  });

  test('after an id create with no relay, publish sends the DID and installs the DWN protocol', async () => {
    const c = await createDht({ alias: 'late', dwn: dwn.url, relays: ['http://127.0.0.1:9'], env: { DIDPKG_HOME: home }, iterations: 1000, passphrase: PASS, updatePassphrase: 'update passphrase 2' });
    expect(c.dwn).toMatchObject({ ok: false });
    const tgz = hello('1.0.0');
    const none = await run(['publish', 'late', tgz, '--to', `dir:${join(tmp, 'late')}`, '--relay', 'http://127.0.0.1:9']);
    expect([none.code, none.err]).toEqual([1, 'didpkg: error: no relay accepted the DID. Run the same publish again: it writes the same bytes.\n']);
    const r = await run(['publish', 'late', tgz, '--to', 'dwn', '--relay', relay.url]);
    expect([r.code, r.err]).toEqual([0, '']);
  });

  test('the signer is never #0, and it must be in assertionMethod', async () => {
    const id = readIdentity(idPaths('pub', { DIDPKG_HOME: home }));
    const tarball = new Uint8Array(readFileSync(hello('1.0.0')));
    const passphrase = async (): Promise<string> => {
      throw new Error('no prompt');
    };
    const cases: [string, string][] = [[`${did}#0`, 'the release key must not be the update key #0'], [`${did}#x`, `${did}#x is not in the assertionMethod`]];
    for (const [keyId, message] of cases) {
      await expect(publishRelease({ identity: { ...id, releaseKey: { ...id.releaseKey, keyId } }, tarball, to: ['dwn'], passphrase })).rejects.toThrow(message);
    }
  });

  test('bad input fails before the passphrase prompt', async () => {
    const noPass = (args: string[]) => run(args, {});
    const cases: [string[], string][] = [
      [['publish', 'pub', hello('1.0.0+b.1'), '--to', 'dwn'], '1.0.0+b.1: a version with build metadata is not published'],
      [['publish', 'pub', hello('1.0.0'), '--to', 's3:x'], '--to "s3:x": use "dwn" or "dir:<path>"'],
      [['publish', 'pub', hello('1.0.0')], '"publish" needs --to dwn or --to dir:<path>'],
      [['publish', 'nobody', hello('1.0.0'), '--to', 'dwn'], 'cannot read'],
      [['publish', 'pub', pack({ 'lib/package.json': '{}' }), '--to', 'dwn'], 'the tarball has no package.json in its top folder'],
    ];
    for (const [args, message] of cases) {
      const r = await noPass(args);
      expect([r.code, r.err]).toEqual([1, expect.stringContaining(message)]);
    }
    const wrong = await run(['publish', 'pub', hello('1.4.0'), '--to', 'dwn'], { DIDPKG_PASSPHRASE: 'wrong passphrase 1' });
    expect([wrong.code, wrong.err]).toEqual([1, expect.stringContaining('passphrase')]);
  });
});

describe('readTarball', () => {
  const read = (path: string) => readTarball(new Uint8Array(readFileSync(path)));
  const pkg = JSON.stringify({ name: '@x/tool', version: '2.0.0', bin: 'cli.js', dependencies: { a: '^1' }, scripts: { test: 'x' }, private: true });

  test('the npm fields, in each tar format, with a long top folder name', () => {
    for (const format of ['gnu', 'posix', 'ustar'] as const) {
      expect(read(pack({ 'package.json': pkg, 'lib/package.json': '{"name":"inner"}' }, { format, top: 't'.repeat(90) }))).toEqual({
        name: '@x/tool', version: '2.0.0', npm: { dependencies: { a: '^1' }, bin: { tool: 'cli.js' }, hasInstallScript: false },
      });
    }
  });

  test('binding.gyp is an install script, unless gypfile is false', () => {
    const gyp = (extra: Record<string, unknown>) => read(pack({ 'package.json': JSON.stringify({ name: 'g', version: '1.0.0', ...extra }), 'binding.gyp': '{}' })).npm.hasInstallScript;
    expect([gyp({}), gyp({ gypfile: false }), gyp({ gypfile: false, scripts: { preinstall: 'x' } })]).toEqual([true, false, true]);
  });
});
