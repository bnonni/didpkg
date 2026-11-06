// Test fixtures for did/: a fake fetch, signed did:dht relay payloads, did:webvh logs, did:plc audit logs,
// and did:btcr2 sidecar data with a fake Esplora API. No network.
import { DidBtcr2, type Btcr2DidDocument, type Sidecar, type SignedBTCR2Update } from '@did-btcr2/method';
import { createBep44PutMessage, DidDht, DidDhtDocument, identifierToIdentityKeyBytes } from '@enbox/dids';
import { encode } from '@ipld/dag-cbor';
import { p256 } from '@noble/curves/nist.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as ed from '@noble/ed25519';
import { base58, base64urlnopad } from '@scure/base';
import { createDID, deactivateDID, defaultVerifier as verifier, prepareDataForSigning, updateDID, type DIDDocument, type DIDLog, type Signer } from 'didwebvh-ts';
import canonicalize from 'canonicalize';
import { cidOf, didOf } from '../../src/did/drivers/plc.ts';
import type { FetchLike } from '../../src/did/fetch.ts';
import type { DidDocument, Service } from '../../src/did/types.ts';
import { toMultikey } from '../../src/trust/keys.ts';

export type Route = (req: { url: string; init: RequestInit }) => Response | Promise<Response>;

/** A fetch that answers from a URL table. Other URLs get 404. It records each URL, and it gives the table. */
export function fakeFetch(routes: Record<string, Route | Response>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (init.signal?.aborted) throw init.signal.reason;
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return typeof route === 'function' ? route({ url, init }) : (route.clone() as Response); // clone() has the undici type
  };
  return { fetch, calls, routes };
}

/** A fetch that never answers until the signal aborts. */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

export const SERVICE_TYPE = 'DIDPackageRepository';

/** A did:dht with a release key #didpkg-1 and a #pkg service. `payload(seq)` signs the relay payload. */
export async function dhtFixture(endpoints: string[] = ['https://pkg.example.com/']) {
  const bearer = await DidDht.create({
    options: {
      publish: false,
      verificationMethods: [{ algorithm: 'Ed25519', id: 'didpkg-1', purposes: ['assertionMethod'] }],
      services: [{ id: 'pkg', type: SERVICE_TYPE, serviceEndpoint: endpoints }],
    },
  });
  const dnsPacket = await DidDhtDocument.toDnsPacket({ didDocument: bearer.document, didMetadata: bearer.metadata });
  const signer = await bearer.getSigner({ methodId: '0' });
  const message = await createBep44PutMessage({ dnsPacket, publicKeyBytes: identifierToIdentityKeyBytes({ didUri: bearer.uri }), signer });
  const id = bearer.uri.slice('did:dht:'.length);

  async function payload(seq: number | bigint = message.seq, v: Uint8Array = message.v): Promise<Uint8Array> {
    const prefix = new TextEncoder().encode(`3:seqi${seq}e1:v${v.length}:`);
    const signed = new Uint8Array(prefix.length + v.length);
    signed.set(prefix);
    signed.set(v, prefix.length);
    const sig = await signer.sign({ data: signed });
    const out = new Uint8Array(72 + v.length);
    out.set(sig);
    new DataView(out.buffer).setBigUint64(64, BigInt(seq));
    out.set(v, 72);
    return out;
  }
  return { did: bearer.uri, id, bearer, document: bearer.document, seq: message.seq, v: message.v, payload };
}

export const bytesResponse = (b: Uint8Array) => new Response(b, { headers: { 'content-type': 'application/pkarr.org/relays#payload' } });
export const jsonResponse = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/**
 * A did:webvh with one Ed25519 update key, a release key #didpkg-1 and a #pkg service.
 * `url` is the log URL. `jsonl(log)` gives the body of the log file.
 */
export async function webvhFixture(address = 'pkg.example.com', paths?: string[]) {
  const update = await ed.keygenAsync();
  const updateKey = toMultikey({ alg: 'Ed25519', bytes: update.publicKey });
  const signer: Signer = {
    getVerificationMethodId: () => `did:key:${updateKey}#${updateKey}`,
    async sign({ document, proof }) {
      const data = await prepareDataForSigning(document, proof);
      return { proofValue: 'z' + base58.encode(await ed.signAsync(data, update.secretKey)) };
    },
  };
  const release = await ed.keygenAsync();
  const releaseKey = toMultikey({ alg: 'Ed25519', bytes: release.publicKey });
  const document = (endpoint: string): DIDDocument => ({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: '{DID}',
    verificationMethod: [{ id: '{DID}#didpkg-1', type: 'Multikey', controller: '{DID}', publicKeyMultibase: releaseKey }],
    assertionMethod: ['{DID}#didpkg-1'],
    service: [{ id: '{DID}#pkg', type: SERVICE_TYPE, serviceEndpoint: endpoint }],
  });
  const created = await createDID({ address, paths, signer, verifier, updateKeys: [updateKey], didDocument: document('https://pkg.example.com/') });
  const did = created.did;
  const base = `https://${address}${paths?.length ? `/${paths.join('/')}` : '/.well-known'}`;

  /** Adds a log entry that moves the #pkg service to `endpoint`. */
  const update2 = async (log: DIDLog, endpoint: string) => {
    const doc = JSON.parse(JSON.stringify(document(endpoint)).replaceAll('{DID}', did)) as DIDDocument;
    return (await updateDID({ log, signer, verifier, didDocument: doc })).log;
  };
  const deactivate = async (log: DIDLog) => (await deactivateDID({ log, signer, verifier })).log;
  const jsonl = (log: DIDLog) => log.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return { did, log: created.log, doc: created.doc, releaseKey, releaseSecret: release.secretKey, url: `${base}/did.jsonl`, update: update2, deactivate, jsonl };
}

