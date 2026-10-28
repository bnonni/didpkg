// Test fixtures for did/: a fake fetch and signed did:dht relay payloads. No network.
import { createBep44PutMessage, DidDht, DidDhtDocument, identifierToIdentityKeyBytes } from '@enbox/dids';
import type { FetchLike } from '../../src/did/fetch.ts';

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
