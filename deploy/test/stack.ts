// The deploy stack test. It starts deploy/compose.yaml with three local changes:
// - a demo CA in place of Let's Encrypt;
// - a did:dht relay container in place of relay.pkarr.org;
// - a web container with the DID data of a did:webvh, a did:plc and a did:btcr2 publisher (network aliases: the DID hosts).
// Then it proves these items through Traefik:
// - the route allowlist (check.sh) and the registration (terms and proof of work);
// - a write and a read with the didpkg DWN adapter;
// - a write and a read of a did:webvh, a did:plc and a did:btcr2 publisher (deploy/dwn/resolver.ts resolves them);
// - the body limit, backup.sh and restore.sh;
// - the quota for each tenant, tenant.sh, no ACME account, and the limit for each client IP;
// - the second DWN of compose.dwn2.yaml: its routes, its own tenants and its backup.
// Needs Docker with Compose 2.24 or later, openssl and curl. Run: npm run stack
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import { makeCerts, WEB_HOST } from '../../demo/tls.ts';
import { BTCR2_ESPLORA, btcr2Fixture, dhtFixture, plcFixture, webvhFixture } from '../../packages/core/test/did/helpers.ts';
import { CAS_GATEWAYS, casCid } from '../../packages/core/src/did/drivers/btcr2.ts';
import { PLC_DIRECTORY } from '../../packages/core/src/did/drivers/plc.ts';
import { DwnWriter, ed25519MessageSigner } from '../../packages/adapter-dwn/src/writer.ts';
import { getTerms, register } from '../../packages/adapter-dwn/src/registration.ts';
import { dwnAdapter } from '../../packages/adapter-dwn/src/index.ts';
import type { StorageReader, StoredFile } from '../../packages/core/src/source/index.ts';

const DEPLOY = join(import.meta.dir, '..');
// The host of the second DWN. curl resolves each *.localhost name to the loopback address.
const DWN2_HOST = 'dwn2.localhost';
const BUN_IMAGE = 'oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4';
// GET /<z32 id> gives the file of that id. The dwn-server resolves the publisher DID through it.
const RELAY = `Bun.serve({ port: 8080, async fetch(req) {
  const f = Bun.file('/relay/' + new URL(req.url).pathname.slice(1).replace(/[^a-z0-9]/g, ''));
  return (await f.exists()) ? new Response(f, { headers: { 'content-type': 'application/pkarr.org/relays#payload' } }) : new Response('not found', { status: 404 });
} });`;
// GET /pkgs/did.jsonl over TLS gives the log of the did:webvh publisher. GET /<did:plc>/log/audit gives the audit log
// of the did:plc publisher. For the other URLs, /web/btcr2.json has the body of each <host><path><query>.
// The network aliases of the container are WEB_HOST, PLC_HOST and BTCR2_HOSTS.
const WEB = `Bun.serve({ port: 443, tls: { cert: Bun.file('/web/site.pem'), key: Bun.file('/web/site.key') }, async fetch(req) {
  const url = new URL(req.url);
  const path = url.pathname;
  const file = path === '/pkgs/did.jsonl' ? 'did.jsonl' : path.startsWith('/did:plc:') && path.endsWith('/log/audit') ? 'plc.json' : '';
  if (file) return new Response(Bun.file('/web/' + file));
  const body = (await Bun.file('/web/btcr2.json').json().catch(() => ({})))[url.host + path + url.search];
  return typeof body === 'string' ? new Response(body) : new Response('not found', { status: 404 });
} });`;
const PLC_HOST = new URL(PLC_DIRECTORY).host;
// The did:btcr2 driver of the DWN reads the default Esplora of testnet4 and the default CAS gateways.
const BTCR2_HOSTS = [BTCR2_ESPLORA, ...CAS_GATEWAYS].map((u) => new URL(u).host);

