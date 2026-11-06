// `didpkg id create --btcr2` and a did:btcr2 publish to a folder. The create makes no network request. A stub Esplora API
// shows no beacon signal, and a stub IPFS gateway serves the genesis file as a raw block.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNetwork, type NetworkName } from '@did-btcr2/bitcoin';
import { DidBtcr2, Identifier } from '@did-btcr2/method';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Address, OutScript, Transaction } from '@scure/btc-signer';
import canonicalize from 'canonicalize';
import { DidResolver, type DidDocument } from '@didpkg/core/did';
import { storageEndpoints } from '@didpkg/core/source';
import { btcr2Driver, casCid, ESPLORA, sidecarFile } from '@didpkg/core/did/btcr2';
import { toMultikey, verifyProof } from '@didpkg/core/trust';
import { DirWriter } from '@didpkg/adapter-https/dir';
import { createBtcr2, updateBtcr2 } from '../src/id/btcr2.ts';
import { decryptKey } from '../src/id/keyfile.ts';
import { idPaths, readIdentity } from '../src/id/store.ts';
import { publish } from '../src/publish/publish.ts';
import { npmTgz } from './tgz.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-id-btcr2-'));
const env = { DIDPKG_HOME: tmp };
const PASS = 'release passphrase 1';
const UPDATE_PASS = 'update passphrase 1';
const REPOS = ['https://pkgs.example.com/btcr2/', 'https://mirror.example.org/btcr2/'];
const GATEWAY = 'https://cas.example';
const DWN = 'https://dwn.example.com';

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * A stub Esplora API and a stub IPFS gateway with the `blocks` (CID to bytes). An address has no transaction, but each
 * Beacon Signal of `signals` is a confirmed transaction at its address, with the signal bytes (hex) in an OP_RETURN output.
 */
function stubNetwork(blocks: Record<string, Uint8Array> = {}, signals: { address: string; signal: string }[] = []) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    if (u.origin === GATEWAY) {
      const block = blocks[u.pathname.slice('/ipfs/'.length)];
      return block ? new Response(block as Uint8Array<ArrayBuffer>) : new Response('not found', { status: 404 });
    }
    if (url.endsWith('/blocks/tip/height')) return new Response('150000');
    if (u.pathname.includes('/address/') && u.pathname.endsWith('/txs/chain')) {
      return Response.json(signals.filter((s) => u.pathname.includes(`/address/${s.address}/`)).map((s, i) => ({
        txid: `${i + 2}`.repeat(64),
        status: { confirmed: true, block_height: 149_000, block_hash: '00'.repeat(4) + '33'.repeat(28), block_time: 1_789_000_000 },
        vin: [{ txid: '11'.repeat(32), vout: 0, prevout: { scriptpubkey_address: s.address } }],
        vout: [{ scriptpubkey: `6a20${s.signal}`, value: 0 }],
      })));
    }
    if (u.pathname.includes('/block/')) return Response.json({ id: u.pathname.split('/').at(-1), height: 149_000, mediantime: 1_788_999_000 });
    return new Response('not found', { status: 404 });
  };
  return { urls, fetch };
}

