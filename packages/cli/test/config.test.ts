// The config file `$DIDPKG_HOME/config.json`, and the `--cas`, `--sidecar` and `--dwn` options of `didpkg shim start`.
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sidecarFile } from '@didpkg/core/did/btcr2';
import { format } from '@didpkg/core/name';
import { btcr2Fixture } from '../../core/test/did/helpers.ts';
import { configFile, readConfig } from '../src/config.ts';

setDefaultTimeout(30_000);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-config-'));
let n = 0;
let home: string;
const env = () => ({ DIDPKG_HOME: home });
const write = (v: unknown) => writeFileSync(configFile(env()), typeof v === 'string' ? v : JSON.stringify(v));

beforeEach(() => {
  home = join(tmp, `home-${n++}`);
  mkdirSync(home);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('readConfig', () => {
  test('no file gives an empty config', () => {
    expect(readConfig(env())).toEqual({});
  });

  test('the file is in $DIDPKG_HOME, else in $XDG_CONFIG_HOME/didpkg', () => {
    expect(configFile({ DIDPKG_HOME: '/h' })).toBe('/h/config.json');
    expect(configFile({ XDG_CONFIG_HOME: '/x' })).toBe('/x/didpkg/config.json');
  });

  test('cas, dwn, esplora and sidecar', () => {
    const config = {
      cas: ['https://ipfs.didpkg.dev', 'http://127.0.0.1:8080'], dwn: ['https://dwn.didpkg.dev', 'http://localhost:3000'], esplora: { testnet4: 'https://esplora.example.com/testnet4/api', regtest: 'http://localhost:3000' },
      sidecar: ['https://pkgs.example.com/btcr2/', 'http://127.0.0.1:8081'],
    };
    write(config);
    expect(readConfig(env())).toEqual(config);
  });

  test('an empty cas list stays empty: it turns CAS off', () => {
    write({ cas: [] });
    expect(readConfig(env())).toEqual({ cas: [] });
  });

  const BAD: [string, unknown, string][] = [
    ['not JSON', '{"cas": [', 'not JSON'],
    ['not an object', '["https://ipfs.didpkg.dev"]', 'the file must be a JSON object'],
    ['unknown key', { gateways: [] }, 'unknown key "gateways"'],
    ['cas is a string', { cas: 'https://ipfs.didpkg.dev' }, '"cas" must be a list of URLs'],
    ['cas is not a URL', { cas: ['ipfs.didpkg.dev'] }, 'is not a URL'],
    ['cas with http', { cas: ['http://ipfs.didpkg.dev'] }, 'must use https'],
    ['esplora is a list', { esplora: ['https://mempool.space/api'] }, '"esplora" must be an object'],
    ['unknown network', { esplora: { mainnet: 'https://mempool.space/api' } }, '"mainnet" is not a network'],
    ['esplora URL is a number', { esplora: { bitcoin: 1 } }, 'the value of bitcoin must be a URL'],
    ['esplora with http', { esplora: { bitcoin: 'http://mempool.space/api' } }, 'must use https'],
    ['sidecar is a string', { sidecar: 'https://pkgs.example.com/' }, '"sidecar" must be a list of URLs'],
    ['sidecar with http', { sidecar: ['http://pkgs.example.com/'] }, 'must use https'],
    ['dwn is a string', { dwn: 'https://dwn.didpkg.dev' }, '"dwn" must be a list of URLs'],
    ['dwn with http', { dwn: ['http://dwn.didpkg.dev'] }, 'must use https'],
  ];
  test.each(BAD)('error: %s', (_l, v, msg) => {
    write(v);
    expect(() => readConfig(env())).toThrow(msg);
    expect(() => readConfig(env())).toThrow(configFile(env()));
  });
});

const f = await btcr2Fixture();
/** A fake gateway and Esplora API. It keeps the path of each request and sends 404. */
const paths: string[] = [];
const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => (paths.push(new URL(req.url).pathname), new Response(null, { status: 404 })) });
const base = `http://127.0.0.1:${fake.port}`;
afterAll(() => fake.stop(true));

