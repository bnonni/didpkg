// The deploy stack test (chunk C13). It starts deploy/compose.yaml with two local changes: a demo CA in place of
// Let's Encrypt, and a did:dht relay container in place of relay.pkarr.org. Then it proves, through Traefik:
// the route allowlist (check.sh), the tenant allowlist (tenant.sh), a write and a read with the didpkg DWN adapter,
// the body limit, backup.sh and restore.sh, the quota for each tenant, no ACME account, and the limit for each client IP.
// Needs Docker with Compose 2.24 or later, openssl and curl. Run: bun deploy/test/stack.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCerts } from '../../demo/tls.ts';
import { dhtFixture } from '../../packages/core/test/did/helpers.ts';
import { DwnWriter, ed25519MessageSigner } from '../../packages/adapter-dwn/src/writer.ts';
import { dwnAdapter } from '../../packages/adapter-dwn/src/index.ts';
import type { StorageReader, StoredFile } from '../../packages/core/src/source/index.ts';

const DEPLOY = join(import.meta.dir, '..');
const BUN_IMAGE = 'oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4';
// GET /<z32 id> gives the file of that id. The dwn-server resolves the publisher DID through it.
const RELAY = `Bun.serve({ port: 8080, async fetch(req) {
  const f = Bun.file('/relay/' + new URL(req.url).pathname.slice(1).replace(/[^a-z0-9]/g, ''));
  return (await f.exists()) ? new Response(f, { headers: { 'content-type': 'application/pkarr.org/relays#payload' } }) : new Response('not found', { status: 404 });
} });`;

// The CA must be in NODE_EXTRA_CA_CERTS when Bun starts, so the test makes the CA and runs itself again.
if (!process.env.DIDPKG_STACK_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'didpkg-stack-'));
  try {
    const { ca } = await makeCerts(dir, 'localhost');
    const p = Bun.spawn(['bun', import.meta.path], { env: { ...process.env, DIDPKG_STACK_DIR: dir, NODE_EXTRA_CA_CERTS: ca }, stdio: ['ignore', 'inherit', 'inherit'] });
    process.exitCode = await p.exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  await stack(process.env.DIDPKG_STACK_DIR);
}

