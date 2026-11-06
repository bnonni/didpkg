// `didpkg id create --key` and `--jwk`, then a did:key and a did:jwk publisher end to end: `didpkg id register` and
// `didpkg publish --to dwn` on the pinned dwn-server with a terms file and proof of work, then `npm install` through
// `didpkg shim start --dwn`. The DID documents have no services, so the shim finds the DWN only in its DWN list.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base64urlnopad } from '@scure/base';
import { DidResolver, jwkDriver, keyDriver } from '@didpkg/core/did';
import { sri } from '@didpkg/core/trust';
import { startDwn, startRelay } from '../../adapter-dwn/test/server.ts';
import { createKey, keyDid, type KeyMethod } from '../src/id/key.ts';
import { decryptKey } from '../src/id/keyfile.ts';
import { idPaths, readIdentity } from '../src/id/store.ts';
import { shimHandler } from '../src/shim/shim.ts';
import { readSide } from '../src/shim/start.ts';
import { npmTgz } from './tgz.ts';

setDefaultTimeout(60_000);

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-id-key-'));
const home = join(tmp, 'home');
const env = { DIDPKG_HOME: home };
const PASS = 'release passphrase 1';
const METHODS: KeyMethod[] = ['key', 'jwk'];
const terms = 'Test terms of service.\n';
const hash = createHash('sha256').update(terms, 'utf8').digest('hex');
const tarball = join(tmp, 'hello-1.0.0.tgz');
const resolver = new DidResolver({ drivers: [keyDriver(), jwkDriver()] });

/** Async: a sync spawn blocks this process, and thus the servers in it. */
async function run(args: string[], cwd = tmp) {
  const p = Bun.spawn(args[0] === 'npm' ? args : [process.execPath, cli, ...args], {
    cwd, env: { PATH: process.env.PATH!, HOME: home, ...env, DIDPKG_PASSPHRASE: PASS }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('createKey', () => {
  test('keyDid of the RFC 8037 Ed25519 key: the did:jwk value is the RFC 7638 thumbprint input', () => {
    const seed = base64urlnopad.decode('nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A');
    const publicKey = ed25519.getPublicKey(seed);
    expect(base64urlnopad.encode(publicKey)).toBe('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo');
    const { did, keyId } = keyDid('jwk', publicKey);
    expect(keyId).toBe(`${did}#0`);
    const json = new TextDecoder().decode(base64urlnopad.decode(did.slice('did:jwk:'.length)));
    expect(json).toBe('{"crv":"Ed25519","kty":"OKP","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}');
    expect(base64urlnopad.encode(createHash('sha256').update(json).digest())).toBe('kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
    const key = keyDid('key', publicKey);
    expect(key.did).toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/);
    expect(key.keyId).toBe(`${key.did}#${key.did.slice('did:key:'.length)}`);
  });

  test.each(METHODS)('did:%s: the identity has the resolved document, the DWN list and no other file', async (method) => {
    const alias = `local-${method}`;
    const r = await createKey({ alias, method, dwn: 'https://dwn.example', passphrase: PASS, env, iterations: 1000 });
    expect(r.did).toStartWith(`did:${method}:`);
    const id = readIdentity(idPaths(alias, env));
    expect(id.document).toEqual((await resolver.resolve(r.did)).didDocument! as never);
    expect(id.document.assertionMethod).toEqual([r.keyId]);
    expect(id.document.service).toBeUndefined();
    expect(id.dwn).toEqual(['https://dwn.example']);
    expect(statSync(r.files.identity).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, 'ids')).filter((f) => f.startsWith(`${alias}.`))).toEqual([`${alias}.json`]);
    expect((await decryptKey(id.releaseKey, PASS)).length).toBe(32);
    await expect(createKey({ alias, method, dwn: 'https://dwn.example', passphrase: PASS, env, iterations: 1000 })).rejects.toThrow('exists');
  });

  test('readIdentity refuses a did:key identity with no DWN list, and a DWN list on another method', () => {
    const paths = idPaths('local-key', env);
    const good = readFileSync(paths.identity, 'utf8');
    const id = JSON.parse(good);
    try {
      for (const dwn of [undefined, [], [1]]) {
        writeFileSync(paths.identity, JSON.stringify({ ...id, dwn }));
        expect(() => readIdentity(paths)).toThrow('a did:key or did:jwk identity needs a list of DWN URLs');
      }
    } finally {
      writeFileSync(paths.identity, good);
    }
  });
});

describe('the CLI', () => {
  test.each([
    ['no --dwn', ['--key'], '--key needs --dwn <url>'],
    ['--repo', ['--jwk', '--dwn', 'https://dwn.example', '--repo', 'https://pkgs.example.com/'], '--jwk takes no --repo'],
    ['both methods', ['--key', '--jwk', '--dwn', 'https://dwn.example'], 'use --key or --jwk, not both'],
    ['--web', ['--key', '--web', 'example.com', '--dwn', 'https://dwn.example'], 'use --key without --web, --webvh, --plc, --btcr2, --xid and --relay'],
    ['--xid', ['--jwk', '--xid', '--dwn', 'https://dwn.example'], 'use --jwk without --web'],
    ['--relay', ['--key', '--relay', 'https://relay.example', '--dwn', 'https://dwn.example'], 'use --key without --web'],
    ['http', ['--key', '--dwn', 'http://dwn.example'], '--dwn: http://dwn.example must use https'],
  ])('id create refuses %s before a file write', async (_l, flags, error) => {
    const r = await run(['id', 'create', 'refused', ...flags]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(error);
    expect(existsSync(idPaths('refused', env).identity)).toBe(false);
  });

  test('id show prints the DWN list, and id update refuses a DID that cannot change', async () => {
    const show = await run(['id', 'show', 'local-jwk']);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out)).toMatchObject({ service: [], dwn: ['https://dwn.example'], files: { updateKey: null } });
    const update = await run(['id', 'update', 'local-key', '--dwn', 'https://dwn2.example']);
    expect(update.code).toBe(1);
    expect(update.err).toContain('a did:key DID cannot change: make a new identity with "didpkg id create <alias> --key|--jwk --dwn <url>"');
  });
});

