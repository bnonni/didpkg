// Runs src/cli.ts on Bun. Tests from didpkg@0.0.1 (test/cli.test.ts); the Node runs are gone, because the CLI needs Bun.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const pkg: { version: string } = await Bun.file(new URL('../package.json', import.meta.url)).json();

function run(args: string[]) {
  const r = Bun.spawnSync([process.execPath, cli, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// [label, did, expected install name for pkg-name "hello"]
const NAMES: [string, string, string][] = [
  ['dht', 'did:dht:i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y', '@didpkg/hello_dht_i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y'],
  ['web', 'did:web:nonni.org', '@didpkg/hello_web_nonni.org'],
  ['web with path', 'did:web:w3c-ccg.github.io:user:alice', '@didpkg/hello_web_w3c-ccg.github.io_user_alice'],
  ['web with port', 'did:web:example.com%3A3000:user:alice', '@didpkg/hello_web.aam_example.com.3a3000_user_alice'],
  ['web with uppercase and "_"', 'did:web:example.com:Users:Alice_Smith', '@didpkg/hello_web.aaiim_example.com_users_alice-smith'],
  ['key', 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', '@didpkg/hello_key.ixcqfxbqq_z6mkhaxgbzdvotdkl5257faiztigic2qtklgpbnnegta2dok'],
  ['plc', 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', '@didpkg/hello_plc_ewvi7nxzyoun6zhxrhs64oiz'],
  ['btcr2', 'did:btcr2:k1q5pxw76fzmq5fttej05clqr2wlg97zrj7897783pngqwa4kvunm538sev7lgu', '@didpkg/hello_btcr2_k1q5pxw76fzmq5fttej05clqr2wlg97zrj7897783pngqwa4kvunm538sev7lgu'],
  ['jwk (hash form)', 'did:jwk:eyJjcnYiOiJQLTI1NiIsImt0eSI6IkVDIiwieCI6ImFjYklRaXVNczNpOF91c3pFakoydHBUdFJNNEVVM3l6OTFQSDZDZEgyVjAiLCJ5IjoiX0tjeUxqOXZXTXB0bm1LdG00NkdxRHo4d2Y3NEk1TEtncmwyR3pIM25TRSJ9', '@didpkg/hello__goobl6n3s26agxgbm2aolmhsowtroyffgmfnuas56cvxkyz7iasq'],
];

// [label, args, text that stderr must contain]
const ERRORS: [string, string[], string][] = [
  ['no arguments', [], 'no command'],
  ['unknown command', ['install', 'x'], 'unknown command "install"'],
  ['unknown flag', ['--bogus'], 'unknown command "--bogus"'],
  ['name: 1 argument', ['name', 'did:web:nonni.org'], '"name" needs 2 arguments'],
  ['name: 3 arguments', ['name', 'did:web:nonni.org', 'hello', 'extra'], '"name" needs 2 arguments'],
  ['name: not a DID', ['name', 'web:nonni.org', 'hello'], 'E_DID'],
  ['name: bad DID character', ['name', 'did:web:nonni.org/x', 'hello'], 'E_DID'],
  ['name: uppercase pkg-name', ['name', 'did:web:nonni.org', 'Hello'], 'E_NAME'],
  ['name: "_" in pkg-name', ['name', 'did:web:nonni.org', 'my_lib'], 'E_NAME'],
  ['parse: no argument', ['parse'], '"parse" needs 1 argument'],
  ['parse: 2 arguments', ['parse', '@didpkg/hello_web_nonni.org', 'x'], '"parse" needs 1 argument'],
  ['parse: other scope', ['parse', '@other/hello_web_nonni.org'], 'E_SCOPE'],
  ['parse: zero mask', ['parse', '@didpkg/hello_web.a_nonni.org'], 'E_MASK'],
  ['parse: legacy tilde', ['parse', '@didpkg/hello~web~nonni.org'], 'E_SHAPE'],
  ['parse: short hash', ['parse', '@didpkg/hello__abc'], 'E_HASH'],
];

describe('CLI on bun', () => {
  test.each(NAMES)('name: %s', (_l, did, want) => {
    const r = run(['name', did, 'hello']);
    expect(r).toEqual({ code: 0, out: `${want}\n`, err: '' });
  });

  test.each(NAMES)('parse: %s', (_l, did, name) => {
    const r = run(['parse', name]);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const json = JSON.parse(r.out);
    if (name.includes('__')) expect(json).toEqual({ form: 'hash', name: 'hello', hash: name.slice(name.indexOf('__') + 2) });
    else expect(json).toEqual({ form: 'direct', name: 'hello', did });
  });

  const HELP_ARGS: [string, string[]][] = [['--help'], ['-h'], ['help'], ['name', '--help'], ['parse', '-h']].map((a) => [a.join(' '), a]);
  test.each(HELP_ARGS)('help: %s', (_l, args) => {
    const r = run(args);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain('Usage:');
    expect(r.out).toContain('didpkg name <did> <pkg-name>');
    expect(r.out).toContain('didpkg parse <install-name>');
  });

  test.each(['--version', '-v', 'version'])('version: %s', (arg) => {
    expect(run([arg])).toEqual({ code: 0, out: `${pkg.version}\n`, err: '' });
  });

  test.each(ERRORS)('error exit 1: %s', (_l, args, msg) => {
    const r = run(args);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toStartWith('didpkg: error: ');
    expect(r.err).toContain(msg);
  });
});

test('src/cli.ts has the bun shebang and runs as an executable', () => {
  expect(readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env bun\n')).toBe(true);
  const r = Bun.spawnSync([cli, 'name', 'did:web:nonni.org', 'hello'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe('@didpkg/hello_web_nonni.org\n');
});