export const textResponse = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/jsonl' } });

type PlcOp = Record<string, unknown>;

/**
 * A did:plc with a P-256 recovery key and a secp256k1 rotation key (in this order), a release key #didpkg-1
 * and a #pkg service. `log` is in the audit log form of the directory. `url` is the audit log URL.
 */
export async function plcFixture() {
  const keys = {
    recovery: { curve: p256, prefix: [0x80, 0x24], secret: p256.utils.randomSecretKey() },
    rotation: { curve: secp256k1, prefix: [0xe7, 0x01], secret: secp256k1.utils.randomSecretKey() },
    other: { curve: secp256k1, prefix: [0xe7, 0x01], secret: secp256k1.utils.randomSecretKey() },
  };
  const didKey = (k: (typeof keys)['rotation']) => `did:key:z${base58.encode(Uint8Array.of(...k.prefix, ...k.curve.getPublicKey(k.secret)))}`;
  const release = await ed.keygenAsync();
  const releaseKey = toMultikey({ alg: 'Ed25519', bytes: release.publicKey });
  /** DAG-CBOR without sig, ECDSA-SHA256 with low S, base64url with no padding. */
  const sign = (op: PlcOp, key: keyof typeof keys = 'rotation'): PlcOp => {
    const { sig: _, ...unsigned } = op;
    const k = keys[key];
    return { ...unsigned, sig: base64urlnopad.encode(k.curve.sign(encode(unsigned), k.secret, { prehash: true, lowS: true })) };
  };
  const operation = (endpoint: string, prev: string | null): PlcOp => ({
    type: 'plc_operation',
    rotationKeys: [didKey(keys.recovery), didKey(keys.rotation)],
    verificationMethods: { 'didpkg-1': `did:key:${releaseKey}` },
    alsoKnownAs: ['at://pkg.example.com'],
    services: { pkg: { type: SERVICE_TYPE, endpoint } },
    prev,
  });
  const genesis = sign(operation('https://pkg.example.com/', null));
  const did = didOf(genesis);
  let day = 0;
  const entry = (op: PlcOp, nullified = false) => ({
    did,
    operation: op,
    cid: cidOf(op),
    nullified,
    createdAt: `2026-01-${String(++day).padStart(2, '0')}T00:00:00.${String(day).padStart(3, '0')}Z`,
  });
  type Entry = ReturnType<typeof entry>;
  const head = (log: Entry[]) => log.filter((e) => !e.nullified).at(-1)!.cid;
  /** Adds an operation that moves the #pkg service to `endpoint`. */
  const update = (log: Entry[], endpoint: string, key: keyof typeof keys = 'rotation') => [...log, entry(sign(operation(endpoint, head(log)), key))];
  const tombstone = (log: Entry[]) => [...log, entry(sign({ type: 'plc_tombstone', prev: head(log) }))];
  return { did, log: [entry(genesis)], releaseKey, releaseSecret: release.secretKey, url: `https://plc.directory/${did}/log/audit`, sign, operation, entry, update, tombstone };
}

export const BTCR2_ESPLORA = 'https://mempool.space/testnet4/api';
const BTCR2_PAGE = 25; // ESPLORA_CHAIN_PAGE_SIZE of @did-btcr2/bitcoin

export interface Btcr2Signal { address: string; txid: string; blockHeight: number; blockHash: string; blockTime: number; mediantime: number; signalBytes: string }

/**
 * A testnet4 x1 did:btcr2 with a #pkg service in the genesis document, and one signed update that adds #pkg-2.
 * The update is in a beacon signal at the P2PKH beacon address. `esplora(signals)` is a fake Esplora API.
 * With `release`, the genesis document also has the Ed25519 release key #didpkg-1 in assertionMethod, as a didpkg publisher.
 */
