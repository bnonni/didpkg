// `didpkg id create --plc`, `didpkg id update` and `didpkg id register` for did:plc, and a did:plc publish to a folder.
// A stub directory takes the POST and serves the audit log. Like the directory, it refuses a second genesis operation
// and an update operation with an old `prev` with HTTP 400.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { DidResolver } from '@didpkg/core/did';
import { cidOf, didOf, plcDriver } from '@didpkg/core/did/plc';
import { toMultikey, verifyProof } from '@didpkg/core/trust';
import { DirWriter } from '@didpkg/adapter-https/dir';
import { decryptKey } from '../src/id/keyfile.ts';
import { createPlc, registerPlc, updatePlc, type PlcOperation } from '../src/id/plc.ts';
import { idPaths, readIdentity } from '../src/id/store.ts';
import { publish } from '../src/publish/publish.ts';
import { npmTgz } from './tgz.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-id-plc-'));
const env = { DIDPKG_HOME: tmp };
const PASS = 'release passphrase 1';
const UPDATE_PASS = 'update passphrase 1';
const REPOS = ['https://pkgs.example.com/plc/', 'https://mirror.example.org/plc/'];

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Entry = { did: string; operation: PlcOperation; cid: string; nullified: boolean; createdAt: string };

/**
 * A stub directory. `status` is the HTTP status of each POST, for a directory that fails. With `lose`, the directory
 * takes the operation, but the reply is HTTP 503, as for a reply that a network fault loses.
 */
function stubDirectory() {
  const logs = new Map<string, Entry[]>();
  const posts: PlcOperation[] = [];
  const d = {
    logs, posts, status: 200, lose: false,
    async handle(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname.slice(1);
      if (req.method === 'POST') {
        const op = (await req.json()) as PlcOperation;
        posts.push(op);
        if (d.status !== 200) return Response.json({ message: 'the directory is down' }, { status: d.status });
        const log = logs.get(path);
        if (log && op.prev !== log.at(-1)!.cid) return Response.json({ message: 'Proposed prev does not match the most recent operation' }, { status: 400 });
        if (!log && didOf(op) !== path) return Response.json({ message: 'Hash of genesis operation does not match DID identifier' }, { status: 400 });
        logs.set(path, [...(log ?? []), { did: path, operation: op, cid: cidOf(op), nullified: false, createdAt: new Date().toISOString() }]);
        return new Response(null, { status: d.lose ? 503 : 200 });
      }
      const log = path.endsWith('/log/audit') ? logs.get(path.slice(0, -'/log/audit'.length)) : undefined;
      return log ? Response.json(log) : new Response('not found', { status: 404 });
    },
    fetch: ((url: string, init?: RequestInit) => d.handle(new Request(url, init))) as typeof fetch,
  };
  return d;
}

