// `didpkg id create --btcr2` for did:btcr2 (the did:btcr2 spec, sections "Create" and "Data Structures").
// The DID is an x1 identifier: the hash of a Genesis Document. Create makes no Bitcoin transaction and no network request.
// A resolver needs the Genesis Document. CAS (IPFS) or the Sidecar Data gives it.
// The update key #initialKey is a secp256k1 Multikey in capabilityInvocation: the spec takes only this key type for an update.
// The singleton beacon #initialP2WPKH is the P2WPKH address of the update key. An update spends a UTXO of this address.
// The release key #didpkg-1 is an Ed25519 Multikey in assertionMethod.
// The services #dwn and #pkg are in the Genesis Document: a change to them needs an update (a Beacon Signal).
// `didpkg id update` signs the update (spec section "Update") and writes it as a raw block to put in CAS. It sends no
// Bitcoin transaction.
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getNetwork, type NetworkName } from '@did-btcr2/bitcoin';
import { BeaconUtils, DidBtcr2, ID_PLACEHOLDER_VALUE, Updater, type Btcr2DidDocument, type Sidecar } from '@did-btcr2/method';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import { errorCode, type FetchLike } from '@didpkg/core/did';
import { btcr2Driver, casCid, type Btcr2DriverOptions } from '@didpkg/core/did/btcr2';
import { toMultikey } from '@didpkg/core/trust';
import { endpoint, RELEASE_KEY, REPOSITORY_TYPE } from './dht.ts';
import { decryptKey, encryptKey, type EncryptedKey } from './keyfile.ts';
import { ID_FORMAT, idPaths, readIdentity, writeIdentity, type Identity } from './store.ts';

/** The names of the spec table "Network Values". */
export const NETWORKS: readonly NetworkName[] = ['bitcoin', 'signet', 'regtest', 'testnet3', 'testnet4', 'mutinynet'];

/** The Sidecar Data context (spec section "BTCR2 Context"). */
const BTCR2_CONTEXT = 'https://btcr2.dev/context/v1';
const UPDATE_KEY = 'initialKey';
const BEACON = 'initialP2WPKH';

export interface Btcr2CreateOptions {
  alias: string;
  network: string;
  /** A DWN endpoint: the service #dwn (type `DecentralizedWebNode`). */
  dwn?: string;
  /** Static mirror URLs: the service #pkg (type `DIDPackageRepository`). */
  repos: string[];
  passphrase: string;
  updatePassphrase: string;
  env?: Record<string, string | undefined>;
  /** For tests only. */
  iterations?: number;
}

export interface Btcr2CreateResult {
  alias: string;
  did: string;
  keyId: string;
  network: NetworkName;
  /** The IPFS CID of the genesis file (a raw block). */
  cid: string;
  files: { identity: string; updateKey: string; sidecar: string; genesis: string };
}

/** The Sidecar Data of a DID with no update (spec section "Sidecar Data"). */
export function sidecarData(genesisDocument: Record<string, unknown>): { '@context': string; genesisDocument: Record<string, unknown> } {
  return { '@context': BTCR2_CONTEXT, genesisDocument };
}

export function network(name: string): NetworkName {
  if (!(NETWORKS as readonly string[]).includes(name)) throw new Error(`--btcr2: ${JSON.stringify(name)} is not a network: use ${NETWORKS.join(', ')}`);
  return name as NetworkName;
}

/** The services #dwn and #pkg. Each endpoint is an array, so #pkg holds all of the mirror URLs. */
function servicesOf(id: string, o: { dwn?: string; repos: string[] }): Record<string, unknown>[] {
  return [
    ...(o.dwn === undefined ? [] : [{ id: `${id}#dwn`, type: 'DecentralizedWebNode', serviceEndpoint: [endpoint(o.dwn, 'dwn')] }]),
    ...(o.repos.length === 0 ? [] : [{ id: `${id}#pkg`, type: REPOSITORY_TYPE, serviceEndpoint: o.repos.map((r) => endpoint(r, 'repo')) }]),
  ];
}

