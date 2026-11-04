// Runs src/cli.ts on Bun. Tests from didpkg@0.0.1 (test/cli.test.ts). The CI job `package` runs the Node bundle (build.ts).
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

// [label, DID or XID, expected install name for pkg-name "hello"]
const NAMES: [string, string, string][] = [
  ['dht', 'did:dht:i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y', '@didpkg/hello_did_dht_i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y'],
  ['web', 'did:web:nonni.org', '@didpkg/hello_did_web_nonni.org'],
  ['web with path', 'did:web:w3c-ccg.github.io:user:alice', '@didpkg/hello_did_web_w3c-ccg.github.io_user_alice'],
  ['web with port', 'did:web:example.com%3A3000:user:alice', '@didpkg/hello_did_web.aam_example.com.3a3000_user_alice'],
  ['web with uppercase and "_"', 'did:web:example.com:Users:Alice_Smith', '@didpkg/hello_did_web.aaiim_example.com_users_alice-smith'],
  ['key', 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', '@didpkg/hello_did_key.ixcqfxbqq_z6mkhaxgbzdvotdkl5257faiztigic2qtklgpbnnegta2dok'],
  ['plc', 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', '@didpkg/hello_did_plc_ewvi7nxzyoun6zhxrhs64oiz'],
  ['btcr2', 'did:btcr2:k1q5pxw76fzmq5fttej05clqr2wlg97zrj7897783pngqwa4kvunm538sev7lgu', '@didpkg/hello_did_btcr2_k1q5pxw76fzmq5fttej05clqr2wlg97zrj7897783pngqwa4kvunm538sev7lgu'],
  ['jwk (hash form)', 'did:jwk:eyJjcnYiOiJQLTI1NiIsImt0eSI6IkVDIiwieCI6ImFjYklRaXVNczNpOF91c3pFakoydHBUdFJNNEVVM3l6OTFQSDZDZEgyVjAiLCJ5IjoiX0tjeUxqOXZXTXB0bm1LdG00NkdxRHo4d2Y3NEk1TEtncmwyR3pIM25TRSJ9', '@didpkg/hello__goobl6n3s26agxgbm2aolmhsowtroyffgmfnuas56cvxkyz7iasq'],
  ['xid', '71274df133169a0e2d2ffb11cbc7917732acafa31989f685cca6cb69d473b93c', '@didpkg/hello_xid_71274df133169a0e2d2ffb11cbc7917732acafa31989f685cca6cb69d473b93c'],
];

// BCR-2024-010: a ur:xid holds a bare XID or a XID document. Both give the XID of the NAMES row "xid".
const UR_XIDS: [string, string][] = [
  ['bare XID', 'ur:xid/hdcxjsdigtwneocmnybadpdlzobysbstmekteypspeotcfldynlpsfolsbintyjkrhfnvsbyrdfw'],
  ['XID document', 'ur:xid/tpsplstpsotanshdhdcxjsdigtwneocmnybadpdlzobysbstmekteypspeotcfldynlpsfolsbintyjkrhfnoyastpsotpcxksceisjyjyjojkftdldljpihjkjljzkoihjpdmihkshsjnjojzihdmiajljnoyastpsotpcxjnidjyiajpftdyeheyeoeeecenemmtcwrogm'],
  ['uppercase', 'UR:XID/HDCXJSDIGTWNEOCMNYBADPDLZOBYSBSTMEKTEYPSPEOTCFLDYNLPSFOLSBINTYJKRHFNVSBYRDFW'],
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
  ['parse: 2 arguments', ['parse', '@didpkg/hello_did_web_nonni.org', 'x'], '"parse" needs 1 argument'],
  ['parse: other scope', ['parse', '@other/hello_did_web_nonni.org'], 'E_SCOPE'],
  ['parse: zero mask', ['parse', '@didpkg/hello_did_web.a_nonni.org'], 'E_MASK'],
  ['parse: no kind (draft 1 name)', ['parse', '@didpkg/hello_web_nonni.org'], 'E_KIND'],
  ['parse: uppercase XID', ['parse', '@didpkg/hello_xid_71274DF133169A0E2D2FFB11CBC7917732ACAFA31989F685CCA6CB69D473B93C'], 'E_XID'],
  ['name: uppercase XID', ['name', '71274DF133169A0E2D2FFB11CBC7917732ACAFA31989F685CCA6CB69D473B93C', 'hello'], 'E_XID'],
  ['name: ur:xid with a bad checksum', ['name', 'ur:xid/hdcxjsdigtwneocmnybadpdlzobysbstmekteypspeotcfldynlpsfolsbintyjkrhfnvsbyrdaa', 'hello'], 'XID_INVALID'],
  ['name: ur of another type', ['name', 'ur:seed/hdcxjsdigtwneocmnybadpdlzobysbstmekteypspeotcfldynlpsfolsbintyjkrhfnvsbyrdfw', 'hello'], 'E_DID'],
  ['parse: legacy tilde', ['parse', '@didpkg/hello~web~nonni.org'], 'E_SHAPE'],
  ['parse: short hash', ['parse', '@didpkg/hello__abc'], 'E_HASH'],
  ['drl: no argument', ['drl'], '"drl" needs 1 argument'],
  ['drl: unknown option', ['drl', '@didpkg/hello_did_web_nonni.org', '--port', '2092'], 'unknown option --port'],
  ['drl: other scope', ['drl', '@other/hello_did_web_nonni.org@1.0.0'], 'E_SCOPE'],
  ['drl: http XID resolver', ['drl', '@didpkg/hello_xid_71274df133169a0e2d2ffb11cbc7917732acafa31989f685cca6cb69d473b93c@1.0.0', '--xid-resolver', 'http://example.com/'], '--xid-resolver: http://example.com/ must use https'],
];

describe('CLI on bun', () => {
  test.each(NAMES)('name: %s', (_l, did, want) => {
    const r = run(['name', did, 'hello']);
    expect(r).toEqual({ code: 0, out: `${want}\n`, err: '' });
  });

  test.each(UR_XIDS)('name: ur:xid, %s', (_l, ur) => {
    const r = run(['name', ur, 'hello']);
    expect(r).toEqual({ code: 0, out: `${NAMES.find(([l]) => l === 'xid')![2]}\n`, err: '' });
  });

  test.each(NAMES)('parse: %s', (_l, id, name) => {
    const r = run(['parse', name]);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const json = JSON.parse(r.out);
    if (name.includes('__')) expect(json).toEqual({ kind: 'did', form: 'hash', name: 'hello', hash: name.slice(name.indexOf('__') + 2) });
    else if (name.includes('_xid_')) expect(json).toEqual({ kind: 'xid', form: 'direct', name: 'hello', xid: id });
    else expect(json).toEqual({ kind: 'did', form: 'direct', name: 'hello', did: id });
  });

  const HELP_ARGS: [string, string[]][] = [['--help'], ['-h'], ['help'], ['name', '--help'], ['parse', '-h']].map((a) => [a.join(' '), a]);
  test.each(HELP_ARGS)('help: %s', (_l, args) => {
    const r = run(args);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain('Usage:');
    expect(r.out).toContain('didpkg name <did|xid> <pkg-name>');
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
  expect(r.stdout.toString()).toBe('@didpkg/hello_did_web_nonni.org\n');
});
