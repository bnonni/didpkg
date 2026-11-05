// `didpkg id create --plc` for did:plc (the DID PLC specification v0.3.0, section "DID Creation").
// The rotation key (secp256k1) signs the genesis operation. It is the DID update key. It is not a key of the document:
// the operation log lists it as a did:key in `rotationKeys`. Move the rotation key file offline.
// The release key #didpkg-1 is an Ed25519 did:key. The directory shows it as a Multikey, and the document has no
// assertionMethod. The didpkg verifier takes a `#didpkg-<n>` key of a did:plc document as an assertionMethod key.
// The POST to the directory is the one network write. The directory keeps the operation log public, and nobody can delete it.
// `didpkg id update` sends an update operation that changes the services (section "DID Update"). The rotation key signs it,
// and its `prev` is the CID of the last operation in the identity file. The files change only after the directory takes it.
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { encode } from '@ipld/dag-cbor';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as ed from '@noble/ed25519';
import { base64urlnopad } from '@scure/base';
import { cidOf, didOf, plcDriver } from '@didpkg/core/did/plc';
import { toMultikey } from '@didpkg/core/trust';
import { endpoint, RELEASE_KEY, REPOSITORY_TYPE, type StepResult } from './dht.ts';
import { decryptKey, encryptKey, type EncryptedKey } from './keyfile.ts';
import { ID_FORMAT, idPaths, readIdentity, writeIdentity, type Identity } from './store.ts';

// The limits of the plc.directory server (did-method-plc, packages/server/src/constraints.ts).
const MAX_OP_BYTES = 4000;
const MAX_SERVICES = 10;
const MAX_ENDPOINT_LENGTH = 512;
const DIRECTORY_TIMEOUT_MS = 15_000;

export type PlcOperation = Record<string, unknown>;
type PlcService = { type: string; endpoint: string };

export interface PlcCreateOptions {
  alias: string;
  /** The directory origin, for example `https://plc.directory`. */
  directory: string;
  /** A DWN endpoint: the service `#dwn` (type `DecentralizedWebNode`). */
  dwn?: string;
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

/** The service `#dwn` for the DWN URL, then the services `#pkg`, `#pkg-2`, ... for the repository URLs. */
function servicesOf(o: { dwn?: string; repos: string[] }): Record<string, PlcService> {
  if (o.dwn === undefined && o.repos.length === 0) throw new Error('a did:plc identity needs a --dwn URL or a --repo URL');
  const url = (value: string, what: string) => {
    if (endpoint(value, what).length > MAX_ENDPOINT_LENGTH) throw new Error(`${what}: the directory takes ${MAX_ENDPOINT_LENGTH} characters in a URL`);
    return value;
  };
  return {
    ...(o.dwn === undefined ? {} : { dwn: { type: 'DecentralizedWebNode', endpoint: url(o.dwn, 'dwn') } }),
    ...Object.fromEntries(o.repos.map((r, i) => [i === 0 ? 'pkg' : `pkg-${i + 1}`, { type: REPOSITORY_TYPE, endpoint: url(r, 'repo') }])),
  };
}

/** The limits of the directory for one signed operation. */
function checkLimits(op: PlcOperation): void {
  const services = Object.keys(op.services as Record<string, PlcService>).length;
  if (services > MAX_SERVICES) throw new Error(`the directory takes ${MAX_SERVICES} services, not ${services}`);
  const size = encode(op).length;
  if (size > MAX_OP_BYTES) throw new Error(`the operation has ${size} bytes, and the directory takes ${MAX_OP_BYTES}: use fewer --repo URLs`);
}

/** ECDSA-SHA256 over the DAG-CBOR of the operation without sig, with low S. The sig is base64url with no padding. */
function sign(op: PlcOperation, secret: Uint8Array): PlcOperation {
  return { ...op, sig: base64urlnopad.encode(secp256k1.sign(encode(op), secret, { prehash: true, lowS: true })) };
}

/** The document of the log of `ops`. The core driver checks each operation, as a resolver does. */
async function documentOf(did: string, ops: PlcOperation[]): Promise<Identity['document']> {
  const createdAt = new Date().toISOString();
  const log = ops.map((operation) => ({ did, operation, cid: cidOf(operation), nullified: false, createdAt }));
  const driver = plcDriver({ fetch: async () => new Response(JSON.stringify(log)) });
  const r = await driver.resolve(did, {}, { signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS) });
  if (!r.didDocument) throw new Error(`the operation log fails the did:plc checks: ${r.didResolutionMetadata.error}`);
  return r.didDocument as Identity['document'];
}

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** True if the operation log of the directory has `op`, and the directory did not nullify it. */
async function inLog(directory: string, did: string, op: PlcOperation, f: typeof fetch): Promise<boolean> {
  try {
    const res = await f(`${directory}/${did}/log/audit`, { signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS) });
    const log: unknown = res.ok ? await res.json() : null;
    const cid = cidOf(op);
    return Array.isArray(log) && log.some((e) => e?.nullified === false && cidOf(e.operation ?? {}) === cid);
  } catch {
    return false;
  }
}

/**
 * Sends a signed operation to the directory. A second POST of the same operation gets HTTP 400, because the log has
 * it. Thus a 400 is a success if the log of the directory has this operation.
 */
export async function postOperation(directory: string, did: string, op: PlcOperation, f: typeof fetch = fetch): Promise<StepResult> {
  const url = `${directory}/${did}`;
  try {
    const res = await f(url, {
      method: 'POST', body: JSON.stringify(op), headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
    });
    if (res.ok) return { url, ok: true };
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 400 && await inLog(directory, did, op, f)) return { url, ok: true };
    return { url, ok: false, error: `HTTP ${res.status}${text ? `: ${text}` : ''}` };
  } catch (e) {
    return { url, ok: false, error: errorOf(e) };
  }
}