// The CA must be in NODE_EXTRA_CA_CERTS when Bun starts, so the test makes the CA and runs itself again.
if (!process.env.DIDPKG_STACK_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'didpkg-stack-'));
  try {
    const { ca } = await makeCerts(dir, ['localhost', DWN2_HOST]);
    const p = Bun.spawn([process.execPath, import.meta.path], { env: { ...process.env, DIDPKG_STACK_DIR: dir, NODE_EXTRA_CA_CERTS: ca }, stdio: ['ignore', 'inherit', 'inherit'] });
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
  const base2 = `https://${DWN2_HOST}:${port}`;
  const env = {
    ...process.env,
    COMPOSE_FILE: ['compose.yaml', 'compose.dwn2.yaml'].map((f) => join(DEPLOY, f)).concat(join(dir, 'override.yaml')).join(':'),
    COMPOSE_PROJECT_NAME: 'didpkg-dwn-test',
    DWN_DOMAIN: 'localhost',
    ACME_EMAIL: 'stack-test@example.invalid',
    DWN_ADMIN_TOKEN: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
    DWN2_DOMAIN: DWN2_HOST,
    DWN2_ADMIN_TOKEN: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
    BACKUP_DIR: join(dir, 'backups'),
    CURL_CA_BUNDLE: join(dir, 'ca.pem'),
  };
  const run = async (cmd: string[], extra: Record<string, string> = {}): Promise<string> => {
    const p = Bun.spawn(cmd, { cwd: DEPLOY, env: { ...env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
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
  // The web container has its own demo CA. Only the dwn container trusts it.
  const web = join(dir, 'web');
  mkdirSync(web);
  await makeCerts(web, [WEB_HOST, PLC_HOST, ...BTCR2_HOSTS]);
  writeFileSync(join(dir, 'override.yaml'), `services:
  dwn:
    environment:
      DID_DHT_GATEWAY_URI: http://relay:8080
      DID_DHT_ALLOW_PRIVATE_GATEWAY: "1"
      # About 2^16 hashes for each registration, not 2^24: the test stays fast.
      DWN_REGISTRATION_PROOF_OF_WORK_INITIAL_MAX_HASH: 0000${'F'.repeat(60)}
      NODE_EXTRA_CA_CERTS: /web/ca.pem
    volumes:
      - "${web}:/web:ro"
  web:
    image: ${BUN_IMAGE}
    entrypoint: ["bun", "-e", ${JSON.stringify(WEB)}]
    volumes: ["${web}:/web:ro"]
    networks:
      default:
        aliases: [${[WEB_HOST, PLC_HOST, ...BTCR2_HOSTS].join(', ')}]
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
    check(true, 'check.sh: /health, /info and the registration routes pass; the admin, metrics and connect routes give 404');
    await run(['./check.sh', base2]);
    const info2 = JSON.parse(await run(['curl', '-sf', `${base2}/info`])) as { url: string };
    check(info2.url === `https://${DWN2_HOST}`, `the second DWN: check.sh passes on its host, and /info comes from dwn2 (${info2.url})`);

    const fx = await dhtFixture();
    writeFileSync(join(dir, 'relay', fx.id), await fx.payload());
    const keyId = `${fx.did}#didpkg-1`;
    const vm = fx.document.verificationMethod!.find((v) => v.id === keyId)!;
    const { privateKeys } = await fx.bearer.export();
    const seed = new Uint8Array(Buffer.from(privateKeys!.find((k) => k.x === vm.publicKeyJwk!.x)!.d!, 'base64url'));
    const writer = new DwnWriter({ dwnUrl: base, did: fx.did, signer: ed25519MessageSigner(seed, keyId) });

    const denied = await writer.installProtocol().then(() => 'accepted', (e: Error) => e.message);
    check(denied.includes('DWN 401'), `a DID that is not registered cannot write (${denied.slice(0, 60)})`);
    const terms = (await getTerms(base))!;
    check(terms.text === readFileSync(join(DEPLOY, 'terms-of-service.txt'), 'utf8'), 'the terms through Traefik are deploy/terms-of-service.txt');
    const wrong = await register(base, fx.did, { terms: { ...terms, hash: '0'.repeat(64) } }).then(() => 'accepted', (e: Error) => e.message);
    check(wrong.includes('HTTP 400'), `a registration with another terms hash fails (${wrong.slice(0, 60)})`);
    await register(base, fx.did, { terms });
    await writer.installProtocol();
    // More than 30 KB, so the write and the read use the binary body of the DWN.
    const tarball = random(2 * 1024 * 1024);
    const files = {
      release: new TextEncoder().encode('{"stack":"release 1.0.0"}'),
      tarball,
      index: new TextEncoder().encode('{"stack":"index"}'),
    };
    await writer.publish({ name: 'hello', version: '1.0.0', ...files });
    check(true, 'after the registration, the DID writes the protocol and a 2 MiB release through Traefik');

    // A new reader each time: a reader keeps the contextIds and the index for some time.
    const reader = () => dwnAdapter({ allowLoopback: true }).reader({ did: fx.did, serviceId: `${fx.did}#dwn`, type: 'DecentralizedWebNode', url: base }, { fetch });
    const readAll = async (r = reader()) => [
      await all(r, { kind: 'index', name: 'hello' }),
      await all(r, { kind: 'release', name: 'hello', version: '1.0.0' }),
      await all(r, { kind: 'tarball', name: 'hello', version: '1.0.0' }),
    ];
    const same = (got: Uint8Array[]) => [files.index, files.release, files.tarball].every((want, i) => Buffer.compare(want, got[i]!) === 0);
    check(same(await readAll()), 'the reader gets the same index, release and tarball bytes through Traefik');

    // dwn-server 0.1.45 alone does not resolve did:webvh. The release key is an Ed25519 Multikey method.
    const vh = await webvhFixture(WEB_HOST, ['pkgs']);
    writeFileSync(join(web, 'did.jsonl'), vh.jsonl(vh.log));
    const vhWriter = new DwnWriter({ dwnUrl: base, did: vh.did, signer: ed25519MessageSigner(vh.releaseSecret, `${vh.did}#didpkg-1`) });
    await register(base, vh.did, { terms });
    await vhWriter.installProtocol();
    await vhWriter.publish({ name: 'hello', version: '1.0.0', ...files });
    const vhReader = dwnAdapter({ allowLoopback: true }).reader({ did: vh.did, serviceId: `${vh.did}#dwn`, type: 'DecentralizedWebNode', url: base }, { fetch });
    const vhTarball = await all(vhReader, { kind: 'tarball', name: 'hello', version: '1.0.0' });
    check(Buffer.compare(vhTarball, files.tarball) === 0, 'a did:webvh publisher registers, writes a release and reads it through Traefik');

    // dwn-server 0.1.45 alone does not resolve did:plc. The DWN reads the audit log from the web container.
    const plc = await plcFixture();
    writeFileSync(join(web, 'plc.json'), JSON.stringify(plc.log));
    const plcWriter = new DwnWriter({ dwnUrl: base, did: plc.did, signer: ed25519MessageSigner(plc.releaseSecret, `${plc.did}#didpkg-1`) });
    await register(base, plc.did, { terms });
    await plcWriter.installProtocol();
    await plcWriter.publish({ name: 'hello', version: '1.0.0', ...files });
    const plcReader = dwnAdapter({ allowLoopback: true }).reader({ did: plc.did, serviceId: `${plc.did}#dwn`, type: 'DecentralizedWebNode', url: base }, { fetch });
    const plcTarball = await all(plcReader, { kind: 'tarball', name: 'hello', version: '1.0.0' });
    check(Buffer.compare(plcTarball, files.tarball) === 0, 'a did:plc publisher registers, writes a release and reads it through Traefik');

    // dwn-server 0.1.45 alone does not resolve did:btcr2. The DWN reads the beacon signal from the Esplora host,
    // and the genesis document and the update from a CAS host. All of them are in the web container.
    const btc = await btcr2Fixture({ release: true });
    const btcRoutes: Record<string, string> = {};
    const { fetch: esplora, routes } = btc.esplora();
    for (const url of Object.keys(routes)) btcRoutes[url.slice('https://'.length)] = await (await esplora(url, {})).text();
    const genesis = canonicalize(btc.genesisDocument)!;
    const blocks = { [casCid(bytesToHex(sha256(new TextEncoder().encode(genesis))))]: genesis, [casCid(btc.signal.signalBytes)]: canonicalize(btc.update)! };
    for (const gateway of CAS_GATEWAYS) {
      for (const [cid, block] of Object.entries(blocks)) btcRoutes[`${new URL(gateway).host}/ipfs/${cid}?format=raw`] = block;
    }
    writeFileSync(join(web, 'btcr2.json'), JSON.stringify(btcRoutes));
    const btcWriter = new DwnWriter({ dwnUrl: base, did: btc.did, signer: ed25519MessageSigner(btc.releaseSecret, `${btc.did}#didpkg-1`) });
    await register(base, btc.did, { terms });
    await btcWriter.installProtocol();
    await btcWriter.publish({ name: 'hello', version: '1.0.0', ...files });
    const btcReader = dwnAdapter({ allowLoopback: true }).reader({ did: btc.did, serviceId: `${btc.did}#dwn`, type: 'DecentralizedWebNode', url: base }, { fetch });
    const btcTarball = await all(btcReader, { kind: 'tarball', name: 'hello', version: '1.0.0' });
    check(Buffer.compare(btcTarball, files.tarball) === 0, 'a did:btcr2 publisher registers, writes a release and reads it through Traefik');

    const big = await fetch(`${base}/`, { method: 'POST', body: new Uint8Array(18 * 1024 * 1024) });
    check(big.status === 413, `Traefik refuses an 18 MiB body (${big.status})`);

    const backups = (await run(['./backup.sh'])).trim().split('\n');
    const file = backups.find((f) => f.startsWith(join(env.BACKUP_DIR, 'dwn-')))!;
    const file2 = backups.find((f) => f.startsWith(join(env.BACKUP_DIR, 'dwn2-')))!;
    check(!!file && !!file2 && Bun.file(file).size > 0 && Bun.file(file2).size > 0, 'backup.sh writes a backup file for dwn and for dwn2');
    await healthy();
    const release102 = () => all(reader(), { kind: 'release', name: 'hello', version: '1.0.2' });
    await writer.publish({ name: 'hello', version: '1.0.2', ...files, release: new TextEncoder().encode('{"stack":"release 1.0.2"}') });
    check((await release102()).length > 0, 'after the backup, the DID writes 1.0.2');
    await run(['./restore.sh', file]);
    await healthy();
    check(same(await readAll()) && (await release102()).length === 0, 'after restore.sh, the reader gets the bytes of the backup, and 1.0.2 is gone');
    await writer.publish({ name: 'hello', version: '1.0.1', ...files });
    check(true, 'after restore.sh, the registration is back: the DID writes 1.0.1');

    // The admin API is not on the internet, so tenant.sh calls it from the dwn container.
    type QuotaStatus = { quota: { maxMessages: number; maxStorageBytes: number; source: string }; usage: { messageCount: number; storageBytes: number } };
    const tenant = (...args: string[]) => run(['./tenant.sh', ...args]);
    const quota = async (...set: string[]): Promise<QuotaStatus> => JSON.parse((await tenant('quota', fx.did, ...set)).trim().split('\n').pop()!);
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

    const own = (await quota(String(200 * 1024 * 1024), '0')).quota;
    check(own.source === 'tenant' && own.maxStorageBytes === 200 * 1024 * 1024 && own.maxMessages === 0, 'tenant.sh quota sets the quota of one DID');
    check((await quota('default')).quota.source === 'global', 'tenant.sh quota default gives the DID the quota of compose.yaml again');
    check((await tenant('list')).includes(`${fx.did} `), 'tenant.sh list shows the DID');
    check(!(await run(['./tenant.sh', 'list'], { DWN_SERVICE: 'dwn2' })).includes(fx.did), 'the second DWN has its own tenants: DWN_SERVICE=dwn2 tenant.sh list does not show the DID');
    const write = () => writer.publish({ name: 'hello', version: '1.0.3', ...files }).then(() => 'accepted', (e: Error) => e.message);
    await tenant('suspend', fx.did);
    const suspended = await write();
    const unread = await readAll().then(() => 'read', (e: Error) => e.message);
    check(suspended.includes('Tenant is suspended') && unread.includes('bad query reply'), `after tenant.sh suspend, the DID cannot write or read (${suspended.slice(0, 60)})`);
    await tenant('unsuspend', fx.did);
    check(same(await readAll()), 'after tenant.sh unsuspend, the reader gets the same bytes');
    check((await tenant('show', fx.did)).includes(terms.hash), 'tenant.sh show shows the terms hash of the DID');
    await tenant('delete', fx.did);
    const gone = await readAll().then(() => 'read', (e: Error) => e.message);
    await register(base, fx.did, { terms });
    check(gone.includes('bad query reply') && same(await readAll()), 'after tenant.sh delete, the reads fail; after a new registration, the reader gets the same bytes');
    await tenant('block', fx.did);
    await register(base, fx.did, { terms });
    const blocked = await write();
    const left = (await quota()).usage;
    check(blocked.includes('Tenant is suspended') && left.messageCount === 0 && left.storageBytes === 0,
      `after tenant.sh block, the DID has no records, and it stays suspended after a new registration (${blocked.slice(0, 60)})`);

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