export async function btcr2Fixture(o: { release?: boolean } = {}) {
  const secret = secp256k1.utils.randomSecretKey();
  const signer = {
    publicKey: secp256k1.getPublicKey(secret),
    sign(data: Uint8Array, scheme: string) {
      if (scheme !== 'bip340') throw new Error(`no ${scheme} signatures`);
      return schnorr.sign(data, secret);
    },
  };
  // The genesis document is the k1 document of the key with the placeholder id, and a #pkg service.
  const k1 = DidBtcr2.create(signer.publicKey, { idType: 'KEY', network: 'testnet4' });
  const k1Doc = await resolveOffline(k1, {});
  const genesisDocument = JSON.parse(JSON.stringify(k1Doc).replaceAll(k1, 'did:btcr2:_')) as { verificationMethod: object[]; assertionMethod: string[]; service: Service[] };
  genesisDocument.service.push({ id: 'did:btcr2:_#pkg', type: SERVICE_TYPE, serviceEndpoint: 'https://pkg.example.com/' });
  const release = await ed.keygenAsync();
  if (o.release) {
    const publicKeyMultibase = toMultikey({ alg: 'Ed25519', bytes: release.publicKey });
    genesisDocument.verificationMethod.push({ id: 'did:btcr2:_#didpkg-1', type: 'Multikey', controller: 'did:btcr2:_', publicKeyMultibase });
    genesisDocument.assertionMethod.push('did:btcr2:_#didpkg-1');
  }
  const did = DidBtcr2.create(sha256(new TextEncoder().encode(canonicalize(genesisDocument)!)), { idType: 'EXTERNAL', network: 'testnet4' });
  const genesis = await resolveOffline(did, { sidecar: { genesisDocument } });

  const updater = DidBtcr2.update({
    sourceDocument: genesis,
    patches: [{ op: 'add', path: '/service/-', value: { id: `${did}#pkg-2`, type: SERVICE_TYPE, serviceEndpoint: 'https://mirror.example.com/' } }],
    sourceVersionId: 1,
    verificationMethodId: `${did}#initialKey`,
    beaconId: `${did}#initialP2PKH`,
  });
  let update: SignedBTCR2Update | undefined;
  for (let state = updater.advance(); state.status === 'action-required' && !update; state = updater.advance()) {
    for (const need of state.needs) {
      if (need.kind === 'NeedSigningKey') updater.provide(need, signer as never);
      else if (need.kind === 'NeedFunding') updater.provide(need, { utxoCount: 1 });
      else update = need.signedUpdate;
    }
  }
  if (!update) throw new Error('the updater gave no signed update');

  const address = String(genesis.service!.find((s) => s.id === `${did}#initialP2PKH`)!.serviceEndpoint).slice('bitcoin:'.length);
  const signal: Btcr2Signal = {
    address,
    txid: '22'.repeat(32),
    blockHeight: 150_000,
    blockHash: '00'.repeat(4) + '33'.repeat(28),
    blockTime: 1_789_000_000,
    mediantime: 1_788_999_000,
    signalBytes: bytesToHex(sha256(new TextEncoder().encode(canonicalize(update)!))),
  };
  const tip = 150_009;
  const beacons = genesis.service!.filter((s) => String(s.serviceEndpoint).startsWith('bitcoin:')).map((s) => String(s.serviceEndpoint).slice(8));
  const esplora = (signals: Btcr2Signal[] = [signal], extra: Record<string, Route | Response> = {}) => {
    const routes: Record<string, Route | Response> = { [`${BTCR2_ESPLORA}/blocks/tip/height`]: new Response(String(tip)) };
    for (const a of beacons) routes[`${BTCR2_ESPLORA}/address/${a}/txs/chain?max_txs=${BTCR2_PAGE}`] = jsonResponse([]);
    for (const s of signals) {
      routes[`${BTCR2_ESPLORA}/address/${s.address}/txs/chain?max_txs=${BTCR2_PAGE}`] = jsonResponse([{
        txid: s.txid,
        status: { confirmed: true, block_height: s.blockHeight, block_hash: s.blockHash, block_time: s.blockTime },
        vin: [{ txid: '11'.repeat(32), vout: 0, prevout: { scriptpubkey_address: s.address } }],
        vout: [{ scriptpubkey: `6a20${s.signalBytes}`, value: 0 }],
      }]);
      routes[`${BTCR2_ESPLORA}/block/${s.blockHash}`] = jsonResponse({ id: s.blockHash, height: s.blockHeight, mediantime: s.mediantime });
    }
    return fakeFetch({ ...routes, ...extra });
  };
  return { did, k1, genesisDocument, update, signal, tip, esplora, releaseSecret: release.secretKey };
}

/** Resolves with the library alone. Each beacon address has no signal. */
async function resolveOffline(did: string, options: { sidecar?: Sidecar }) {
  const resolver = DidBtcr2.resolve(did, options);
  for (let state = resolver.resolve(); ; state = resolver.resolve()) {
    if (state.status === 'resolved') return state.result.didDocument as unknown as DidDocument & Btcr2DidDocument;
    for (const need of state.needs) {
      if (need.kind !== 'NeedBeaconSignals') throw new Error(`the offline resolver needs ${need.kind}`);
      resolver.provide(need, new Map(need.beaconServices.map((s) => [s, []])));
    }
  }
}