function freePort(): number {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

function random(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
  return bytes;
}

function check(cond: boolean, what: string): void {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok   ${what}`);
}

async function all(reader: StorageReader, file: StoredFile): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  for await (const bytes of reader.read(file, { signal: AbortSignal.timeout(10_000), maxBytes: 8 * 1024 * 1024 })) out.push(bytes);
  return Buffer.concat(out);
}

async function stack(dir: string): Promise<void> {
  const t0 = performance.now();
  const port = freePort();
  const base = `https://localhost:${port}`;
  const env = {
    ...process.env,
    COMPOSE_FILE: `${join(DEPLOY, 'compose.yaml')}:${join(dir, 'override.yaml')}`,
    COMPOSE_PROJECT_NAME: 'didpkg-dwn-test',
    DWN_DOMAIN: 'localhost',
    ACME_EMAIL: 'stack-test@example.invalid',
    DWN_ADMIN_TOKEN: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
    BACKUP_DIR: join(dir, 'backups'),
    CURL_CA_BUNDLE: join(dir, 'ca.pem'),
  };
  const run = async (cmd: string[]): Promise<string> => {
    const p = Bun.spawn(cmd, { cwd: DEPLOY, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`${cmd.join(' ')} (exit ${code}): ${(out + err).trim().split('\n').slice(-6).join(' | ')}`);
    return out;
  };
  const healthy = async () => {
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) return;
      await Bun.sleep(500);
    }
    throw new Error('the DWN did not come back');
  };

  // The production dynamic.yml, with the default certificate of the test in place of the ACME resolver.
  const prod = readFileSync(join(DEPLOY, 'traefik', 'dynamic.yml'), 'utf8');
  const resolver = '      tls:\n        certResolver: le\n';
  if (prod.split(resolver).length !== 2) throw new Error('traefik/dynamic.yml: the tls block changed; update stack.ts');
  writeFileSync(join(dir, 'dynamic.yml'), `${prod.replace(resolver, '      tls: {}\n')}
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /test/site.pem
        keyFile: /test/site.key
`);
  mkdirSync(join(dir, 'relay'));
  writeFileSync(join(dir, 'override.yaml'), `services:
  dwn:
    environment:
      DID_DHT_GATEWAY_URI: http://relay:8080
      DID_DHT_ALLOW_PRIVATE_GATEWAY: "1"
  relay:
    image: ${BUN_IMAGE}
    entrypoint: ["bun", "-e", ${JSON.stringify(RELAY)}]
    volumes: ["${join(dir, 'relay')}:/relay:ro"]
  traefik:
    ports: !override
      - "127.0.0.1:${port}:443"
    volumes: !override
      - "${join(dir, 'dynamic.yml')}:/etc/traefik/dynamic.yml:ro"
      - "${dir}:/test:ro"
      - acme:/acme
`);

  try {
    await run(['docker', 'compose', 'up', '-d', '--build', '--wait', '--wait-timeout', '180']);
    console.log(`ok   compose up (${Math.round(performance.now() - t0)} ms)`);
    await run(['./check.sh', base]);
    check(true, 'check.sh: /health and /info pass, the admin, metrics, registration and connect routes give 404');

    const fx = await dhtFixture();
    writeFileSync(join(dir, 'relay', fx.id), await fx.payload());
    const keyId = `${fx.did}#didpkg-1`;
    const vm = fx.document.verificationMethod!.find((v) => v.id === keyId)!;
    const { privateKeys } = await fx.bearer.export();
    const seed = new Uint8Array(Buffer.from(privateKeys!.find((k) => k.x === vm.publicKeyJwk!.x)!.d!, 'base64url'));
    const writer = new DwnWriter({ dwnUrl: base, did: fx.did, signer: ed25519MessageSigner(seed, keyId) });

    const denied = await writer.installProtocol().then(() => 'accepted', (e: Error) => e.message);
    check(denied.includes('DWN 401'), `a DID that is not on the allowlist cannot write (${denied.slice(0, 60)})`);
    await run(['./tenant.sh', fx.did]);
    await writer.installProtocol();
    // More than 30 KB, so the write and the read use the binary body of the DWN.
    const tarball = random(2 * 1024 * 1024);
    const files = {
      release: new TextEncoder().encode('{"stack":"release 1.0.0"}'),
      tarball,
      index: new TextEncoder().encode('{"stack":"index"}'),
    };
    await writer.publish({ name: 'hello', version: '1.0.0', ...files });
    check(true, 'after tenant.sh, the DID writes the protocol and a 2 MiB release through Traefik');

    // A new reader each time: a reader keeps the contextIds and the index for some time.
    const reader = () => dwnAdapter({ allowLoopback: true }).reader({ did: fx.did, serviceId: `${fx.did}#dwn`, type: 'DecentralizedWebNode', url: base }, { fetch });
    const readAll = async (r = reader()) => [
      await all(r, { kind: 'index', name: 'hello' }),
      await all(r, { kind: 'release', name: 'hello', version: '1.0.0' }),
      await all(r, { kind: 'tarball', name: 'hello', version: '1.0.0' }),
    ];
    const same = (got: Uint8Array[]) => [files.index, files.release, files.tarball].every((want, i) => Buffer.compare(want, got[i]!) === 0);
    check(same(await readAll()), 'the reader gets the same index, release and tarball bytes through Traefik');

    const big = await fetch(`${base}/`, { method: 'POST', body: new Uint8Array(18 * 1024 * 1024) });
    check(big.status === 413, `Traefik refuses an 18 MiB body (${big.status})`);

    const file = (await run(['./backup.sh'])).trim().split('\n').pop()!;
    check(file.startsWith(env.BACKUP_DIR) && Bun.file(file).size > 0, 'backup.sh writes a backup file');
    await healthy();
    const release102 = () => all(reader(), { kind: 'release', name: 'hello', version: '1.0.2' });
    await writer.publish({ name: 'hello', version: '1.0.2', ...files, release: new TextEncoder().encode('{"stack":"release 1.0.2"}') });
    check((await release102()).length > 0, 'after the backup, the DID writes 1.0.2');
    await run(['./restore.sh', file]);
    await healthy();
    check(same(await readAll()) && (await release102()).length === 0, 'after restore.sh, the reader gets the bytes of the backup, and 1.0.2 is gone');
    await writer.publish({ name: 'hello', version: '1.0.1', ...files });
    check(true, 'after restore.sh, the allowlist is back: the DID writes 1.0.1');

    // The admin API is not on the internet, so the test calls it from the dwn container, as tenant.sh does.
    type QuotaStatus = { quota: { maxMessages: number; maxStorageBytes: number; source: string }; usage: { storageBytes: number } };
    const quota = async (): Promise<QuotaStatus> => JSON.parse(await run(['docker', 'compose', 'exec', '-T', '-e', `TENANT_DID=${fx.did}`, 'dwn', 'bun', '-e',
      'const r = await fetch(`http://127.0.0.1:3000/admin/api/tenants/${process.env.TENANT_DID}/quota`, { headers: { authorization: `Bearer ${process.env.DWN_ADMIN_TOKEN}` } }); console.log(await r.text()); process.exit(r.ok ? 0 : 1);']));
    const { quota: max } = await quota();
    check(max.maxStorageBytes === 50 * 1024 * 1024 && max.maxMessages === 10_000 && max.source === 'global', 'the default quota of compose.yaml: 50 MiB and 10,000 messages for each tenant');
    // Tarballs of 15 MiB fill the quota. The first write over the quota must fail.
    const chunk = random(15 * 1024 * 1024);
    let written = 0;
    let refused = '';
    while (!refused && written < 5) {
      refused = await writer.publish({ name: 'big', version: `1.0.${written}`, ...files, tarball: chunk }).then(() => (written++, ''), (e: Error) => e.message);
    }
    const used = (await quota()).usage.storageBytes;
    check(refused.includes('TenantStorageQuotaExceeded') && used <= max.maxStorageBytes && used + chunk.length > max.maxStorageBytes,
      `after ${written} tarballs of 15 MiB (${used} bytes in use), a write over the quota fails (${refused.slice(0, 90)})`);

    const acme = await run(['docker', 'compose', 'exec', '-T', 'traefik', 'sh', '-c', 'cat /acme/acme.json 2>/dev/null || true']);
    check(!acme.includes('Registration'), 'no Let\'s Encrypt account was made');

    await Bun.sleep(3000);
    const codes = await Promise.all(Array.from({ length: 100 }, () => fetch(`${base}/health`).then((r) => r.status)));
    const limited = codes.filter((c) => c === 429).length;
    check(limited > 0 && codes.filter((c) => c === 200).length >= 50, `the limit for each IP: ${limited} of 100 parallel requests get 429`);
    console.log(`PASS (${Math.round(performance.now() - t0)} ms)`);
  } catch (e) {
    console.error((await run(['docker', 'compose', 'logs', '--tail', '20']).catch(() => '')).trim());
    throw e;
  } finally {
    await run(['docker', 'compose', 'down', '-v', '--remove-orphans']).catch((e: Error) => console.error(e.message));
  }
}