/** The Genesis Document: the DID document with the placeholder id `did:btcr2:_`. */
function genesisOf(n: NetworkName, updateKey: Uint8Array, releaseKey: Uint8Array, o: { dwn?: string; repos: string[] }): Record<string, unknown> {
  if (o.dwn === undefined && o.repos.length === 0) throw new Error('a did:btcr2 identity needs a --dwn URL or a --repo URL');
  const id = ID_PLACEHOLDER_VALUE;
  const beacon = BeaconUtils.generateBeaconServices({ id, publicKey: updateKey, network: getNetwork(n), beaconType: 'SingletonBeacon' })
    .find((s) => s.id === `${id}#${BEACON}`)!;
  return {
    '@context': ['https://www.w3.org/ns/did/v1.1', BTCR2_CONTEXT],
    id,
    verificationMethod: [
      { id: `${id}#${UPDATE_KEY}`, type: 'Multikey', controller: id, publicKeyMultibase: toMultikey({ alg: 'secp256k1', bytes: updateKey }) },
      { id: `${id}#${RELEASE_KEY}`, type: 'Multikey', controller: id, publicKeyMultibase: toMultikey({ alg: 'Ed25519', bytes: releaseKey }) },
    ],
    assertionMethod: [`${id}#${RELEASE_KEY}`],
    capabilityInvocation: [`${id}#${UPDATE_KEY}`],
    service: [beacon, ...servicesOf(id, o)],
  };
}

/**
 * The document of the DID with no update. The core driver resolves it as the shim does: the sidecar data gives the
 * Genesis Document, and a stub Esplora API shows no beacon signal.
 */
async function documentOf(did: string, n: NetworkName, genesisDocument: object): Promise<Identity['document']> {
  const driver = btcr2Driver({
    esplora: { [n]: 'https://esplora.invalid' },
    cas: [],
    sidecar: async () => ({ genesisDocument }) as never,
    fetch: async (url) => new Response(String(url).endsWith('/blocks/tip/height') ? '0' : '[]'),
  });
  const r = await driver.resolve(did, {}, { signal: AbortSignal.timeout(5000) });
  if (!r.didDocument) throw new Error(`the genesis document fails the did:btcr2 checks: ${r.didResolutionMetadata.error}`);
  return r.didDocument as Identity['document'];
}

export async function createBtcr2(o: Btcr2CreateOptions): Promise<Btcr2CreateResult> {
  const paths = idPaths(o.alias, o.env);
  const n = network(o.network);
  if (o.passphrase === o.updatePassphrase) throw new Error('the update key passphrase must not be the release key passphrase');

  const release = await ed.keygenAsync();
  const update = secp256k1.utils.randomSecretKey();
  const genesisDocument = genesisOf(n, secp256k1.getPublicKey(update), release.publicKey, o);
  // The genesis file is the JCS form of the Genesis Document (spec algorithm "JSON Document Hashing"). Its SHA-256 is the
  // genesis bytes of the DID. The resolve in documentOf hashes the document again with the library, so the two must agree.
  const block = new TextEncoder().encode(canonicalize(genesisDocument)!);
  const hash = sha256(block);
  const did = DidBtcr2.create(hash, { idType: 'EXTERNAL', network: n });
  const keyId = `${did}#${RELEASE_KEY}`;
  const identity: Identity = {
    format: ID_FORMAT, alias: o.alias, did, created: new Date().toISOString(), document: await documentOf(did, n, genesisDocument),
    btcr2: { network: n, genesisDocument },
    releaseKey: await encryptKey({ did, keyId, seed: release.secretKey, passphrase: o.passphrase, iterations: o.iterations }),
  };
  writeIdentity(paths, identity, {
    updateKey: await encryptKey({
      did, keyId: `${did}#${UPDATE_KEY}`, seed: update, curve: 'secp256k1', passphrase: o.updatePassphrase, iterations: o.iterations,
    }),
    sidecar: sidecarData(genesisDocument),
    genesis: block,
  });
  return {
    alias: o.alias, did, keyId, network: n, cid: casCid(bytesToHex(hash)),
    files: { identity: paths.identity, updateKey: paths.updateKey, sidecar: paths.sidecar, genesis: paths.genesis },
  };
}

export interface Btcr2UpdateOptions {
  alias: string;
  /** The new DWN endpoint of #dwn. */
  dwn?: string;
  removeDwn?: boolean;
  /** The new mirror URLs of #pkg. */
  repos?: string[];
  updatePassphrase: string;
  env?: Record<string, string | undefined>;
  /** The Esplora API base URL for each network (config.json "esplora"). It replaces the default of that network. */
  esplora?: Btcr2DriverOptions['esplora'];
  fetch?: FetchLike;
}

export interface Btcr2UpdateResult {
  alias: string;
  did: string;
  /** The version of the DID document after the update. */
  versionId: number;
  /** The IPFS CID of the update file (a raw block). */
  cid: string;
  /** The Beacon Signal: the SHA-256 of the update file (hex). */
  signal: string;
  files: { identity: string; sidecar: string; update: string };
}

/** Writes a temp file first. Then a rename replaces the old file. */
function replaceFile(file: string, body: string, mode: number): void {
  writeFileSync(`${file}.tmp`, body, { mode });
  chmodSync(`${file}.tmp`, mode);
  renameSync(`${file}.tmp`, file);
}