describe('didpkg shim start', () => {
  /** Async: a sync spawn blocks this process, and thus the fake server in it. */
  async function shim(args: string[], requests: string[]) {
    const p = Bun.spawn([process.execPath, cli, 'shim', 'start', '--port', '0', '--allow-loopback', ...args], {
      env: { PATH: process.env.PATH!, HOME: home, DIDPKG_HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const first = await p.stdout.getReader().read();
      const { url } = JSON.parse(new TextDecoder().decode(first.value)) as { url: string };
      for (const did of requests) await (await fetch(`${url}/${format(did, 'hello')}`)).arrayBuffer();
    } finally {
      p.kill('SIGTERM');
      await p.exited;
    }
  }

  beforeEach(() => {
    paths.length = 0;
    write({ cas: [`${base}/file`], dwn: [`${base}/dwn`], esplora: { testnet4: `${base}/esplora` }, sidecar: [`${base}/mirror`] });
  });

  test('the config file gives the gateway and the Esplora API to the did:btcr2 driver', async () => {
    await shim([], [f.did, f.k1]);
    expect(paths.some((p) => p.startsWith('/file/ipfs/bafkrei'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/esplora/'))).toBe(true);
  });

  test('--cas replaces the cas list of the config file, in order', async () => {
    await shim(['--cas', `${base}/flag-1`, '--cas', `${base}/flag-2`], [f.did]);
    const cas = paths.filter((p) => p.includes('/ipfs/')).map((p) => p.slice(0, p.indexOf('/ipfs/')));
    expect(cas).toEqual(['/flag-1', '/flag-2']);
  });

  test('the config file gives the Sidecar Data mirrors; --sidecar replaces the list, in order', async () => {
    const mirrors = () => paths.filter((p) => p.endsWith('.sidecar.json'));
    await shim([], [f.did]);
    expect(mirrors()).toEqual([`/mirror/${sidecarFile(f.did)}`]);
    paths.length = 0;
    await shim(['--sidecar', `${base}/flag-1/`, '--sidecar', `${base}/flag-2`], [f.did]);
    expect(mirrors()).toEqual([`/flag-1/${sidecarFile(f.did)}`, `/flag-2/${sidecarFile(f.did)}`]);
  });

  test('the config file gives the DWN list for a did:key publisher; --dwn replaces the list, in order', async () => {
    const did = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    const dwns = () => [...new Set(paths.filter((p) => p.includes(`/${did}/`)).map((p) => p.slice(0, p.indexOf(`/${did}/`))))];
    await shim([], [did]);
    expect(dwns()).toEqual(['/dwn']);
    paths.length = 0;
    await shim(['--dwn', `${base}/flag-1`, '--dwn', `${base}/flag-2`], [did]);
    expect(dwns()).toEqual(['/flag-1', '/flag-2']);
  });

  test('a bad config file stops the shim before it starts', () => {
    write({ gateways: [] });
    const r = Bun.spawnSync([process.execPath, cli, 'shim', 'start', '--port', '0'], { env: { PATH: process.env.PATH!, HOME: home, DIDPKG_HOME: home }, timeout: 10_000 });
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toBe('');
    expect(r.stderr.toString()).toStartWith(`didpkg: error: ${configFile(env())}: unknown key "gateways"`);
  });

  test.each(['--cas', '--sidecar', '--dwn'])('%s must use https', (flag) => {
    const r = Bun.spawnSync([process.execPath, cli, 'shim', 'start', '--port', '0', flag, 'http://ipfs.didpkg.dev'], { env: { PATH: process.env.PATH!, HOME: home, DIDPKG_HOME: home }, timeout: 10_000 });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`${flag}: http://ipfs.didpkg.dev must use https`);
  });
});
