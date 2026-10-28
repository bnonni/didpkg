// `didpkg id create` for did:dht (PLAN.md Phase 1 item 4 and Rules item 4).
// The identity key #0 is the DID update key: it signs the relay payload one time here, and then it goes cold.
// The did:dht spec puts #0 in assertionMethod, but the verifier refuses a release proof by #0.
// The release key #didpkg-1 is an Ed25519 JsonWebKey, because DWN JWS verification reads only publicKeyJwk.
import { createBep44PutMessage, DidDht, DidDhtDocument, identifierToIdentityKeyBytes, type DidService } from '@enbox/dids';
import { base64urlnopad } from '@scure/base';
import { DEFAULT_RELAYS } from '@didpkg/core/did/dht';
import { DwnWriter, ed25519MessageSigner } from '@didpkg/adapter-dwn/writer';
import { encryptKey } from './keyfile.ts';
import { ID_FORMAT, idPaths, writeIdentity, type Identity } from './store.ts';

export const RELEASE_KEY = 'didpkg-1';
export const REPOSITORY_TYPE = 'DIDPackageRepository';
const RELAY_TIMEOUT_MS = 10_000;

export interface CreateOptions {
  alias: string;
  /** A DWN endpoint: the service `#dwn` (type `DecentralizedWebNode`). The CLI installs the protocol there. */
  dwn?: string;
  /** Static mirror URLs: the service `#pkg` (type `DIDPackageRepository`). */
  repos?: string[];
  relays?: readonly string[];
  passphrase: string;
  updatePassphrase: string;
  env?: Record<string, string | undefined>;
  /** For tests only. */
  iterations?: number;
}

export interface StepResult { url: string; ok: boolean; error?: string }

export interface CreateResult {
  alias: string;
  did: string;
  keyId: string;
  files: { identity: string; updateKey: string };
  relays: StepResult[];
  dwn?: StepResult;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** An https URL, or an http URL on a loopback host (a local test stack). */
export function endpoint(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what}: ${JSON.stringify(value)} is not a URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error(`${what}: ${value} must use https (http only on a loopback host)`);
  }
  return value;
}

/** A keyless PUT of the stored relay payload. Pkarr relays check the BEP44 signature. */
export async function putPayload(relays: readonly string[], did: string, payload: Uint8Array): Promise<StepResult[]> {
  const id = did.slice('did:dht:'.length);
  return Promise.all(relays.map(async (url): Promise<StepResult> => {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/${id}`, {
        method: 'PUT', body: payload, headers: { 'content-type': 'application/pkarr.org/relays#payload' },
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      return res.ok ? { url, ok: true } : { url, ok: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { url, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }));
}

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function createDht(o: CreateOptions): Promise<CreateResult> {
  const paths = idPaths(o.alias, o.env);
  if (o.passphrase === o.updatePassphrase) throw new Error('the update key passphrase must not be the release key passphrase');
  const relays = (o.relays ?? DEFAULT_RELAYS).map((r) => endpoint(r, 'relay'));
  if (relays.length === 0) throw new Error('no relay');
  const services: DidService[] = [];
  if (o.dwn) services.push({ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: [endpoint(o.dwn, 'dwn')] });
  if (o.repos?.length) services.push({ id: 'pkg', type: REPOSITORY_TYPE, serviceEndpoint: o.repos.map((r) => endpoint(r, 'repo')) });

  // 1. The DID and the signed relay payload, in memory. Enbox refuses a DNS packet of more than 1000 bytes (BEP44).
  const bearer = await DidDht.create({
    options: { publish: false, verificationMethods: [{ algorithm: 'Ed25519', id: RELEASE_KEY, purposes: ['assertionMethod'] }], services },
  });
  const did = bearer.uri;
  const dnsPacket = await DidDhtDocument.toDnsPacket({ didDocument: bearer.document, didMetadata: bearer.metadata });
  const message = await createBep44PutMessage({
    dnsPacket, publicKeyBytes: identifierToIdentityKeyBytes({ didUri: did }), signer: await bearer.getSigner({ methodId: '0' }),
  });
  const payload = new Uint8Array(72 + message.v.length);
  payload.set(message.sig);
  new DataView(payload.buffer).setBigUint64(64, BigInt(message.seq));
  payload.set(message.v, 72);

  // 2. The two encrypted keys, on disk before any network write, so a published DID always has its keys.
  const { privateKeys = [] } = await bearer.export();
  const seedOf = (fragment: string) => {
    const vm = bearer.document.verificationMethod?.find((v) => v.id === `${did}#${fragment}`);
    const jwk = privateKeys.find((k) => k.x === vm?.publicKeyJwk?.x);
    if (vm?.type !== 'JsonWebKey' || !jwk?.d) throw new Error(`no Ed25519 JsonWebKey #${fragment} in the new DID`);
    return base64urlnopad.decode(jwk.d);
  };
  const keyId = `${did}#${RELEASE_KEY}`;
  const releaseSeed = seedOf(RELEASE_KEY);
  const releaseKey = await encryptKey({ did, keyId, seed: releaseSeed, passphrase: o.passphrase, iterations: o.iterations });
  const updateKey = await encryptKey({ did, keyId: `${did}#0`, seed: seedOf('0'), passphrase: o.updatePassphrase, iterations: o.iterations });
  const identity: Identity = {
    format: ID_FORMAT, alias: o.alias, did, created: new Date().toISOString(), document: bearer.document,
    relayPayload: base64urlnopad.encode(payload), releaseKey,
  };
  writeIdentity(paths, identity, updateKey);

  // 3. The network: the relays first, because the DWN resolves the DID before it accepts the protocol.
  const result: CreateResult = { alias: o.alias, did, keyId, files: { identity: paths.identity, updateKey: paths.updateKey }, relays: await putPayload(relays, did, payload) };
  if (o.dwn && result.relays.some((r) => r.ok)) {
    try {
      await new DwnWriter({ dwnUrl: o.dwn, did, signer: ed25519MessageSigner(releaseSeed, keyId) }).installProtocol();
      result.dwn = { url: o.dwn, ok: true };
    } catch (e) {
      result.dwn = { url: o.dwn, ok: false, error: errorOf(e) };
    }
  } else if (o.dwn) {
    result.dwn = { url: o.dwn, ok: false, error: 'no relay accepted the DID' };
  }
  return result;
}