export async function createPlc(o: PlcCreateOptions): Promise<PlcCreateResult> {
  const paths = idPaths(o.alias, o.env);
  const directory = endpoint(o.directory, '--plc').replace(/\/+$/, '');
  if (o.passphrase === o.updatePassphrase) throw new Error('the update key passphrase must not be the release key passphrase');
  const services = servicesOf(o);

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
  checkLimits(genesis);

  const did = didOf(genesis);
  const keyId = `${did}#${RELEASE_KEY}`;
  const identity: Identity = {
    format: ID_FORMAT, alias: o.alias, did, created: new Date().toISOString(), document: await documentOf(did, [genesis]),
    plc: { directory, genesis },
    releaseKey: await encryptKey({ did, keyId, seed: release.secretKey, passphrase: o.passphrase, iterations: o.iterations }),
  };
  writeIdentity(paths, identity, {
    updateKey: await encryptKey({
      did, keyId: `did:key:${rotationKey}#${rotationKey}`, seed: rotation, curve: 'secp256k1', passphrase: o.updatePassphrase, iterations: o.iterations,
    }),
  });
  return {
    alias: o.alias, did, keyId, directory: await postOperation(directory, did, genesis, o.fetch),
    files: { identity: paths.identity, updateKey: paths.updateKey },
  };
}

/** `didpkg id register` for did:plc: the POST of the stored genesis operation, again. */
export function registerPlc(identity: Identity, f: typeof fetch = fetch): Promise<StepResult> {
  if (!identity.plc) throw new Error(`${identity.alias}: the identity has no did:plc genesis operation`);
  return postOperation(identity.plc.directory, identity.did, identity.plc.genesis, f);
}

export interface PlcUpdateOptions {
  alias: string;
  /** Add the service #dwn, or change its URL. */
  dwn?: string;
  /** Remove the service #dwn. */
  removeDwn?: boolean;
  /** Replace the URLs of the services #pkg, #pkg-2, ... */
  repos?: string[];
  updatePassphrase: string;
  env?: Record<string, string | undefined>;
  /** For tests only. */
  fetch?: typeof fetch;
}

export interface PlcUpdateResult {
  alias: string;
  did: string;
  /** The CID of the new operation. */
  cid: string;
  /** The POST of the operation to the directory. */
  directory: StepResult;
  files: { identity: string };
}

const isRepo = (id: string) => /^pkg(-[0-9]+)?$/.test(id);
const repoNumber = (id: string) => (id === 'pkg' ? 1 : Number(id.slice('pkg-'.length)));

/** Sends an update operation that changes the services #dwn and #pkg, #pkg-2, ... Other services stay. */
export async function updatePlc(o: PlcUpdateOptions): Promise<PlcUpdateResult> {
  const paths = idPaths(o.alias, o.env);
  const identity = readIdentity(paths);
  if (!identity.plc) throw new Error(`${paths.identity}: the identity has no did:plc genesis operation`);
  if (o.dwn === undefined && !o.removeDwn && o.repos === undefined) throw new Error('nothing to update');
  if (o.removeDwn && o.dwn !== undefined) throw new Error('remove the DWN, or change it: not both');
  const { directory, genesis, updates = [] } = identity.plc;
  const last = updates.at(-1) ?? genesis;
  if (last.type !== 'plc_operation') throw new Error(`${paths.identity}: the last operation is not a plc_operation`);

  const rotation = await decryptKey(JSON.parse(readFileSync(paths.updateKey, 'utf8')) as EncryptedKey, o.updatePassphrase);
  const rotationKey = `did:key:${toMultikey({ alg: 'secp256k1', bytes: secp256k1.getPublicKey(rotation) })}`;
  if (!(last.rotationKeys as string[]).includes(rotationKey)) throw new Error(`${paths.updateKey}: the key is not a rotation key of ${identity.did}`);

  const services = last.services as Record<string, PlcService>;
  const repos = o.repos ?? Object.keys(services).filter(isRepo).sort((a, b) => repoNumber(a) - repoNumber(b)).map((id) => services[id]!.endpoint);
  const dwn = o.removeDwn ? undefined : (o.dwn ?? services.dwn?.endpoint);
  const others = Object.entries(services).filter(([id]) => id !== 'dwn' && !isRepo(id));
  const op = sign({
    ...Object.fromEntries(Object.entries(last).filter(([k]) => k !== 'sig')),
    services: { ...servicesOf({ dwn, repos }), ...Object.fromEntries(others) },
    prev: cidOf(last),
  }, rotation);
  checkLimits(op);
  const document = await documentOf(identity.did, [genesis, ...updates, op]);

  const directoryStep = await postOperation(directory, identity.did, op, o.fetch);
  if (!directoryStep.ok) throw new Error(`the directory did not take the operation (${directoryStep.error}), so no file changed`);
  // A temp file first, then a rename replaces the old identity file.
  const body = `${JSON.stringify({ ...identity, document, plc: { directory, genesis, updates: [...updates, op] } }, null, 2)}\n`;
  writeFileSync(`${paths.identity}.tmp`, body, { mode: 0o600 });
  chmodSync(`${paths.identity}.tmp`, 0o600);
  renameSync(`${paths.identity}.tmp`, paths.identity);
  return { alias: o.alias, did: identity.did, cid: cidOf(op), directory: directoryStep, files: { identity: paths.identity } };
}
