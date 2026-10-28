// `didpkg id create|show` on a local Pkarr relay (PUT and GET) and the pinned dwn-server.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base64urlnopad } from '@scure/base';
import { DidResolver } from '@didpkg/core/did';
import { dhtDriver } from '@didpkg/core/did/dht';
import { DwnWriter, ed25519MessageSigner } from '@didpkg/adapter-dwn/writer';
import { startDwn } from '../../adapter-dwn/test/server.ts';
import { createDht, type CreateOptions } from '../src/id/dht.ts';
import { decryptKey, type EncryptedKey } from '../src/id/keyfile.ts';
import { idPaths, readIdentity } from '../src/id/store.ts';

/** A Pkarr relay on 127.0.0.1 that keeps each PUT. The resolver checks the BEP44 signature on GET. */
function putRelay() {
  const store = new Map<string, Uint8Array>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const id = new URL(req.url).pathname.slice(1);
      if (req.method === 'PUT') {
        store.set(id, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 204 });
      }
      const v = store.get(id);
      return v ? new Response(v, { headers: { 'content-type': 'application/pkarr.org/relays#payload' } }) : new Response('not found', { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, store, stop: () => server.stop(true) };
}

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'didpkg-id-'));
const env = { DIDPKG_HOME: home };
const PASS = { passphrase: 'release passphrase 1', updatePassphrase: 'update passphrase 2' };
const relay = putRelay();
let dwn: Awaited<ReturnType<typeof startDwn>>;
const base = (alias: string): CreateOptions => ({ alias, relays: [relay.url], env, iterations: 1000, ...PASS });

