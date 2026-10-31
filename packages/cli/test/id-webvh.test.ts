// `didpkg id create --webvh` and a did:webvh publish to a folder. A fetch stub serves the did.jsonl file.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { base64urlnopad } from '@scure/base';
import { DidResolver } from '@didpkg/core/did';
import { webvhDriver } from '@didpkg/core/did/webvh';
import { toMultikey, verifyProof } from '@didpkg/core/trust';
import { DirWriter } from '@didpkg/adapter-https/dir';
import { decryptKey } from '../src/id/keyfile.ts';
import { idPaths, readIdentity } from '../src/id/store.ts';
import { createWebvh, logUrl } from '../src/id/webvh.ts';
import { publish } from '../src/publish/publish.ts';
import { npmTgz } from './tgz.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-id-webvh-'));
const env = { DIDPKG_HOME: tmp };
const PASS = 'release passphrase 1';
const UPDATE_PASS = 'update passphrase 1';

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('logUrl gives the URL of the did.jsonl file, and refuses a bad address', () => {
  expect(logUrl('example.com')).toBe('https://example.com/.well-known/did.jsonl');
  expect(logUrl('nonni.org:pkgs')).toBe('https://nonni.org/pkgs/did.jsonl');
  expect(logUrl('example.com%3A8443:a:b')).toBe('https://example.com:8443/a/b/did.jsonl');
  for (const bad of ['', 'Example.com', 'example.com:', 'example.com/x', 'example.com%3A443']) expect(() => logUrl(bad)).toThrow('--webvh');
});