describe('id create --plc', async () => {
  const dir = stubDirectory();
  const r = await createPlc({
    alias: 'plc', directory: 'https://plc.example/', repos: REPOS, passphrase: PASS, updatePassphrase: UPDATE_PASS, env, fetch: dir.fetch, iterations: 1000,
  });
  const paths = idPaths('plc', env);
  const identity = readIdentity(paths);
  const resolved = await new DidResolver({ drivers: [plcDriver({ fetch: dir.fetch })] }).resolve(r.did);

  test('the POST sends the signed genesis operation, and the directory takes it', () => {
    expect(r.did).toMatch(/^did:plc:[a-z2-7]{24}$/);
    expect(r.directory).toEqual({ url: `https://plc.example/${r.did}`, ok: true });
    expect(dir.posts).toEqual([identity.plc!.genesis]);
    expect(identity.plc!.directory).toBe('https://plc.example');
    const op = identity.plc!.genesis;
    expect(didOf(op)).toBe(r.did);
    expect(op).toMatchObject({ type: 'plc_operation', alsoKnownAs: [], prev: null });
    expect(op.rotationKeys).toEqual([expect.stringMatching(/^did:key:zQ3s/)]);
    expect(op.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  test('the log resolves to a document with the Multikey #didpkg-1, a service for each repo, and no assertionMethod', () => {
    const doc = resolved.didDocument!;
    expect(doc.id).toBe(r.did);
    expect(doc.assertionMethod).toBeUndefined();
    expect(doc.verificationMethod).toEqual([{ id: r.keyId, type: 'Multikey', controller: r.did, publicKeyMultibase: expect.stringMatching(/^z6Mk/) }]);
    expect(doc.service).toEqual([
      { id: '#pkg', type: 'DIDPackageRepository', serviceEndpoint: REPOS[0] },
      { id: '#pkg-2', type: 'DIDPackageRepository', serviceEndpoint: REPOS[1] },
    ]);
    expect(identity.document as unknown).toEqual(doc);
  });

  test('the update key file holds the secp256k1 rotation key of the genesis operation, and both files have mode 0600', async () => {
    const rotation = await decryptKey(await Bun.file(paths.updateKey).json(), UPDATE_PASS);
    expect(`did:key:${toMultikey({ alg: 'secp256k1', bytes: secp256k1.getPublicKey(rotation) })}`).toBe((identity.plc!.genesis.rotationKeys as string[])[0]!);
    expect(statSync(r.files.identity).mode & 0o777).toBe(0o600);
    expect(statSync(r.files.updateKey).mode & 0o777).toBe(0o600);
  });

  test('register sends the operation again: the directory gives HTTP 400, and its log starts with the operation', async () => {
    expect(await registerPlc(identity, dir.fetch)).toEqual({ url: `https://plc.example/${r.did}`, ok: true });
    expect(dir.posts).toHaveLength(2);
    const other = stubDirectory();
    other.logs.set(r.did, [{ did: r.did, operation: { type: 'plc_tombstone', prev: 'x' }, cid: 'x', nullified: false, createdAt: new Date().toISOString() }]);
    expect(await registerPlc(identity, other.fetch)).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 400') });
  });

  test('a failed POST keeps the identity, and register sends the DID later', async () => {
    const down = stubDirectory();
    down.status = 503;
    const f = await createPlc({
      alias: 'down', directory: 'https://plc.example', repos: REPOS.slice(0, 1), passphrase: PASS, updatePassphrase: UPDATE_PASS, env, fetch: down.fetch, iterations: 1000,
    });
    expect(f.directory).toMatchObject({ ok: false, error: 'HTTP 503: {"message":"the directory is down"}' });
    down.status = 200;
    expect(await registerPlc(readIdentity(idPaths('down', env)), down.fetch)).toMatchObject({ ok: true });
    expect(down.logs.has(f.did)).toBe(true);
  });

  test('bad options fail before a file write', async () => {
    const o = { directory: 'https://plc.example', repos: REPOS, passphrase: PASS, updatePassphrase: UPDATE_PASS, env, fetch: dir.fetch, iterations: 1000 };
    const long = Array.from({ length: 10 }, (_, i) => `https://pkgs.example.com/${String(i).repeat(480)}`);
    const cases: [string, Partial<typeof o>, string][] = [
      ['b1', { updatePassphrase: PASS }, 'must not be'],
      ['b2', { repos: [] }, 'needs a --dwn URL or a --repo URL'],
      ['b3', { repos: Array.from({ length: 11 }, (_, i) => `https://pkgs.example.com/${i}/`) }, 'takes 10 services'],
      ['b4', { repos: [`https://pkgs.example.com/${'x'.repeat(500)}`] }, 'takes 512 characters'],
      ['b5', { repos: long }, 'the directory takes 4000'],
      ['b6', { directory: 'http://plc.example' }, '--plc: http://plc.example must use https'],
      ['b7', { repos: ['ftp://pkgs.example.com/'] }, 'must use https'],
    ];
    for (const [alias, change, error] of cases) {
      await expect(createPlc({ ...o, ...change, alias })).rejects.toThrow(error);
      expect(existsSync(idPaths(alias, env).identity)).toBe(false);
    }
    await expect(createPlc({ ...o, alias: 'plc' })).rejects.toThrow('exists');
    expect(dir.posts).toHaveLength(2);
  });

  test('publish to a folder checks #didpkg-1 with the did:plc key rule, and the release verifies against the resolved document', async () => {
    const site = join(tmp, 'site');
    const out = await publish({ identity, tarball: npmTgz({ name: 'hello', version: '1.0.0' }), to: [`dir:${site}`], passphrase: async () => PASS });
    expect(out.relays).toEqual([]);
    expect(out.targets).toEqual([{ url: `dir:${site}`, ok: true }]);
    expect(out.installName).toBe(`@didpkg/hello_did_plc_${r.did.slice('did:plc:'.length)}`);
    const [release] = await Array.fromAsync(new DirWriter(site).read({ kind: 'release', name: 'hello', version: '1.0.0' }, { signal: AbortSignal.timeout(5000), maxBytes: 1 << 20 }));
    expect((await verifyProof(JSON.parse(new TextDecoder().decode(release)), resolved.didDocument!)).verificationMethod).toBe(r.keyId);
  });
});

describe('id update for did:plc', async () => {
  const dir = stubDirectory();
  const u = { alias: 'up', updatePassphrase: UPDATE_PASS, env, fetch: dir.fetch };
  const r = await createPlc({ ...u, directory: 'https://plc.example', dwn: 'https://dwn.example', repos: REPOS.slice(0, 1), passphrase: PASS, iterations: 1000 });
  const paths = idPaths('up', env);
  const genesis = readIdentity(paths).plc!.genesis;
  const resolve = async () => (await new DidResolver({ drivers: [plcDriver({ fetch: dir.fetch })] }).resolve(r.did)).didDocument!;
  const dwn = (url: string) => ({ id: '#dwn', type: 'DecentralizedWebNode', serviceEndpoint: url });
  const pkg = (id: string, url: string) => ({ id, type: 'DIDPackageRepository', serviceEndpoint: url });

  test('id create --plc --dwn puts the service #dwn in the genesis operation', async () => {
    expect(genesis.services).toEqual({
      dwn: { type: 'DecentralizedWebNode', endpoint: 'https://dwn.example' }, pkg: { type: 'DIDPackageRepository', endpoint: REPOS[0] },
    });
    expect((await resolve()).service).toEqual([dwn('https://dwn.example'), pkg('#pkg', REPOS[0]!)]);
  });

  test('--dwn and --remove dwn with --repo change the services, and each prev names the operation before it', async () => {
    const a = await updatePlc({ ...u, dwn: 'https://dwn2.example' });
    expect(a.directory).toEqual({ url: `https://plc.example/${r.did}`, ok: true });
    expect((await resolve()).service).toEqual([dwn('https://dwn2.example'), pkg('#pkg', REPOS[0]!)]);
    const b = await updatePlc({ ...u, removeDwn: true, repos: REPOS });
    const log = dir.logs.get(r.did)!;
    expect(log.map((e) => e.cid)).toEqual([cidOf(genesis), a.cid, b.cid]);
    expect(log.map((e) => e.operation.prev)).toEqual([null, cidOf(genesis), a.cid]);
    expect(log[2]!.operation).toMatchObject({ type: 'plc_operation', rotationKeys: genesis.rotationKeys, verificationMethods: genesis.verificationMethods, alsoKnownAs: [] });
    const doc = await resolve();
    expect(doc.service).toEqual([pkg('#pkg', REPOS[0]!), pkg('#pkg-2', REPOS[1]!)]);
    const identity = readIdentity(paths);
    expect(identity.plc!.updates).toEqual([log[1]!.operation, log[2]!.operation]);
    expect(identity.document as unknown).toEqual(doc);
    expect(statSync(paths.identity).mode & 0o777).toBe(0o600);
  });

  test('a lost reply changes no file, and the same update again finds the operation in the log of the directory', async () => {
    const before = readFileSync(paths.identity, 'utf8');
    dir.lose = true;
    await expect(updatePlc({ ...u, dwn: 'https://dwn3.example' })).rejects.toThrow('the directory did not take the operation (HTTP 503');
    dir.lose = false;
    expect(readFileSync(paths.identity, 'utf8')).toBe(before);
    const again = await updatePlc({ ...u, dwn: 'https://dwn3.example' });
    expect(again.directory.ok).toBe(true);
    expect(dir.logs.get(r.did)!.map((e) => e.cid).at(-1)).toBe(again.cid);
    expect(readIdentity(paths).plc!.updates).toHaveLength(3);
    expect((await resolve()).service![0]).toEqual(dwn('https://dwn3.example'));
  });

  test('bad updates fail before the POST', async () => {
    const posts = dir.posts.length;
    const cases: [Partial<Parameters<typeof updatePlc>[0]>, string][] = [
      [{}, 'nothing to update'],
      [{ dwn: 'https://x.example', removeDwn: true }, 'not both'],
      [{ removeDwn: true, repos: [] }, 'needs a --dwn URL or a --repo URL'],
      [{ dwn: 'http://x.example' }, 'dwn: http://x.example must use https'],
      [{ dwn: 'https://x.example', updatePassphrase: PASS }, 'wrong passphrase'],
    ];
    for (const [change, error] of cases) await expect(updatePlc({ ...u, ...change })).rejects.toThrow(error);
    expect(dir.posts).toHaveLength(posts);
  });
});

describe('the CLI', () => {
  const dir = stubDirectory();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => dir.handle(req) });
  const url = `http://127.0.0.1:${server.port}`;
  afterAll(() => server.stop(true));
  const keys = { DIDPKG_PASSPHRASE: PASS, DIDPKG_UPDATE_PASSPHRASE: UPDATE_PASS };
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, cli, ...args], {
      env: { PATH: process.env.PATH!, ...env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  };

  test('id create --plc sends the DID to the directory', async () => {
    const r = await run(['id', 'create', 'cli', '--plc', url, '--repo', REPOS[0]!], keys);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.did).toMatch(/^did:plc:[a-z2-7]{24}$/);
    expect(out.directory).toEqual({ url: `${url}/${out.did}`, ok: true });
    expect(dir.logs.has(out.did)).toBe(true);
    expect(r.err).toContain(`Move ${out.files.updateKey} offline.`);
  });

  test('a failed POST exits 1 and names "didpkg id register", and register then sends the DID', async () => {
    dir.status = 500;
    const r = await run(['id', 'create', 'cli-down', '--plc', url, '--repo', REPOS[0]!], keys);
    dir.status = 200;
    expect(r.code).toBe(1);
    expect(r.err).toContain('the identity is saved, but the directory did not take the DID (HTTP 500');
    expect(r.err).toContain('Run "didpkg id register cli-down" to send it again.');
    const again = await run(['id', 'register', 'cli-down']);
    expect(again.code).toBe(0);
    expect(dir.logs.has(JSON.parse(r.out).did)).toBe(true);
    const dwn = await run(['id', 'register', 'cli-down', '--dwn', 'http://dwn.example']);
    expect([dwn.code, dwn.err]).toEqual([1, expect.stringContaining('--dwn: http://dwn.example must use https')]);
    const terms = await run(['id', 'register', 'cli-down', '--accept-terms', 'a'.repeat(64)]);
    expect([terms.code, terms.err]).toEqual([1, expect.stringContaining('--accept-terms needs a DWN')]);
  });

  test('id update --dwn sends an update operation, and --rotate is for a XID identity only', async () => {
    const r = await run(['id', 'update', 'cli', '--dwn', 'https://dwn.example'], keys);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(dir.logs.get(out.did)!.map((e) => e.cid)).toEqual([expect.any(String), out.cid]);
    expect(r.err).toContain(`The directory took the operation ${out.cid}.`);
    const rotate = await run(['id', 'update', 'cli', '--rotate', 'release'], keys);
    expect([rotate.code, rotate.err]).toEqual([1, expect.stringContaining('--rotate is for a XID identity only')]);
  });

  test('--plc with --web or --relay, without --dwn and --repo, or with a bad URL fails before a file write', async () => {
    const cases: [string, string[], string][] = [
      ['p1', ['--plc', url, '--webvh', 'example.net'], 'use --plc without --web and --webvh'],
      ['p2', ['--plc', url, '--dwn', 'http://dwn.example'], 'dwn: http://dwn.example must use https'],
      ['p3', ['--plc', url, '--repo', REPOS[0]!, '--relay', 'https://relay.example'], '--relay is for did:dht only'],
      ['p4', ['--plc', url], '--plc needs --dwn <url> or --repo <url>'],
      ['p5', ['--plc', url, '--plc', url, '--repo', REPOS[0]!], 'use --plc one time'],
      ['p6', ['--plc', 'http://plc.example', '--repo', REPOS[0]!], '--plc: http://plc.example must use https'],
    ];
    for (const [alias, args, error] of cases) {
      const r = await run(['id', 'create', alias, ...args], keys);
      expect(r.code).toBe(1);
      expect(r.err).toContain(error);
      expect(existsSync(idPaths(alias, env).identity)).toBe(false);
    }
  });
});