function run(args: string[], extra: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, cli, ...args], {
    env: { PATH: process.env.PATH!, DIDPKG_HOME: home, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

beforeAll(async () => {
  dwn = await startDwn({ relayUrl: relay.url });
});
afterAll(async () => {
  await dwn?.stop();
  relay.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('id create', () => {
  let r: Awaited<ReturnType<typeof createDht>>;
  beforeAll(async () => {
    r = await createDht({ ...base('main'), dwn: dwn.url, repos: ['https://me.example/pkgs/', 'https://mirror.example/'] });
  });

  test('the relay gets the signed payload, and the DWN gets the protocol', async () => {
    expect([r.relays, r.dwn]).toEqual([[{ url: relay.url, ok: true }], { url: dwn.url, ok: true }]);
    const id = readIdentity(idPaths('main', env));
    expect(relay.store.get(r.did.slice('did:dht:'.length))).toEqual(base64urlnopad.decode(id.relayPayload));
    // A record write needs the protocol on the DWN.
    const seed = await decryptKey(id.releaseKey, PASS.passphrase);
    const writer = new DwnWriter({ dwnUrl: dwn.url, did: r.did, signer: ed25519MessageSigner(seed, r.keyId) });
    await writer.writeIndex({ name: 'hello', index: new TextEncoder().encode('{}') });
  });

  test('the resolved document has #0 and #didpkg-1 in assertionMethod, and the two services', async () => {
    const resolver = new DidResolver({ drivers: [dhtDriver({ relays: [relay.url], allowPrivateRelays: true })] });
    const doc = (await resolver.resolve(r.did)).didDocument!;
    expect(doc.assertionMethod).toEqual([`${r.did}#0`, r.keyId]);
    expect(doc.verificationMethod!.find((v) => v.id === r.keyId)).toMatchObject({ type: 'JsonWebKey', controller: r.did, publicKeyJwk: { crv: 'Ed25519' } });
    expect(doc.service).toEqual([
      { id: `${r.did}#dwn`, type: 'DecentralizedWebNode', serviceEndpoint: [dwn.url] },
      { id: `${r.did}#pkg`, type: 'DIDPackageRepository', serviceEndpoint: ['https://me.example/pkgs/', 'https://mirror.example/'] },
    ]);
  });

  test('the identity file holds only #didpkg-1, and the update key file holds only #0', async () => {
    const paths = idPaths('main', env);
    const id = readIdentity(paths);
    const update: EncryptedKey = JSON.parse(readFileSync(paths.updateKey, 'utf8'));
    const vm = (f: string) => id.document.verificationMethod!.find((v) => v.id === `${r.did}#${f}`)!.publicKeyJwk!.x!;
    expect([id.releaseKey.keyId, id.releaseKey.publicKeyJwk.x]).toEqual([r.keyId, vm('didpkg-1')]);
    expect([update.keyId, update.publicKeyJwk.x]).toEqual([`${r.did}#0`, vm('0')]);
    const hot = readFileSync(paths.identity, 'utf8');
    expect([hot.includes(update.ciphertext), hot.includes(`"keyId": "${r.did}#0"`)]).toEqual([false, false]);
    expect(await decryptKey(update, PASS.updatePassphrase)).toHaveLength(32);
    await expect(decryptKey(update, PASS.passphrase)).rejects.toThrow('wrong passphrase');
    expect([statSync(paths.dir).mode & 0o777, statSync(paths.identity).mode & 0o777, statSync(paths.updateKey).mode & 0o777]).toEqual([0o700, 0o600, 0o600]);
  });

  test('an alias that exists fails, and its files stay', async () => {
    const before = readFileSync(idPaths('main', env).identity, 'utf8');
    await expect(createDht(base('main'))).rejects.toThrow('didpkg never replaces a key');
    expect(readFileSync(idPaths('main', env).identity, 'utf8')).toBe(before);
  });
});

test('bad input fails before a file write', async () => {
  const cases: [Partial<CreateOptions>, string][] = [
    [{ alias: '../x' }, 'bad alias'],
    [{ alias: 'Main' }, 'bad alias'],
    [{ updatePassphrase: PASS.passphrase }, 'must not be the release key passphrase'],
    [{ dwn: 'http://dwn.example' }, 'must use https'],
    [{ repos: ['ftp://me.example/'] }, 'must use https'],
    [{ relays: ['not a url'] }, 'is not a URL'],
    [{ relays: [] }, 'no relay'],
    [{ repos: Array.from({ length: 12 }, (_, i) => `https://mirror-${i}.example.com/packages/for/the/publisher/`) }, 'exceeds the 1000 byte maximum'],
  ];
  for (const [patch, message] of cases) await expect(createDht({ ...base('bad'), ...patch })).rejects.toThrow(message);
  expect(existsSync(join(home, 'ids', 'bad.json'))).toBe(false);
});

test('--dwn with no relay up skips the protocol install', async () => {
  const refuses = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('bad signature', { status: 400 }) });
  const refusing = `http://127.0.0.1:${refuses.port}`;
  try {
    const r = await createDht({ ...base('no-relay'), relays: ['http://127.0.0.1:9', refusing], dwn: dwn.url });
    expect(r.relays.map((x) => x.ok)).toEqual([false, false]);
    expect(r.relays[1]).toEqual({ url: refusing, ok: false, error: 'HTTP 400' });
    expect(r.dwn).toEqual({ url: dwn.url, ok: false, error: 'no relay accepted the DID' });
  } finally {
    refuses.stop(true);
  }
});

test('an identity file with another DID in the document fails', async () => {
  const paths = idPaths('no-relay', env);
  const id = JSON.parse(readFileSync(paths.identity, 'utf8'));
  id.document.id = 'did:dht:other';
  writeFileSync(paths.identity, JSON.stringify(id));
  expect(() => readIdentity(paths)).toThrow('do not agree');
});

describe('the CLI', () => {
  const pass = { DIDPKG_PASSPHRASE: PASS.passphrase, DIDPKG_UPDATE_PASSPHRASE: PASS.updatePassphrase };

  test('id create with no relay up saves the identity and exits 1', () => {
    const down = run(['id', 'create', 'offline', '--relay', 'http://127.0.0.1:9'], pass);
    expect(down.code).toBe(1);
    expect(down.err).toContain('the identity is saved, but no relay accepted the DID');
    const out = JSON.parse(down.out);
    expect([out.alias, out.relays[0].ok, existsSync(out.files.identity), existsSync(out.files.updateKey)]).toEqual(['offline', false, true, true]);
  });

  test('id show prints the public data, and null for an update key that is offline', () => {
    const shown = run(['id', 'show', 'main']);
    expect(shown.code).toBe(0);
    const out = JSON.parse(shown.out);
    expect(out.keyId).toBe(`${out.did}#didpkg-1`);
    expect(out.files.updateKey).toBe(join(home, 'ids', 'main.update-key.json'));
    expect(shown.out).not.toContain('ciphertext');
    renameSync(out.files.updateKey, join(home, 'cold.json'));
    expect(JSON.parse(run(['id', 'show', 'main']).out).files.updateKey).toBeNull();
  });

  test('errors: no passphrase, a short passphrase, a usage error, an unknown alias', () => {
    const cases: [string[], Record<string, string>, string][] = [
      [['id', 'create', 'x', '--relay', relay.url], {}, 'no passphrase: set DIDPKG_PASSPHRASE'],
      [['id', 'create', 'x', '--relay', relay.url], { ...pass, DIDPKG_PASSPHRASE: 'short' }, 'use 12 or more characters'],
      [['id', 'create'], pass, '"id create" needs 1 argument'],
      [['id', 'create', 'x', '--bogus', '1'], pass, 'unknown option --bogus'],
      [['id', 'create', 'x', '--dwn'], pass, '--dwn needs a value'],
      [['id', 'create', 'x', '--dwn', 'https://a.example', '--dwn', 'https://b.example'], pass, 'use --dwn one time'],
      [['id'], {}, '"id" needs a subcommand'],
      [['id', 'show', 'nobody'], {}, 'cannot read'],
    ];
    for (const [args, extra, message] of cases) {
      const r = run(args, extra);
      expect([args.join(' '), r.code, r.err]).toEqual([args.join(' '), 1, expect.stringContaining(message)]);
    }
    expect(existsSync(join(home, 'ids', 'x.json'))).toBe(false);
  });
});
