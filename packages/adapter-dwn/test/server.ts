// Test helpers: a fake Pkarr relay, the pinned @enbox/dwn-server 0.1.45 as a child process on 127.0.0.1,
// and a publisher with both.
// A crash must not leave a dwn-server child on the port: the exit handler kills each child.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dhtFixture } from '../../core/test/did/helpers.ts';
import { DwnWriter, ed25519MessageSigner } from '../src/writer.ts';

/** GET /<z32 id> gives the stored did:dht payload. The dwn-server resolves the publisher DID through it. */
export function startRelay(payloads: Map<string, Uint8Array>) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const v = payloads.get(new URL(req.url).pathname.slice(1));
      return v ? new Response(v, { headers: { 'content-type': 'application/pkarr.org/relays#payload' } }) : new Response('not found', { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const children = new Set<ReturnType<typeof Bun.spawn>>();
process.on('exit', () => { for (const c of children) c.kill('SIGKILL'); });

function freePort(): number {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

/** Starts the dwn-server in open mode (no tenant allowlist) with a new LevelDB folder. The rate limits are off.
 * `env` adds variables, for example a proxy and a CA for did:web. `dir` is the working folder of the server. */
export async function startDwn(o: { relayUrl: string; env?: Record<string, string> }) {
  const pkgJson = fileURLToPath(import.meta.resolve('@enbox/dwn-server/package.json'));
  const main = join(pkgJson, '..', 'dist', 'esm', 'src', 'main.js');
  const dir = mkdtempSync(join(tmpdir(), 'didpkg-dwn-'));
  const port = freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH!, HOME: dir, DS_PORT: String(port), DS_HOST: '127.0.0.1', DWN_BASE_URL: url,
    DID_DHT_GATEWAY_URI: o.relayUrl, DID_DHT_ALLOW_PRIVATE_GATEWAY: '1', DWN_SERVER_PACKAGE_JSON: pkgJson, DWN_SERVER_LOG_LEVEL: 'warn',
    DWN_RATE_LIMIT_REQUESTS_PER_SECOND: '0', DWN_RATE_LIMIT_TENANT_REQUESTS_PER_SECOND: '0', ...o.env,
  };
  const errLog = join(dir, 'err.log');
  const proc = Bun.spawn(['bun', main], { cwd: dir, env, stdout: 'ignore', stderr: Bun.file(errLog) });
  children.add(proc);
  const stop = async () => {
    proc.kill('SIGTERM');
    await proc.exited;
    children.delete(proc);
    rmSync(dir, { recursive: true, force: true });
  };
  const t0 = performance.now();
  for (;;) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* not up yet */ }
    if (proc.exitCode !== null || performance.now() - t0 > 30_000) {
      const tail = readFileSync(errLog, 'utf8').trim().split('\n').slice(-4).join(' | ');
      await stop();
      throw new Error(`dwn-server did not start: ${tail}`);
    }
    await Bun.sleep(100);
  }
  return { url, pid: proc.pid, dir, stop };
}

/** A new did:dht publisher per run, with the release key #didpkg-1, its relay and a dwn-server with the protocol.
 * With `env`, the server gets more variables and the publisher does not install the protocol. */
export async function startPublisher(env?: Record<string, string>) {
  const fx = await dhtFixture();
  const keyId = `${fx.did}#didpkg-1`;
  const vm = fx.document.verificationMethod!.find((v) => v.id === keyId)!;
  const { privateKeys } = await fx.bearer.export();
  const seed = new Uint8Array(Buffer.from(privateKeys!.find((k) => k.x === vm.publicKeyJwk!.x)!.d!, 'base64url'));
  const signer = ed25519MessageSigner(seed, keyId);
  const relay = startRelay(new Map([[fx.id, await fx.payload()]]));
  const dwn = await startDwn({ relayUrl: relay.url, env });
  const writer = new DwnWriter({ dwnUrl: dwn.url, did: fx.did, signer });
  if (!env) await writer.installProtocol();
  const stop = async () => {
    await dwn.stop();
    relay.stop();
  };
  return { fx, keyId, signer, dwn, writer, stop };
}
