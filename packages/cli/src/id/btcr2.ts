// `didpkg id create --btcr2` for did:btcr2 (the did:btcr2 spec, sections "Create" and "Data Structures").
// The DID is an x1 identifier: the hash of a Genesis Document. Create makes no Bitcoin transaction and no network request.
// A resolver needs the Genesis Document. CAS (IPFS) or the Sidecar Data gives it.
// The update key #initialKey is a secp256k1 Multikey in capabilityInvocation: the spec takes only this key type for an update.
// The singleton beacon #initialP2WPKH is the P2WPKH address of the update key. An update spends a UTXO of this address.
// The release key #didpkg-1 is an Ed25519 Multikey in assertionMethod.
// The services #dwn and #pkg are in the Genesis Document: a change to them needs an update (a Beacon Signal).
import { getNetwork, type NetworkName } from '@did-btcr2/bitcoin';
import { BeaconUtils, DidBtcr2, ID_PLACEHOLDER_VALUE } from '@did-btcr2/method';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import { btcr2Driver, casCid } from '@didpkg/core/did/btcr2';
import { toMultikey } from '@didpkg/core/trust';
import { endpoint, RELEASE_KEY, REPOSITORY_TYPE } from './dht.ts';
import { encryptKey } from './keyfile.ts';
import { ID_FORMAT, idPaths, writeIdentity, type Identity } from './store.ts';

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
    service: [
      beacon,
      ...(o.dwn === undefined ? [] : [{ id: `${id}#dwn`, type: 'DecentralizedWebNode', serviceEndpoint: [endpoint(o.dwn, 'dwn')] }]),
      ...(o.repos.length === 0 ? [] : [{ id: `${id}#pkg`, type: REPOSITORY_TYPE, serviceEndpoint: o.repos.map((r) => endpoint(r, 'repo')) }]),
    ],
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
