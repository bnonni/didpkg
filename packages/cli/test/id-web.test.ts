// `didpkg id create --web` and a did:web publish to a folder. The demo covers did:web on a DWN, because
// both did:web resolvers need a TLS host.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DidResolver } from '@didpkg/core/did';
import { webDriver } from '@didpkg/core/did/web';
import { verifyProof } from '@didpkg/core/trust';
import { DirWriter } from '@didpkg/adapter-https/dir';
import { decryptKey } from '../src/id/keyfile.ts';
import { idPaths, readIdentity } from '../src/id/store.ts';
import { createWeb, documentUrl } from '../src/id/web.ts';
import { publish } from '../src/publish/publish.ts';
import { npmTgz } from './tgz.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-id-web-'));
const env = { DIDPKG_HOME: tmp };
const PASS = 'release passphrase 1';

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('documentUrl gives the URL of both did:web resolvers, and refuses a bad id', () => {
  expect(documentUrl('example.com')).toBe('https://example.com/.well-known/did.json');
  expect(documentUrl('me.github.io:pkgs')).toBe('https://me.github.io/pkgs/did.json');
  expect(documentUrl('localhost%3A8443:a:b')).toBe('https://localhost:8443/a/b/did.json');
  for (const bad of ['', 'Example.com', 'a b', 'example.com:', 'example.com/x', 'example.com%3A443', 'example.com%3Ax', 'me@example.com', 'example.com:a%2Fb']) {
    expect(() => documentUrl(bad)).toThrow('--web');
  }
});

describe('id create --web', async () => {
  const r = await createWeb({
    alias: 'web', web: 'example.com:pkgs', dwn: 'https://dwn.example', repos: ['https://example.com/pkgs/'], passphrase: PASS, env, iterations: 1000,
  });
  const paths = idPaths('web', env);
  const hosted = JSON.parse(readFileSync(r.files.document, 'utf8'));

  test('the did.json holds only #didpkg-1 in assertionMethod, and the two services', () => {
    expect(r.did).toBe('did:web:example.com:pkgs');
    expect(r.documentUrl).toBe('https://example.com/pkgs/did.json');
    expect(hosted.id).toBe(r.did);
    expect(hosted.assertionMethod).toEqual([r.keyId]);
    expect(hosted.verificationMethod).toHaveLength(1);
    expect(hosted.verificationMethod[0]).toMatchObject({ id: r.keyId, type: 'JsonWebKey', controller: r.did, publicKeyJwk: { crv: 'Ed25519' } });
    expect(hosted.verificationMethod[0].publicKeyJwk.d).toBeUndefined();
    expect(hosted.service).toEqual([
      { id: `${r.did}#dwn`, type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example'] },
      { id: `${r.did}#pkg`, type: 'DIDPackageRepository', serviceEndpoint: ['https://example.com/pkgs/'] },
    ]);
  });

  test('the identity file has mode 0600, the did.json has mode 0644, and there is no update key', async () => {
    expect(statSync(r.files.identity).mode & 0o777).toBe(0o600);
    expect(statSync(r.files.document).mode & 0o777).toBe(0o644);
    expect(existsSync(paths.updateKey)).toBe(false);
    const id = readIdentity(paths);
    expect(id.relayPayload).toBeUndefined();
    expect(id.document).toEqual(hosted);
    expect((await decryptKey(id.releaseKey, PASS)).length).toBe(32);
  });

  test('an alias that exists fails', async () => {
    await expect(createWeb({ alias: 'web', web: 'example.org', passphrase: PASS, env, iterations: 1000 })).rejects.toThrow('exists');
  });

  test('publish to a folder does no relay PUT, and the release verifies against the resolved did.json', async () => {
    const site = join(tmp, 'site');
    const out = await publish({
      identity: readIdentity(paths), tarball: npmTgz({ name: 'hello', version: '1.0.0' }), to: [`dir:${site}`], passphrase: async () => PASS,
    });
    expect(out.relays).toEqual([]);
    expect(out.targets).toEqual([{ url: `dir:${site}`, ok: true }]);
    expect(out.installName).toBe('@didpkg/hello_web_example.com_pkgs');

    const fetchStub = async (url: string) => (url === r.documentUrl ? Response.json(hosted) : new Response('not found', { status: 404 }));
    const resolver = new DidResolver({ drivers: [webDriver({ fetch: fetchStub })] });
    const doc = (await resolver.resolve(r.did)).didDocument!;
    const [release] = await Array.fromAsync(new DirWriter(site).read({ kind: 'release', name: 'hello', version: '1.0.0' }, { signal: AbortSignal.timeout(5000), maxBytes: 1 << 20 }));
    expect((await verifyProof(JSON.parse(new TextDecoder().decode(release)), doc)).verificationMethod).toBe(r.keyId);
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

  test('id create --web needs only DIDPKG_PASSPHRASE, and says where to host the did.json', async () => {
    const r = await run(['id', 'create', 'cli', '--web', 'example.net', '--repo', 'https://example.net/'], { DIDPKG_PASSPHRASE: PASS });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ did: 'did:web:example.net', documentUrl: 'https://example.net/.well-known/did.json' });
    expect(r.err).toContain(`Host ${out.files.document} at https://example.net/.well-known/did.json`);
  });

  test('--web with --relay, and a bad --web, fail before a file write', async () => {
    const relay = await run(['id', 'create', 'x1', '--web', 'example.net', '--relay', 'https://relay.example'], { DIDPKG_PASSPHRASE: PASS });
    expect(relay.code).toBe(1);
    expect(relay.err).toContain('--relay is for did:dht only');
    const bad = await run(['id', 'create', 'x2', '--web', 'Example.net'], { DIDPKG_PASSPHRASE: PASS });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('--web: "Example.net" has a bad host');
    for (const alias of ['x1', 'x2']) expect(existsSync(idPaths(alias, env).identity)).toBe(false);
  });
});