const isRepo = (id: string) => /#pkg(-[0-9]+)?$/.test(id);
const urls = (endpoints: unknown) => (Array.isArray(endpoints) ? endpoints : [endpoints]).filter((u): u is string => typeof u === 'string');

/**
 * Signs a BTCR2 Update that changes the services #dwn and #pkg. Other services stay, the beacon too. The update goes into
 * the sidecar file and a new update file, and the identity keeps it as the pending update. The current state comes from
 * the sidecar file and the Beacon Signals that Esplora shows.
 */
export async function updateBtcr2(o: Btcr2UpdateOptions): Promise<Btcr2UpdateResult> {
  const paths = idPaths(o.alias, o.env);
  const identity = readIdentity(paths);
  if (!identity.btcr2) throw new Error(`${paths.identity}: the identity has no did:btcr2 genesis document`);
  if (o.dwn === undefined && !o.removeDwn && o.repos === undefined) throw new Error('nothing to update');
  if (o.removeDwn && o.dwn !== undefined) throw new Error('remove the DWN, or change it: not both');
  const { pending } = identity.btcr2;
  if (pending) {
    throw new Error(`the update to version ${pending.versionId} (CID ${pending.cid}) is not on Bitcoin yet: didpkg signs one update at a time`);
  }

  const sidecar = JSON.parse(readFileSync(paths.sidecar, 'utf8')) as Sidecar;
  const resolved = await btcr2Driver({ esplora: o.esplora, cas: [], sidecar: async () => sidecar, fetch: o.fetch })
    .resolve(identity.did, {}, { signal: AbortSignal.timeout(10_000) });
  if (!resolved.didDocument) {
    const detail = resolved.didResolutionMetadata.error?.detail;
    throw new Error(`cannot resolve the current document of ${identity.did} with ${paths.sidecar}: ${errorCode(resolved)}${detail ? ` (${detail})` : ''}`);
  }
  const source = resolved.didDocument as unknown as Btcr2DidDocument;
  const versionId = Number(resolved.didDocumentMetadata.versionId);

  const update = await decryptKey(JSON.parse(readFileSync(paths.updateKey, 'utf8')) as EncryptedKey, o.updatePassphrase);
  const method = `${identity.did}#${UPDATE_KEY}`;
  const publicKey = secp256k1.getPublicKey(update);
  const key = source.verificationMethod?.find((m) => m.id === method);
  if (key?.publicKeyMultibase !== toMultikey({ alg: 'secp256k1', bytes: publicKey })) {
    throw new Error(`${paths.updateKey}: the key is not ${method} of the current document`);
  }

  const services = (source.service ?? []) as unknown as { id: string; serviceEndpoint: unknown }[];
  const dwn = o.removeDwn ? undefined : (o.dwn ?? urls(services.find((s) => s.id === `${identity.did}#dwn`)?.serviceEndpoint)[0]);
  const repos = o.repos ?? services.filter((s) => isRepo(s.id)).flatMap((s) => urls(s.serviceEndpoint));
  const others = services.filter((s) => s.id !== `${identity.did}#dwn` && !isRepo(s.id));
  if (dwn === undefined && repos.length === 0) throw new Error('a did:btcr2 identity needs a DWN or a mirror URL');
  const patch: Parameters<typeof Updater.construct>[1] = [{ op: 'replace', path: '/service', value: [...others, ...servicesOf(identity.did, { dwn, repos })] }];

  const signer = {
    publicKey,
    sign(data: Uint8Array, scheme: string) {
      if (scheme !== 'bip340') throw new Error(`the update key makes no ${scheme} signature here`);
      return schnorr.sign(data, update);
    },
  };
  const signed = Updater.sign(source, Updater.construct(source, patch, versionId), method, signer as never);
  // The update file is the JCS form of the signed update. Its SHA-256 is the Beacon Signal, and the CID of the raw block.
  const block = canonicalize(signed)!;
  const hash = bytesToHex(sha256(new TextEncoder().encode(block)));
  const target = versionId + 1;
  const cid = casCid(hash);

  const file = paths.btcr2Update(target);
  replaceFile(file, block, 0o644);
  const updates = [...(sidecar.updates ?? []), signed];
  replaceFile(paths.sidecar, `${JSON.stringify({ ...sidecar, updates }, null, 2)}\n`, 0o644);
  const btcr2 = { ...identity.btcr2, pending: { versionId: target, cid, update: signed as unknown as Record<string, unknown> } };
  replaceFile(paths.identity, `${JSON.stringify({ ...identity, btcr2 }, null, 2)}\n`, 0o600);
  return { alias: o.alias, did: identity.did, versionId: target, cid, signal: hash, files: { identity: paths.identity, sidecar: paths.sidecar, update: file } };
}
