// `didpkg id create --plc` for did:plc (the DID PLC specification v0.3.0, section "DID Creation").
// The rotation key (secp256k1) signs the genesis operation. It is the DID update key. It is not a key of the document:
// the operation log lists it as a did:key in `rotationKeys`. Move the rotation key file offline.
// The release key #didpkg-1 is an Ed25519 did:key. The directory shows it as a Multikey, and the document has no
// assertionMethod. The didpkg verifier takes a `#didpkg-<n>` key of a did:plc document as an assertionMethod key.
// The POST to the directory is the one network write. The directory keeps the operation log public, and nobody can delete it.
import { encode } from '@ipld/dag-cbor';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as ed from '@noble/ed25519';
import { base64urlnopad } from '@scure/base';
import { cidOf, didOf, plcDriver } from '@didpkg/core/did/plc';
import { toMultikey } from '@didpkg/core/trust';
import { endpoint, RELEASE_KEY, REPOSITORY_TYPE, type StepResult } from './dht.ts';
import { encryptKey } from './keyfile.ts';
import { ID_FORMAT, idPaths, writeIdentity, type Identity } from './store.ts';

// The limits of the plc.directory server (did-method-plc, packages/server/src/constraints.ts).
const MAX_OP_BYTES = 4000;
const MAX_SERVICES = 10;
const MAX_ENDPOINT_LENGTH = 512;
const DIRECTORY_TIMEOUT_MS = 15_000;

export type PlcOperation = Record<string, unknown>;

export interface PlcCreateOptions {
  alias: string;
  /** The directory origin, for example `https://plc.directory`. */
  directory: string;
  /** Static mirror URLs: the services `#pkg`, `#pkg-2`, ... (type `DIDPackageRepository`). A did:plc service has 1 URL. */
  repos: string[];
  passphrase: string;
  updatePassphrase: string;
  env?: Record<string, string | undefined>;
  /** For tests only. */
  fetch?: typeof fetch;
  /** For tests only. */
  iterations?: number;
}

export interface PlcCreateResult {
  alias: string;
  did: string;
  keyId: string;
  /** The POST of the genesis operation to the directory. */
  directory: StepResult;
  files: { identity: string; updateKey: string };
}

/** The services `#pkg`, `#pkg-2`, ... for the repository URLs. */
function servicesOf(repos: string[]): Record<string, { type: string; endpoint: string }> {
  if (repos.length === 0) throw new Error('a did:plc identity needs a --repo URL');
  if (repos.length > MAX_SERVICES) throw new Error(`the directory takes ${MAX_SERVICES} services, not ${repos.length}`);
  return Object.fromEntries(repos.map((r, i) => {
    if (endpoint(r, 'repo').length > MAX_ENDPOINT_LENGTH) throw new Error(`repo: the directory takes ${MAX_ENDPOINT_LENGTH} characters in a URL`);
    return [i === 0 ? 'pkg' : `pkg-${i + 1}`, { type: REPOSITORY_TYPE, endpoint: r }];
  }));
}

/** ECDSA-SHA256 over the DAG-CBOR of the operation without sig, with low S. The sig is base64url with no padding. */
function sign(op: PlcOperation, secret: Uint8Array): PlcOperation {
  return { ...op, sig: base64urlnopad.encode(secp256k1.sign(encode(op), secret, { prehash: true, lowS: true })) };
}

/** The document of a one-entry log. The core driver checks the operation, as a resolver does. */
async function documentOf(did: string, op: PlcOperation): Promise<Identity['document']> {
  const log = [{ did, operation: op, cid: cidOf(op), nullified: false, createdAt: new Date().toISOString() }];
  const driver = plcDriver({ fetch: async () => new Response(JSON.stringify(log)) });
  const r = await driver.resolve(did, {}, { signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS) });
  if (!r.didDocument) throw new Error(`the genesis operation fails the did:plc checks: ${r.didResolutionMetadata.error}`);
  return r.didDocument as Identity['document'];
}

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** True if the operation log of the directory starts with `op`. */
async function hasGenesis(directory: string, did: string, op: PlcOperation, f: typeof fetch): Promise<boolean> {
  try {
    const res = await f(`${directory}/${did}/log/audit`, { signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS) });
    const log: unknown = res.ok ? await res.json() : null;
    return Array.isArray(log) && cidOf(log[0]?.operation ?? {}) === cidOf(op);
  } catch {
    return false;
  }
}

/**
 * Sends the signed genesis operation to the directory. A second POST of the same operation gets HTTP 400, because the
 * DID has a log. Thus a 400 is a success if the log of the directory starts with this operation.
 */
export async function postGenesis(directory: string, did: string, op: PlcOperation, f: typeof fetch = fetch): Promise<StepResult> {
  const url = `${directory}/${did}`;
  try {
    const res = await f(url, {
      method: 'POST', body: JSON.stringify(op), headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
    });
    if (res.ok) return { url, ok: true };
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 400 && await hasGenesis(directory, did, op, f)) return { url, ok: true };
    return { url, ok: false, error: `HTTP ${res.status}${text ? `: ${text}` : ''}` };
  } catch (e) {
    return { url, ok: false, error: errorOf(e) };
  }
}

export async function createPlc(o: PlcCreateOptions): Promise<PlcCreateResult> {
  const paths = idPaths(o.alias, o.env);
  const directory = endpoint(o.directory, '--plc').replace(/\/+$/, '');
  if (o.passphrase === o.updatePassphrase) throw new Error('the update key passphrase must not be the release key passphrase');
  const services = servicesOf(o.repos);

  const release = await ed.keygenAsync();
  const rotation = secp256k1.utils.randomSecretKey();
  const rotationKey = toMultikey({ alg: 'secp256k1', bytes: secp256k1.getPublicKey(rotation) });
  const genesis = sign({
    type: 'plc_operation',
    rotationKeys: [`did:key:${rotationKey}`],
    verificationMethods: { [RELEASE_KEY]: `did:key:${toMultikey({ alg: 'Ed25519', bytes: release.publicKey })}` },
    alsoKnownAs: [],
    services,
    prev: null,
  }, rotation);
  const size = encode(genesis).length;
  if (size > MAX_OP_BYTES) throw new Error(`the genesis operation has ${size} bytes, and the directory takes ${MAX_OP_BYTES}: use fewer --repo URLs`);

  const did = didOf(genesis);
  const keyId = `${did}#${RELEASE_KEY}`;
  const identity: Identity = {
    format: ID_FORMAT, alias: o.alias, did, created: new Date().toISOString(), document: await documentOf(did, genesis),
    plc: { directory, genesis },
    releaseKey: await encryptKey({ did, keyId, seed: release.secretKey, passphrase: o.passphrase, iterations: o.iterations }),
  };
  writeIdentity(paths, identity, {
    updateKey: await encryptKey({
      did, keyId: `did:key:${rotationKey}#${rotationKey}`, seed: rotation, curve: 'secp256k1', passphrase: o.updatePassphrase, iterations: o.iterations,
    }),
  });
  return {
    alias: o.alias, did, keyId, directory: await postGenesis(directory, did, genesis, o.fetch),
    files: { identity: paths.identity, updateKey: paths.updateKey },
  };
}

/** `didpkg id register` for did:plc: the POST of the stored genesis operation, again. */
export function registerPlc(identity: Identity, f: typeof fetch = fetch): Promise<StepResult> {
  if (!identity.plc) throw new Error(`${identity.alias}: the identity has no did:plc genesis operation`);
  return postGenesis(identity.plc.directory, identity.did, identity.plc.genesis, f);
}