describe('id create --btcr2', async () => {
  const r = await createBtcr2({ alias: 'btc', network: 'testnet4', repos: REPOS, passphrase: PASS, updatePassphrase: UPDATE_PASS, env, iterations: 1000 });
  const paths = idPaths('btc', env);
  const identity = readIdentity(paths);
  const genesisFile = new Uint8Array(readFileSync(r.files.genesis));
  const sidecar = JSON.parse(readFileSync(r.files.sidecar, 'utf8'));
  const net = stubNetwork({ [r.cid]: genesisFile });
  const resolved = await new DidResolver({ drivers: [btcr2Driver({ cas: [GATEWAY], fetch: net.fetch })] }).resolve(r.did);

  test('the DID is an x1 identifier on the network: the SHA-256 of the genesis file', () => {
    expect(r.did).toMatch(/^did:btcr2:x1[a-z0-9]+$/);
    const { network, idType, genesisBytes } = Identifier.decode(r.did);
    expect([network, idType]).toEqual(['testnet4', 'EXTERNAL']);
    expect(genesisBytes).toEqual(sha256(genesisFile));
    expect(r.network).toBe('testnet4');
    expect(r.keyId).toBe(`${r.did}#didpkg-1`);
  });

  test('the genesis file is the JCS form of the Genesis Document, with the placeholder id and the 2 spec contexts', () => {
    const doc = identity.btcr2!.genesisDocument;
    expect(new TextDecoder().decode(genesisFile)).toBe(canonicalize(doc)!);
    expect(doc.id).toBe('did:btcr2:_');
    expect(doc['@context']).toEqual(['https://www.w3.org/ns/did/v1.1', 'https://btcr2.dev/context/v1']);
    expect(JSON.stringify(doc)).not.toContain(r.did);
    expect(identity.btcr2!.network).toBe('testnet4');
  });

  test('the sidecar file is the Sidecar Data of the spec, with the Genesis Document', () => {
    expect(sidecar).toEqual({ '@context': 'https://btcr2.dev/context/v1', genesisDocument: identity.btcr2!.genesisDocument });
  });

  test('the CID is the CIDv1 of the raw block, and the core driver resolves the DID from CAS', () => {
    expect(r.cid).toMatch(/^bafkrei[a-z2-7]{52}$/);
    expect(resolved.didResolutionMetadata.error).toBeUndefined();
    expect(net.urls).toContain(`${GATEWAY}/ipfs/${r.cid}?format=raw`);
    expect(net.urls.every((u) => u.startsWith(GATEWAY) || u.startsWith(ESPLORA.testnet4!))).toBe(true);
    expect(identity.document as unknown).toEqual(resolved.didDocument);
  });

  test('the document has #didpkg-1 in assertionMethod, the update key in capabilityInvocation, 1 beacon and the #pkg service', () => {
    const doc = resolved.didDocument!;
    expect(doc.id).toBe(r.did);
    expect(doc.assertionMethod).toEqual([r.keyId]);
    expect(doc.capabilityInvocation).toEqual([`${r.did}#initialKey`]);
    expect(doc.verificationMethod).toEqual([
      { id: `${r.did}#initialKey`, type: 'Multikey', controller: r.did, publicKeyMultibase: expect.stringMatching(/^zQ3s/) },
      { id: r.keyId, type: 'Multikey', controller: r.did, publicKeyMultibase: expect.stringMatching(/^z6Mk/) },
    ]);
    expect(doc.service).toEqual([
      { id: `${r.did}#initialP2WPKH`, type: 'SingletonBeacon', serviceEndpoint: expect.stringMatching(/^bitcoin:tb1q[a-z0-9]{38}$/) },
      { id: `${r.did}#pkg`, type: 'DIDPackageRepository', serviceEndpoint: REPOS },
    ]);
  });

  test('the update key file holds #initialKey, and the beacon is the P2WPKH address of that key', async () => {
    const update = await decryptKey(await Bun.file(paths.updateKey).json(), UPDATE_PASS);
    const publicKey = secp256k1.getPublicKey(update);
    const doc = resolved.didDocument!;
    expect(doc.verificationMethod![0]!.publicKeyMultibase).toBe(toMultikey({ alg: 'secp256k1', bytes: publicKey }));
    // The k1 DID of the same key has the library beacons of the key.
    const k1 = DidBtcr2.create(publicKey, { idType: 'KEY', network: 'testnet4' });
    const k1Doc = (await new DidResolver({ drivers: [btcr2Driver({ cas: [], fetch: stubNetwork().fetch })] }).resolve(k1)).didDocument!;
    const address = (d: typeof doc, id: string) => d.service!.find((s) => s.id === `${d.id}#${id}`)!.serviceEndpoint;
    expect(address(doc, 'initialP2WPKH')).toBe(address(k1Doc, 'initialP2WPKH'));
  });

  test('the identity and the update key have mode 0600, and the sidecar and genesis files have mode 0644', () => {
    expect(statSync(r.files.identity).mode & 0o777).toBe(0o600);
    expect(statSync(r.files.updateKey).mode & 0o777).toBe(0o600);
    expect(statSync(r.files.sidecar).mode & 0o777).toBe(0o644);
    expect(statSync(r.files.genesis).mode & 0o777).toBe(0o644);
  });

  test('the sidecar data alone also resolves the DID, with CAS off', async () => {
    const driver = btcr2Driver({ cas: [], fetch: stubNetwork().fetch, sidecar: async (did) => (did === r.did ? sidecar : undefined) });
    expect((await new DidResolver({ drivers: [driver] }).resolve(r.did)).didDocument).toEqual(resolved.didDocument);
  });

  test('a bitcoin DID has a bc1q beacon', async () => {
    const m = await createBtcr2({ alias: 'btc-main', network: 'bitcoin', repos: REPOS.slice(0, 1), passphrase: PASS, updatePassphrase: UPDATE_PASS, env, iterations: 1000 });
    expect(Identifier.decode(m.did).network).toBe('bitcoin');
    expect(readIdentity(idPaths('btc-main', env)).document.service![0]!.serviceEndpoint).toMatch(/^bitcoin:bc1q/);
  });

  test('with --dwn, the Genesis Document has #dwn before #pkg, and the DWN is the first storage endpoint', async () => {
    const d = await createBtcr2({ alias: 'btc-dwn', network: 'testnet4', dwn: DWN, repos: REPOS.slice(0, 1), passphrase: PASS, updatePassphrase: UPDATE_PASS, env, iterations: 1000 });
    const doc = readIdentity(idPaths('btc-dwn', env)).document;
    expect(doc.service!.map((s) => [s.id, s.type, s.serviceEndpoint])).toEqual([
      [`${d.did}#initialP2WPKH`, 'SingletonBeacon', expect.stringMatching(/^bitcoin:tb1q/)],
      [`${d.did}#dwn`, 'DecentralizedWebNode', [DWN]],
      [`${d.did}#pkg`, 'DIDPackageRepository', REPOS.slice(0, 1)],
    ]);
    expect(storageEndpoints(doc as unknown as DidDocument).map((e) => [e.type, e.url])).toEqual([['DecentralizedWebNode', DWN], ['DIDPackageRepository', REPOS[0]]]);
  });

  test('with --dwn and no --repo, the DID has no #pkg service, and the sidecar data resolves it', async () => {
    const d = await createBtcr2({ alias: 'btc-dwn-only', network: 'signet', dwn: DWN, repos: [], passphrase: PASS, updatePassphrase: UPDATE_PASS, env, iterations: 1000 });
    const sidecarOnly = JSON.parse(readFileSync(d.files.sidecar, 'utf8'));
    const driver = btcr2Driver({ cas: [], fetch: stubNetwork().fetch, sidecar: async (did) => (did === d.did ? sidecarOnly : undefined) });
    const doc = (await new DidResolver({ drivers: [driver] }).resolve(d.did)).didDocument!;
    expect(doc.service!.map((s) => s.id)).toEqual([`${d.did}#initialP2WPKH`, `${d.did}#dwn`]);
    expect(readIdentity(idPaths('btc-dwn-only', env)).document as unknown).toEqual(doc);
  });

  test('bad options fail before a file write', async () => {
    const o: Omit<Parameters<typeof createBtcr2>[0], 'alias'> = { network: 'testnet4', repos: REPOS, passphrase: PASS, updatePassphrase: UPDATE_PASS, env, iterations: 1000 };
    const cases: [string, Partial<typeof o>, string][] = [
      ['b1', { updatePassphrase: PASS }, 'must not be'],
      ['b2', { repos: [] }, 'needs a --dwn URL or a --repo URL'],
      ['b3', { network: 'mainnet' }, '--btcr2: "mainnet" is not a network'],
      ['b4', { repos: ['http://pkgs.example.com/'] }, 'must use https'],
      ['b5', { dwn: 'http://dwn.example.com' }, 'must use https'],
    ];
    for (const [alias, change, error] of cases) {
      await expect(createBtcr2({ ...o, ...change, alias })).rejects.toThrow(error);
      expect(existsSync(idPaths(alias, env).identity)).toBe(false);
      expect(existsSync(idPaths(alias, env).genesis)).toBe(false);
    }
    await expect(createBtcr2({ ...o, alias: 'btc' })).rejects.toThrow('exists');
  });

  test('publish to a folder signs with #didpkg-1, and the release verifies against the resolved document', async () => {
    const site = join(tmp, 'site');
    const out = await publish({ identity, tarball: npmTgz({ name: 'hello', version: '1.0.0' }), to: [`dir:${site}`], passphrase: async () => PASS });
    expect(out.relays).toEqual([]);
    expect(out.targets).toEqual([{ url: `dir:${site}`, ok: true }]);
    expect(out.installName).toBe(`@didpkg/hello_did_btcr2_${r.did.slice('did:btcr2:'.length)}`);
    const [release] = await Array.fromAsync(new DirWriter(site).read({ kind: 'release', name: 'hello', version: '1.0.0' }, { signal: AbortSignal.timeout(5000), maxBytes: 1 << 20 }));
    expect((await verifyProof(JSON.parse(new TextDecoder().decode(release)), resolved.didDocument!)).verificationMethod).toBe(r.keyId);
  });

  test('publish to a folder also writes the Sidecar Data file: the same bytes as the identity file', async () => {
    const site = join(tmp, 'site-sidecar');
    await publish({ identity, tarball: npmTgz({ name: 'hello', version: '1.0.0' }), to: [`dir:${site}`], passphrase: async () => PASS });
    const file = join(site, sidecarFile(r.did));
    expect(file).toBe(join(site, `${r.did.slice('did:btcr2:'.length)}.sidecar.json`));
    expect(readFileSync(file, 'utf8')).toBe(readFileSync(r.files.sidecar, 'utf8'));
    expect(statSync(file).mode & 0o777).toBe(0o666 & ~process.umask());
  });
});