describe('id create --webvh', async () => {
  const r = await createWebvh({
    alias: 'vh', webvh: 'example.com:pkgs', dwn: 'https://dwn.example', repos: ['https://example.com/pkgs/'],
    passphrase: PASS, updatePassphrase: UPDATE_PASS, env, iterations: 1000,
  });
  const paths = idPaths('vh', env);
  const jsonl = readFileSync(r.files.log, 'utf8');
  const fetchStub = async (url: string) => (url === r.logUrl ? new Response(jsonl) : new Response('not found', { status: 404 }));
  const resolver = new DidResolver({ drivers: [webvhDriver({ fetch: fetchStub })] });
  const resolved = await resolver.resolve(r.did);

  test('the hosted log resolves to a document with only #didpkg-1 in assertionMethod, and the two services', async () => {
    expect(r.did).toMatch(/^did:webvh:Qm[1-9A-HJ-NP-Za-km-z]{44}:example\.com:pkgs$/);
    expect(r.logUrl).toBe('https://example.com/pkgs/did.jsonl');
    const doc = resolved.didDocument!;
    expect(doc.id).toBe(r.did);
    expect(doc.assertionMethod).toEqual([r.keyId]);
    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod![0]).toMatchObject({ id: r.keyId, type: 'JsonWebKey', controller: r.did, publicKeyJwk: { kty: 'OKP', crv: 'Ed25519' } });
    expect(doc.service).toContainEqual({ id: `${r.did}#dwn`, type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example'] });
    expect(doc.service).toContainEqual({ id: `${r.did}#pkg`, type: 'DIDPackageRepository', serviceEndpoint: ['https://example.com/pkgs/'] });
  });

  test('the identity and the update key have mode 0600, the did.jsonl has mode 0644, and there is no did.json', () => {
    expect(statSync(r.files.identity).mode & 0o777).toBe(0o600);
    expect(statSync(r.files.updateKey).mode & 0o777).toBe(0o600);
    expect(statSync(r.files.log).mode & 0o777).toBe(0o644);
    expect(existsSync(paths.document)).toBe(false);
    expect(jsonl.trim().split('\n')).toHaveLength(1);
  });

  test('each key decrypts only with its own passphrase, and the log lists the update key', async () => {
    const id = readIdentity(paths);
    const release = await decryptKey(id.releaseKey, PASS);
    expect(base64urlnopad.encode(await ed.getPublicKeyAsync(release))).toBe(id.document.verificationMethod![0]!.publicKeyJwk!.x!);
    const updateFile = JSON.parse(readFileSync(r.files.updateKey, 'utf8'));
    await expect(decryptKey(updateFile, PASS)).rejects.toThrow();
    const updateKey = toMultikey({ alg: 'Ed25519', bytes: await ed.getPublicKeyAsync(await decryptKey(updateFile, UPDATE_PASS)) });
    expect(updateFile.keyId).toBe(`did:key:${updateKey}#${updateKey}`);
    expect(JSON.parse(jsonl).parameters.updateKeys).toEqual([updateKey]);
  });

  test('one passphrase for both keys, and an alias that exists, fail', async () => {
    const o = { webvh: 'example.org', passphrase: PASS, env, iterations: 1000 };
    await expect(createWebvh({ ...o, alias: 'same', updatePassphrase: PASS })).rejects.toThrow('must not be');
    expect(existsSync(idPaths('same', env).identity)).toBe(false);
    await expect(createWebvh({ ...o, alias: 'vh', updatePassphrase: UPDATE_PASS })).rejects.toThrow('exists');
  });

  test('publish to a folder does no relay PUT, and the release verifies against the resolved document', async () => {
    const site = join(tmp, 'site');
    const out = await publish({
      identity: readIdentity(paths), tarball: npmTgz({ name: 'hello', version: '1.0.0' }), to: [`dir:${site}`], passphrase: async () => PASS,
    });
    expect(out.relays).toEqual([]);
    expect(out.targets).toEqual([{ url: `dir:${site}`, ok: true }]);
    expect(out.installName).toStartWith('@didpkg/hello_webvh.');
    const [release] = await Array.fromAsync(new DirWriter(site).read({ kind: 'release', name: 'hello', version: '1.0.0' }, { signal: AbortSignal.timeout(5000), maxBytes: 1 << 20 }));
    expect((await verifyProof(JSON.parse(new TextDecoder().decode(release)), resolved.didDocument!)).verificationMethod).toBe(r.keyId);
  });
});

describe('the CLI', () => {
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, cli, ...args], {
      env: { PATH: process.env.PATH!, ...env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  };

  test('id create --webvh tells where to host the log', async () => {
    const r = await run(['id', 'create', 'cli', '--webvh', 'example.net', '--repo', 'https://example.net/'], {
      DIDPKG_PASSPHRASE: PASS, DIDPKG_UPDATE_PASSPHRASE: UPDATE_PASS,
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ did: expect.stringMatching(/^did:webvh:Qm\w+:example\.net$/), logUrl: 'https://example.net/.well-known/did.jsonl' });
    expect(r.err).toContain(`Host ${out.files.log} at https://example.net/.well-known/did.jsonl. Move ${out.files.updateKey} offline.`);
  });

  test('--webvh with --web, with --relay, or with a bad address fails before a file write', async () => {
    const cases: [string, string[], string][] = [
      ['y1', ['--webvh', 'example.net', '--web', 'example.net'], 'use --web or --webvh, not both'],
      ['y2', ['--webvh', 'example.net', '--relay', 'https://relay.example'], '--relay is for did:dht only'],
      ['y3', ['--webvh', 'Example.net'], '--webvh: "Example.net" has a bad host'],
      ['y4', ['--webvh', 'example.net', '--webvh', 'example.org'], 'use --webvh one time'],
    ];
    for (const [alias, args, error] of cases) {
      const r = await run(['id', 'create', alias, ...args], { DIDPKG_PASSPHRASE: PASS, DIDPKG_UPDATE_PASSPHRASE: UPDATE_PASS });
      expect(r.code).toBe(1);
      expect(r.err).toContain(error);
      expect(existsSync(idPaths(alias, env).identity)).toBe(false);
    }
  });
});