describe('end to end on a DWN', () => {
  const relay = startRelay(new Map());
  let dwn: Awaited<ReturnType<typeof startDwn>>;
  const names = new Map<KeyMethod, string>();

  beforeAll(async () => {
    writeFileSync(join(tmp, 'terms.txt'), terms);
    writeFileSync(tarball, npmTgz({ name: 'hello', version: '1.0.0', description: 'a did:key package' }));
    dwn = await startDwn({
      relayUrl: relay.url,
      env: {
        DWN_REGISTRATION_STORE_URL: 'sqlite://data/registration.db',
        DWN_TTL_CACHE_URL: 'sqlite://data/registration.db',
        DWN_REGISTRATION_PROOF_OF_WORK_ENABLED: 'true',
        DWN_REGISTRATION_PROOF_OF_WORK_INITIAL_MAX_HASH: `0000${'F'.repeat(60)}`,
        DWN_TERMS_OF_SERVICE_FILE_PATH: join(tmp, 'terms.txt'),
      },
    });
  });
  afterAll(async () => {
    await dwn?.stop();
    relay.stop();
  });

  test.each(METHODS)('did:%s: id create, id register, then publish --to dwn', async (method) => {
    const created = await run(['id', 'create', method, `--${method}`, '--dwn', dwn.url]);
    expect(created.code, created.err).toBe(0);
    const { did } = JSON.parse(created.out);
    expect(created.err).toContain(`"didpkg shim start --dwn ${dwn.url}"`);

    const early = await run(['publish', method, tarball, '--to', 'dwn']);
    expect(early.code).toBe(1);
    expect(early.err).toContain('Not a registered tenant');

    const reg = await run(['id', 'register', method, '--accept-terms', hash]);
    expect(reg.code, reg.err).toBe(0);
    expect(JSON.parse(reg.out)).toEqual({ alias: method, did, dwn: dwn.url, termsOfServiceHash: hash });

    const pub = await run(['publish', method, tarball, '--to', 'dwn']);
    expect(pub.code, pub.err).toBe(0);
    const out = JSON.parse(pub.out);
    expect(out).toMatchObject({ did, name: 'hello', version: '1.0.0', sequence: 1, relays: [] });
    expect(out.targets).toEqual([{ url: dwn.url, ok: true }]);
    // The method-specific id has capital letters, thus the name has the checksum form.
    expect(out.installName).toMatch(new RegExp(`^@didpkg/hello_did_${method}\\.[a-z0-9]+_[a-z0-9_-]+$`));
    names.set(method, out.installName);
  });

  test('npm install through "shim start --dwn" gets the signed integrity of both packages', async () => {
    const shim = Bun.spawn([process.execPath, cli, 'shim', 'start', '--port', '0', '--dwn', dwn.url, '--allow-loopback'], {
      env: { PATH: process.env.PATH!, HOME: home, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const first = await shim.stdout.getReader().read();
      const { url } = JSON.parse(new TextDecoder().decode(first.value));
      const app = join(tmp, 'app');
      mkdirSync(app);
      writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true }));
      writeFileSync(join(app, '.npmrc'), `@didpkg:registry=${url}/\n`);
      expect(names.size).toBe(2);
      const r = await run(['npm', 'install', ...names.values(), '--cache', join(tmp, 'npm-cache'), '--fetch-retries', '0', '--no-audit', '--no-fund'], app);
      expect(r.code, r.err).toBe(0);
      const lock = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8'));
      const integrity = await sri('sha512', new Uint8Array(readFileSync(tarball)));
      for (const name of names.values()) {
        expect(lock.packages[`node_modules/${name}`].integrity).toBe(integrity);
        expect(JSON.parse(readFileSync(join(app, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version).toBe('1.0.0');
      }
    } finally {
      shim.kill('SIGTERM');
      await shim.exited;
    }
  });

  test('a shim with no DWN list finds no source for a did:key package', async () => {
    const { resolver, xidResolver, source } = readSide({ allowLoopback: true });
    const res = await shimHandler({ origin: 'http://127.0.0.1:1', resolver, xidResolver, source, trust: new Map() })(
      new Request(`http://127.0.0.1:1/${names.get('key')}`));
    expect(res.status).toBe(404);
  });
});