describe('id update of a did:btcr2 identity', async () => {
  const NEW_REPOS = ['https://pkgs.example.net/btcr2/'];
  const created = await createBtcr2({ alias: 'upd', network: 'testnet4', dwn: DWN, repos: REPOS, passphrase: PASS, updatePassphrase: UPDATE_PASS, env, iterations: 1000 });
  const paths = idPaths('upd', env);
  const before = readIdentity(paths);
  const beaconOf = (alias: string) => String(readIdentity(idPaths(alias, env)).document.service![0]!.serviceEndpoint).slice('bitcoin:'.length);
  const net = stubNetwork();
  const r = await updateBtcr2({ alias: 'upd', repos: NEW_REPOS, updatePassphrase: UPDATE_PASS, env, fetch: net.fetch });
  const file = new Uint8Array(readFileSync(r.files.update));
  const sidecar = JSON.parse(readFileSync(r.files.sidecar, 'utf8'));
  const signals = [{ address: beaconOf('upd'), signal: r.signal }];
  const pkg = { id: `${r.did}#pkg`, type: 'DIDPackageRepository', serviceEndpoint: NEW_REPOS };
  const update = (alias: string, o: Partial<Parameters<typeof updateBtcr2>[0]> = {}) => updateBtcr2({
    alias, updatePassphrase: UPDATE_PASS, env, fetch: stubNetwork().fetch, ...o,
  });

  test('the update file is the JCS form of the signed update, and its SHA-256 is the Beacon Signal and the CID', () => {
    expect(r.versionId).toBe(2);
    expect(r.files.update).toBe(join(tmp, 'ids', 'upd.update-2.json'));
    expect(bytesToHex(sha256(file))).toBe(r.signal);
    expect(r.cid).toBe(casCid(r.signal));
    expect(new TextDecoder().decode(file)).toBe(canonicalize(sidecar.updates[0])!);
    expect(statSync(r.files.update).mode & 0o777).toBe(0o644);
  });

  test('the sidecar file gets the update, and the identity keeps it as the pending update', () => {
    const identity = readIdentity(paths);
    expect(sidecar.genesisDocument).toEqual(before.btcr2!.genesisDocument);
    expect(sidecar.updates).toHaveLength(1);
    expect(identity.btcr2!.pending).toEqual({ versionId: 2, cid: r.cid, update: sidecar.updates[0] });
    expect(identity.document).toEqual(before.document);
    expect([statSync(paths.identity).mode & 0o777, statSync(paths.sidecar).mode & 0o777]).toEqual([0o600, 0o644]);
    expect(existsSync(`${paths.identity}.tmp`) || existsSync(`${paths.sidecar}.tmp`)).toBe(false);
  });

  test('the request of the current state goes only to Esplora (CAS off)', () => {
    expect(net.urls.length).toBeGreaterThan(0);
    expect(net.urls.every((u) => u.startsWith(ESPLORA.testnet4!))).toBe(true);
  });

  test('with a Beacon Signal of the update, the core driver resolves version 2 from the sidecar file: a new #pkg, and the beacon and #dwn stay', async () => {
    const driver = btcr2Driver({ cas: [], fetch: stubNetwork({}, signals).fetch, sidecar: async () => sidecar });
    const doc = await new DidResolver({ drivers: [driver] }).resolve(r.did);
    expect(doc.didDocumentMetadata.versionId).toBe('2');
    expect(doc.didDocument!.service).toEqual([before.document.service![0]!, before.document.service![1]!, pkg]);
  });

  test('a clean resolve gets the genesis file and the update file from CAS alone, and gives version 2', async () => {
    const blocks = { [created.cid]: new Uint8Array(readFileSync(created.files.genesis)), [r.cid]: file };
    const driver = btcr2Driver({ cas: [GATEWAY], fetch: stubNetwork(blocks, signals).fetch });
    const doc = await new DidResolver({ drivers: [driver] }).resolve(r.did);
    expect(doc.didDocumentMetadata.versionId).toBe('2');
    expect(doc.didDocument!.service!.at(-1)).toEqual(pkg);
  });

  test('with no Beacon Signal, the sidecar file with the update still resolves version 1', async () => {
    const driver = btcr2Driver({ cas: [], fetch: stubNetwork().fetch, sidecar: async () => sidecar });
    const doc = await new DidResolver({ drivers: [driver] }).resolve(r.did);
    expect(doc.didDocumentMetadata.versionId).toBe('1');
    expect(doc.didDocument as object).toEqual(before.document);
  });

  test('a second update while one is pending fails before a request, and no file changes', async () => {
    const files = [paths.identity, paths.sidecar].map((f) => readFileSync(f, 'utf8'));
    const second = stubNetwork({}, signals);
    await expect(update('upd', { dwn: 'https://dwn2.example.com', fetch: second.fetch })).rejects.toThrow(`the update to version 2 (CID ${r.cid}) is not on Bitcoin yet`);
    expect(second.urls).toEqual([]);
    expect(existsSync(paths.btcr2Update(3))).toBe(false);
    expect([paths.identity, paths.sidecar].map((f) => readFileSync(f, 'utf8'))).toEqual(files);
  });

  test('a Beacon Signal on Bitcoin that the sidecar file does not have stops the update, with no file write', async () => {
    await createBtcr2({ alias: 'upd-x', network: 'testnet4', repos: REPOS, passphrase: PASS, updatePassphrase: UPDATE_PASS, env, iterations: 1000 });
    const unknown = stubNetwork({}, [{ address: beaconOf('upd-x'), signal: 'ab'.repeat(32) }]);
    await expect(update('upd-x', { repos: NEW_REPOS, fetch: unknown.fetch })).rejects.toThrow('MISSING_UPDATE_DATA');
    expect(existsSync(idPaths('upd-x', env).btcr2Update(2))).toBe(false);
    expect(readIdentity(idPaths('upd-x', env)).btcr2!.pending).toBeUndefined();
  });

  test('--remove dwn keeps the beacon and #pkg, and --dwn changes #dwn', async () => {
    const services = (alias: string) => (readIdentity(idPaths(alias, env)).btcr2!.pending!.update as { patch: { value: unknown[] }[] }).patch[0]!.value;
    const removed = await createBtcr2({ alias: 'upd-r', network: 'testnet4', dwn: DWN, repos: REPOS, passphrase: PASS, updatePassphrase: UPDATE_PASS, env, iterations: 1000 });
    await update('upd-r', { removeDwn: true });
    const doc = readIdentity(idPaths('upd-r', env)).document;
    expect(services('upd-r')).toEqual([doc.service![0]!, doc.service![2]!]);
    const changed = await createBtcr2({ alias: 'upd-d', network: 'testnet4', dwn: DWN, repos: REPOS, passphrase: PASS, updatePassphrase: UPDATE_PASS, env, iterations: 1000 });
    await update('upd-d', { dwn: 'https://dwn2.example.com/' });
    expect(services('upd-d')).toEqual([
      readIdentity(idPaths('upd-d', env)).document.service![0]!,
      { id: `${changed.did}#dwn`, type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn2.example.com/'] },
      { id: `${changed.did}#pkg`, type: 'DIDPackageRepository', serviceEndpoint: REPOS },
    ]);
    expect(removed.did).not.toBe(changed.did);
  });

  test('bad options and a bad passphrase fail with no file write', async () => {
    await createBtcr2({ alias: 'upd-b', network: 'testnet4', dwn: DWN, passphrase: PASS, repos: [], updatePassphrase: UPDATE_PASS, env, iterations: 1000 });
    const cases: [Partial<Parameters<typeof updateBtcr2>[0]>, string][] = [
      [{}, 'nothing to update'],
      [{ removeDwn: true, dwn: DWN }, 'remove the DWN, or change it: not both'],
      [{ removeDwn: true }, 'a did:btcr2 identity needs a DWN or a mirror URL'],
      [{ repos: ['http://pkgs.example.com/'] }, 'must use https'],
      [{ repos: NEW_REPOS, updatePassphrase: 'wrong' }, ''],
    ];
    for (const [o, error] of cases) await expect(update('upd-b', o)).rejects.toThrow(error);
    expect(existsSync(idPaths('upd-b', env).btcr2Update(2))).toBe(false);
    expect(readIdentity(idPaths('upd-b', env)).btcr2!.pending).toBeUndefined();
  });
});

describe('the CLI', () => {
  const keys = { DIDPKG_PASSPHRASE: PASS, DIDPKG_UPDATE_PASSPHRASE: UPDATE_PASS };
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, cli, ...args], {
      env: { PATH: process.env.PATH!, ...env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  };

  test('id create --btcr2 writes the files and prints the DID, the CID and the IPFS command', async () => {
    const r = await run(['id', 'create', 'cli', '--btcr2', 'signet', '--repo', REPOS[0]!], keys);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(Identifier.decode(out.did).network).toBe('signet');
    expect(out.cid).toMatch(/^bafkrei/);
    expect(r.err).toContain(`Move ${out.files.updateKey} offline.`);
    expect(r.err).toContain(`with the CID ${out.cid}:\n  ipfs block put --cid-codec raw --mhtype sha2-256 --pin=true ${out.files.genesis}\n`);
    expect(r.err).toContain(`Or use the Sidecar Data in ${out.files.sidecar}: "didpkg publish --to dir:<path>" writes a copy to <path>/${sidecarFile(out.did)}.\n`);
    const register = await run(['id', 'register', 'cli']);
    expect([register.code, register.err]).toEqual([1, expect.stringContaining('the identity has no DecentralizedWebNode service: use --dwn <url>')]);
    expect(r.err).not.toContain('The DWN reads the genesis document only from IPFS.');
  });

  test('id create --btcr2 --dwn says that the DWN reads the genesis document only from IPFS', async () => {
    const r = await run(['id', 'create', 'cli-dwn', '--btcr2', 'signet', '--dwn', DWN], keys);
    expect(r.code).toBe(0);
    expect(r.err).toContain('The DWN reads the genesis document only from IPFS. Put it there before "didpkg publish --to dwn".\n');
    expect(readIdentity(idPaths('cli-dwn', env)).document.service!.map((s) => s.type)).toEqual(['SingletonBeacon', 'DecentralizedWebNode']);
  });

  test('id update of a did:btcr2 identity refuses --rotate, and a second update while one is pending', async () => {
    const rotate = await run(['id', 'update', 'upd', '--rotate', 'release'], keys);
    expect([rotate.code === 0, rotate.err]).toEqual([false, expect.stringContaining('--rotate is for a XID identity only')]);
    const pending = await run(['id', 'update', 'upd', '--repo', REPOS[0]!], keys);
    expect([pending.code, pending.err]).toEqual([1, expect.stringContaining('the update to version 2 (CID bafkrei')]);
  });

  test('--btcr2 with --relay or --plc, with no --dwn and no --repo, or with a bad network fails before a file write', async () => {
    const cases: [string, string[], string][] = [
      ['c1', ['--btcr2', 'bitcoin', '--dwn', 'http://dwn.example'], 'must use https'],
      ['c2', ['--btcr2', 'bitcoin', '--repo', REPOS[0]!, '--relay', 'https://relay.example'], '--relay is for did:dht only'],
      ['c3', ['--btcr2', 'bitcoin', '--plc', 'https://plc.example', '--repo', REPOS[0]!], 'use --btcr2 without --web, --webvh and --plc'],
      ['c4', ['--btcr2', 'bitcoin'], '--btcr2 needs --dwn <url> or --repo <url>'],
      ['c5', ['--btcr2', 'bitcoin', '--btcr2', 'signet', '--repo', REPOS[0]!], 'use --btcr2 one time'],
      ['c6', ['--btcr2', 'testnet', '--repo', REPOS[0]!], '--btcr2: "testnet" is not a network'],
    ];
    for (const [alias, args, error] of cases) {
      const r = await run(['id', 'create', alias, ...args], keys);
      expect(r.code).toBe(1);
      expect(r.err).toContain(error);
      expect(existsSync(idPaths(alias, env).identity)).toBe(false);
    }
  });
});

/** The bytes of a transaction that pays `value` sat to `script`. Its txid is the reversed double SHA-256 of the bytes. */
function fundingTx(script: Uint8Array, value: number): { hex: string; txid: string } {
  const le = (n: bigint, size: number) => Uint8Array.from({ length: size }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
  const raw = Uint8Array.from([
    ...le(2n, 4), 1, ...new Uint8Array(32).fill(0x11), ...le(0n, 4), 0, ...le(0xffffffffn, 4),
    1, ...le(BigInt(value), 8), script.length, ...script, ...le(0n, 4),
  ]);
  return { hex: bytesToHex(raw), txid: bytesToHex(sha256(sha256(raw)).reverse()) };
}

/**
 * A loopback stub of an Esplora API and an IPFS gateway with the `blocks` (CID to bytes). The beacon address has one
 * confirmed UTXO of 5,000 sat. POST /tx keeps the transaction. After confirm(), the transaction is in a block, with
 * more than 6 confirmations.
 */
function stubServer(beacon: string, network: NetworkName) {
  const blocks: Record<string, Uint8Array> = {};
  const posted: Transaction[] = [];
  const script = OutScript.encode(Address(getNetwork(network)).decode(beacon));
  const funding = fundingTx(script, 5000);
  let confirmed = false;
  const block = { block_height: 149_000, block_hash: '00'.repeat(4) + '33'.repeat(28), block_time: 1_789_000_000 };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith('/ipfs/')) {
        const b = blocks[path.slice('/ipfs/'.length)];
        return b ? new Response(b as Uint8Array<ArrayBuffer>) : new Response('not found', { status: 404 });
      }
      if (path === '/tx' && req.method === 'POST') {
        const tx = Transaction.fromRaw(hexToBytes(await req.text()), { allowUnknownOutputs: true });
        posted.push(tx);
        return new Response(tx.id);
      }
      if (path === '/blocks/tip/height') return new Response('150000');
      if (path === `/address/${beacon}/utxo`) {
        return Response.json(posted.length ? [] : [{ txid: funding.txid, vout: 0, value: 5000, status: { confirmed: true, ...block } }]);
      }
      if (path === `/tx/${funding.txid}/hex`) return new Response(funding.hex);
      if (posted.some((tx) => path === `/tx/${tx.id}`)) return Response.json({ txid: path.slice(4), status: { confirmed } });
      if (path.startsWith(`/address/${beacon}/txs/chain`)) {
        return Response.json(!confirmed ? [] : posted.map((tx) => ({
          txid: tx.id,
          status: { confirmed: true, ...block },
          vin: [{ txid: funding.txid, vout: 0, prevout: { scriptpubkey_address: beacon } }],
          vout: Array.from({ length: tx.outputsLength }, (_, i) => ({ scriptpubkey: bytesToHex(tx.getOutput(i).script!), value: Number(tx.getOutput(i).amount) })),
        })));
      }
      if (path.startsWith('/block/')) return Response.json({ id: path.split('/').at(-1), height: 149_000, mediantime: 1_788_999_000 });
      return new Response('not found', { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, blocks, posted, script, funding, confirm: () => { confirmed = true; }, stop: () => server.stop(true) };
}

describe('id broadcast of a did:btcr2 identity', async () => {
  const home = mkdtempSync(join(tmpdir(), 'didpkg-id-broadcast-'));
  const benv = { DIDPKG_HOME: home };
  const NEW_REPOS = ['https://pkgs.example.net/btcr2/'];
  const created = await createBtcr2({ alias: 'bc', network: 'testnet4', dwn: DWN, repos: REPOS, passphrase: PASS, updatePassphrase: UPDATE_PASS, env: benv, iterations: 1000 });
  const paths = idPaths('bc', benv);
  const beacon = String(readIdentity(paths).document.service![0]!.serviceEndpoint).slice('bitcoin:'.length);
  const stub = stubServer(beacon, 'testnet4');
  stub.blocks[created.cid] = new Uint8Array(readFileSync(created.files.genesis));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ esplora: { testnet4: stub.url }, cas: [stub.url] }));
  const net = { esplora: { testnet4: stub.url }, allowPrivateHosts: true };
  const r = await updateBtcr2({ alias: 'bc', repos: NEW_REPOS, updatePassphrase: UPDATE_PASS, env: benv, ...net });
  const pending = () => readIdentity(paths).btcr2!.pending;
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, cli, ...args], {
      env: { PATH: process.env.PATH!, ...benv, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  };
  const keys = { DIDPKG_UPDATE_PASSPHRASE: UPDATE_PASS };
  afterAll(() => {
    stub.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test('with no update block in IPFS, the broadcast refuses and sends nothing', async () => {
    const b = await run(['id', 'broadcast', 'bc', '--allow-loopback'], keys);
    expect(b.code).toBe(1);
    expect(b.err).toContain(`no IPFS gateway gives ${r.cid}: nothing is sent`);
    expect(b.err).toContain(`  ipfs block put --cid-codec raw --mhtype sha2-256 --pin=true ${r.files.update}`);
    expect(b.err).not.toContain(created.cid);
    expect(stub.posted).toEqual([]);
    expect(pending()!.txid).toBeUndefined();
  });

  test('the transaction spends the beacon UTXO, has 1 OP_RETURN with the signal, and the change goes to the beacon address', async () => {
    stub.blocks[r.cid] = new Uint8Array(readFileSync(r.files.update));
    const b = await run(['id', 'broadcast', 'bc', '--allow-loopback', '--fee-rate', '2'], keys);
    expect([b.code, b.err]).toEqual([0, expect.stringContaining('Sent the Beacon Signal')]);
    const out = JSON.parse(b.out);
    expect(out).toMatchObject({ did: r.did, versionId: 2, cid: r.cid, signal: r.signal, beacon, state: 'sent' });
    expect(stub.posted.length).toBe(1);
    const tx = stub.posted[0]!;
    expect(tx.id).toBe(out.txid);
    expect(tx.inputsLength).toBe(1);
    expect([bytesToHex(tx.getInput(0).txid!), tx.getInput(0).index]).toEqual([stub.funding.txid, 0]);
    const outputs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));
    expect(outputs.filter((o) => o.script![0] === 0x6a).map((o) => [bytesToHex(o.script!), o.amount])).toEqual([[`6a20${r.signal}`, 0n]]);
    const change = outputs.filter((o) => o.script![0] !== 0x6a);
    expect(change.map((o) => bytesToHex(o.script!))).toEqual([bytesToHex(stub.script)]);
    const fee = 5000 - Number(change[0]!.amount);
    expect(fee >= 2 * 100 && fee <= 2 * 200).toBe(true);
    expect(pending()!.txid).toBe(out.txid);
  });

  test('while Esplora has the transaction, a broadcast needs no passphrase and sends nothing; id update refuses', async () => {
    const b = await run(['id', 'broadcast', 'bc', '--allow-loopback']);
    expect([b.code, JSON.parse(b.out).state, JSON.parse(b.out).txid]).toEqual([0, 'waiting', pending()!.txid]);
    expect(stub.posted.length).toBe(1);
    await expect(updateBtcr2({ alias: 'bc', dwn: 'https://dwn2.example.com', updatePassphrase: UPDATE_PASS, env: benv, ...net }))
      .rejects.toThrow(`resolvers do not show the transaction ${pending()!.txid} of the update to version 2 yet`);
    const show = JSON.parse((await run(['id', 'show', 'bc'])).out);
    expect(show.btcr2).toEqual({ network: 'testnet4', beacon, pending: { versionId: 2, cid: r.cid, txid: pending()!.txid } });
  });

  test('after 6 confirmations, a clean resolve gives version 2, and the broadcast clears the pending update', async () => {
    stub.confirm();
    const resolver = new DidResolver({ drivers: [btcr2Driver({ esplora: { testnet4: stub.url }, cas: [stub.url], allowPrivateHosts: true })] });
    const clean = await resolver.resolve(r.did);
    expect(clean.didDocumentMetadata.versionId).toBe('2');
    expect(clean.didDocument!.service!.find((s) => s.id === `${r.did}#pkg`)!.serviceEndpoint).toEqual(NEW_REPOS);
    const withPending = readFileSync(paths.identity, 'utf8');
    const b = await run(['id', 'broadcast', 'bc', '--allow-loopback']);
    expect([b.code, JSON.parse(b.out).state, b.err]).toEqual([0, 'confirmed', expect.stringContaining('The identity has no pending update now.')]);
    expect(pending()).toBeUndefined();
    expect(readIdentity(paths).document).toEqual(clean.didDocument as never);
    expect(JSON.parse((await run(['id', 'show', 'bc'])).out).btcr2).toEqual({ network: 'testnet4', beacon });
    const again = await run(['id', 'broadcast', 'bc', '--allow-loopback']);
    expect([again.code, again.err]).toEqual([1, expect.stringContaining('the identity has no update to send')]);
    // id update also sees the confirmed update: it clears the pending record, then signs the update to version 3.
    writeFileSync(paths.identity, withPending, { mode: 0o600 });
    const next = await updateBtcr2({ alias: 'bc', dwn: 'https://dwn2.example.com', updatePassphrase: UPDATE_PASS, env: benv, ...net });
    expect([next.versionId, pending()!.versionId, pending()!.txid]).toEqual([3, 3, undefined]);
    expect(readIdentity(paths).document).toEqual(clean.didDocument as never);
    expect(stub.posted.length).toBe(1);
  });

  test('bad options fail before a request', async () => {
    for (const [args, message] of [
      [['id', 'broadcast', 'bc', '--fee-rate', '0'], '--fee-rate: 0 is not a number of sat/vB'],
      [['id', 'broadcast', 'bc', '--fee-rate', '1e3'], '--fee-rate: 1e3 is not a number of sat/vB'],
      [['id', 'broadcast', 'bc', '--fee-rate', '1', '--fee-rate', '2'], 'use --fee-rate one time'],
      [['id', 'broadcast'], '"id broadcast" needs 1 argument'],
    ] as const) {
      const b = await run([...args]);
      expect([b.code, b.err]).toEqual([1, expect.stringContaining(message)]);
    }
    expect(stub.posted.length).toBe(1);
  });
});
