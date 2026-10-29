// `didpkg id register` on the pinned dwn-server with a tenant store, a terms file and proof of work, then `didpkg publish`.
// The test difficulty needs about 2^16 hashes; the server default needs about 2^24.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDwn } from '../../adapter-dwn/test/server.ts';
import { putRelay } from './relay.ts';
import { tgzOf } from './tgz.ts';

setDefaultTimeout(30_000);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-register-'));
const home = join(tmp, 'home');
// A control character: the CLI must show it, so that a server cannot hide text.
const text = 'Test terms of service.\nOnly didpkg packages. Café ✓\n\x1b[8mhidden\n';
const hash = createHash('sha256').update(text, 'utf8').digest('hex');
const tarball = join(tmp, 'hello-1.0.0.tgz');
const relay = putRelay();
let dwn: Awaited<ReturnType<typeof startDwn>>;

/** Async: a sync spawn blocks this process, and thus the relay in it. `stdin` is not a terminal. */
async function run(args: string[]) {
  const p = Bun.spawn([process.execPath, cli, ...args], {
    env: { PATH: process.env.PATH!, DIDPKG_HOME: home, DIDPKG_PASSPHRASE: 'release passphrase 1', DIDPKG_UPDATE_PASSPHRASE: 'update passphrase 2' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

/** The CLI on a pseudo-terminal (util-linux `script`), with `input` as the typed text. */
async function runOnTerminal(args: string[], input: string) {
  const p = Bun.spawn(['script', '-qec', [process.execPath, cli, ...args].map((a) => `'${a}'`).join(' '), '/dev/null'], {
    env: { PATH: process.env.PATH!, DIDPKG_HOME: home }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  await Bun.sleep(1000); // the question first, then the answer
  p.stdin.write(input);
  await p.stdin.end();
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, out };
}

beforeAll(async () => {
  writeFileSync(join(tmp, 'terms.txt'), text);
  writeFileSync(tarball, tgzOf('package/package.json', new TextEncoder().encode(JSON.stringify({ name: 'hello', version: '1.0.0' }))));
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
  rmSync(tmp, { recursive: true, force: true });
});

describe('id register', () => {
  test('id create on a DWN that needs a registration: exit 0 and the next command', async () => {
    const r = await run(['id', 'create', 'pub', '--dwn', dwn.url, '--relay', relay.url]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).dwn).toMatchObject({ url: dwn.url, ok: false });
    expect(r.err).toContain(`The DWN ${dwn.url} needs a registration. Run "didpkg id register pub"`);
  });

  test('publish before the registration fails with the next command', async () => {
    const r = await run(['publish', 'pub', tarball, '--to', 'dwn', '--relay', relay.url]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Not a registered tenant');
    expect(r.err).toContain('run "didpkg id register <alias>"');
  });

  test('with no terminal and no --accept-terms, the CLI shows the terms and the hash, and does not register', async () => {
    const r = await run(['id', 'register', 'pub']);
    expect(r).toMatchObject({ code: 1, out: '' });
    expect(r.err).toContain(`The terms of service of ${dwn.url} (SHA-256 ${hash}):\n\nTest terms of service.\nOnly didpkg packages. Café ✓\n\\x1b[8mhidden\n`);
    expect(r.err).toEndWith(`didpkg: error: no terminal to ask: read the terms, then use --accept-terms ${hash}\n`);
  });

  test('a wrong --accept-terms hash fails before the proof of work', async () => {
    const wrong = '0'.repeat(64);
    const r = await run(['id', 'register', 'pub', '--accept-terms', wrong]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`--accept-terms ${wrong} is not the hash of these terms. Read them, then use --accept-terms ${hash}`);
    expect(r.err).not.toContain('Proof of work');
  });

  const USAGE: [string, string[], string][] = [
    ['no alias', ['id', 'register'], '"id register" needs 1 argument'],
    ['not a hash', ['id', 'register', 'pub', '--accept-terms', 'abc'], '--accept-terms: use the SHA-256 hex'],
    ['2 hashes', ['id', 'register', 'pub', '--accept-terms', hash, '--accept-terms', hash], 'use --dwn and --accept-terms one time'],
    ['no identity', ['id', 'register', 'nobody', '--accept-terms', hash], 'cannot read'],
    ['no server', ['id', 'register', 'pub', '--dwn', 'http://127.0.0.1:9'], 'cannot get the terms of service of http://127.0.0.1:9: '],
  ];
  test.each(USAGE)('error: %s', async (_l, args, msg) => {
    const r = await run(args);
    expect(r.code).toBe(1);
    expect(r.err).toContain(msg);
  });

  test('with the right hash (in uppercase), the DID registers, then publish writes to the DWN', async () => {
    const r = await run(['id', 'register', 'pub', '--accept-terms', hash.toUpperCase()]);
    expect(r.code).toBe(0);
    const did = JSON.parse(await Bun.file(join(home, 'ids', 'pub.json')).text()).did;
    expect(JSON.parse(r.out)).toEqual({ alias: 'pub', did, dwn: dwn.url, termsOfServiceHash: hash });
    expect(r.err).toContain(`You accepted the terms of service of ${dwn.url} with --accept-terms ${hash}.`);
    expect(r.err).toContain(`Registered ${did} on ${dwn.url}.`);
    const p = await run(['publish', 'pub', tarball, '--to', 'dwn', '--relay', relay.url]);
    expect(p.err).toBe('');
    expect(JSON.parse(p.out).targets).toEqual([{ url: dwn.url, ok: true }]);
  });

  test('a did:web identity with no DWN service needs --dwn', async () => {
    expect((await run(['id', 'create', 'web', '--web', 'example.com:pkgs'])).code).toBe(0);
    const r = await run(['id', 'register', 'web', '--accept-terms', hash]);
    expect(r.err).toContain('the identity has no DecentralizedWebNode service: use --dwn <url>');
    const ok = await run(['id', 'register', 'web', '--dwn', dwn.url, '--accept-terms', hash]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ alias: 'web', did: 'did:web:example.com:pkgs', dwn: dwn.url });
  });

  // Linux only: the `script` of macOS has other options.
  test.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/script'))('on a terminal, "n" stops and "y" registers', async () => {
    expect((await run(['id', 'create', 'tty', '--web', 'example.com:tty', '--dwn', dwn.url])).code).toBe(0);
    const no = await runOnTerminal(['id', 'register', 'tty'], 'n\r');
    expect(no.out).toContain('Do you accept these terms? [y/N]');
    expect(no.out).toContain('you did not accept the terms');
    expect(no.code).toBe(1);
    const yes = await runOnTerminal(['id', 'register', 'tty'], 'y\r');
    expect(yes.out).toContain('Registered did:web:example.com:tty on');
    expect(yes.code).toBe(0);
  });
});
