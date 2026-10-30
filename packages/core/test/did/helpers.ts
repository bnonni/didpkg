// Test fixtures for did/: a fake fetch, signed did:dht relay payloads and did:webvh logs. No network.
import { createBep44PutMessage, DidDht, DidDhtDocument, identifierToIdentityKeyBytes } from '@enbox/dids';
import * as ed from '@noble/ed25519';
import { base58 } from '@scure/base';
import { createDID, deactivateDID, defaultVerifier as verifier, prepareDataForSigning, updateDID, type DIDDocument, type DIDLog, type Signer } from 'didwebvh-ts';
import type { FetchLike } from '../../src/did/fetch.ts';
import { toMultikey } from '../../src/trust/keys.ts';

export type Route = (req: { url: string; init: RequestInit }) => Response | Promise<Response>;

/** A fetch that answers from a URL table. Other URLs get 404. It records each URL. */
export function fakeFetch(routes: Record<string, Route | Response>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (init.signal?.aborted) throw init.signal.reason;
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return typeof route === 'function' ? route({ url, init }) : (route.clone() as Response); // clone() has the undici type
  };
  return { fetch, calls };
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
  const releaseKey = toMultikey({ alg: 'Ed25519', bytes: (await ed.keygenAsync()).publicKey });
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
  return { did, log: created.log, doc: created.doc, releaseKey, url: `${base}/did.jsonl`, update: update2, deactivate, jsonl };
}

export const textResponse = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/jsonl' } });
