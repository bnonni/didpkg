// did:plc driver (did:plc spec v0.3.0). The directory keeps the operation log of each DID.
// The driver gets the audit log and checks it as the reference validateOperationLog does:
// the genesis hash, the prev chain, and a signature by a rotation key on each operation.
// Then it makes the document from the last operation, in the form that the directory gives.
// The directory can hide an operation or choose a fork, so the trust is partial.
import { encode } from '@ipld/dag-cbor';
import { p256 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base32nopad, base58, base64urlnopad } from '@scure/base';
import { failure } from '../errors.ts';
import { fetchBytes, FetchError, SOURCE_TIMEOUT_MS, type FetchLike } from '../fetch.ts';
import type { DidDocument, DidDocumentMetadata, DidMethodDriver, DidResolutionResult } from '../types.ts';

export const PLC_DIRECTORY = 'https://plc.directory';

export interface PlcDriverOptions {
  /** The directory origin. The default is https://plc.directory. */
  directory?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  freshMs?: number;
  /** Allows a private directory host. Only for tests. */
  allowPrivateHosts?: boolean;
}

const DID_RE = /^did:plc:[a-z2-7]{24}$/;
const DID_KEY_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// The two rotation key types, and the @context that the directory adds for each key type.
const KEY_TYPES = [
  { prefix: [0xe7, 0x01], curve: secp256k1, context: 'https://w3id.org/security/suites/secp256k1-2019/v1' },
  { prefix: [0x80, 0x24], curve: p256, context: 'https://w3id.org/security/suites/ecdsa-2019/v1' },
] as const;

type Op = Record<string, unknown>;

interface State {
  rotationKeys: string[];
  verificationMethods: Record<string, string>;
  alsoKnownAs: string[];
  services: Record<string, { type: string; endpoint: string }>;
}

class LogError extends Error {}

export function plcDriver(options: PlcDriverOptions = {}): DidMethodDriver {
  const directory = (options.directory ?? PLC_DIRECTORY).replace(/\/+$/, '');
  return {
    method: 'plc',
    verification: 'partial',
    history: false,
    freshMs: options.freshMs ?? 15 * 60_000,
    async resolve(did, _options, ctx) {
      if (!DID_RE.test(did)) return failure('INVALID_DID', 'a did:plc identifier has 24 lowercase base32 characters');
      const source = `${directory}/${did}/log/audit`;
      let status: number;
      let body: Uint8Array;
      try {
        ({ status, body } = await fetchBytes(source, {
          fetch: options.fetch,
          signal: ctx.signal,
          timeoutMs: options.timeoutMs ?? SOURCE_TIMEOUT_MS,
          allowPrivateHosts: options.allowPrivateHosts,
        }));
      } catch (e) {
        const transient = e instanceof FetchError ? e.transient : true;
        return failure('INTERNAL_ERROR', e instanceof Error ? e.message : String(e), { source, ...(transient && { transient }) });
      }
      if (status === 404 || status === 410) return failure('NOT_FOUND', `the directory gives HTTP ${status}`, { source });
      if (status === 429 || status >= 500) return failure('INTERNAL_ERROR', `the directory gives HTTP ${status}`, { source, transient: true });
      if (status < 200 || status >= 300) return failure('INTERNAL_ERROR', `the directory gives HTTP ${status}`, { source });
      try {
        const log = JSON.parse(new TextDecoder().decode(body)) as unknown;
        if (Array.isArray(log) && log.length === 0) return failure('NOT_FOUND', 'the audit log is empty', { source });
        return { didResolutionMetadata: { source, verification: 'partial' }, ...checkLog(did, log) };
      } catch (e) {
        return failure('INVALID_DID_DOCUMENT', e instanceof Error ? e.message : String(e), { source });
      }
    },
  };
}

// The audit log also has the nullified operations. The valid log is the operations that are not nullified.
function checkLog(did: string, log: unknown): Pick<DidResolutionResult, 'didDocument' | 'didDocumentMetadata'> {
  if (!Array.isArray(log)) throw new LogError('the audit log is not a JSON array');
  const valid = log.filter((entry: unknown, i) => {
    const e = entry as Record<string, unknown> | null;
    if (!isObject(e) || !isObject(e.operation) || typeof e.cid !== 'string' || typeof e.nullified !== 'boolean' || typeof e.createdAt !== 'string') {
      throw new LogError(`audit log entry ${i} does not have the operation, cid, nullified and createdAt fields`);
    }
    if (e.did !== did) throw new LogError(`audit log entry ${i} is for another DID`);
    return !e.nullified;
  }) as { operation: Op; cid: string; createdAt: string }[];

  let state: State | null = null;
  let prev = '';
  for (const [i, { operation: op, cid }] of valid.entries()) {
    if (i === 0) {
      if (op.prev !== null) throw new LogError('the genesis operation has a prev value');
      state = genesisState(op);
      if (didOf(op) !== did) throw new LogError('the hash of the genesis operation is not the DID');
    } else {
      if (state === null) throw new LogError(`operation ${i} comes after the tombstone`);
      if (op.prev !== prev) throw new LogError(`operation ${i} does not point to the operation before it`);
    }
    checkSignature(op, state!.rotationKeys, i);
    if (i > 0) state = op.type === 'plc_tombstone' ? null : opState(op, i);
    prev = cidOf(op);
    if (cid !== prev) throw new LogError(`operation ${i} has the cid ${cid}, not ${prev}`);
  }
  if (valid.length === 0) throw new LogError('the audit log has no valid operation');

  const didDocumentMetadata: DidDocumentMetadata = {};
  const created = seconds(valid[0]!.createdAt);
  const updated = seconds(valid.at(-1)!.createdAt);
  if (created) didDocumentMetadata.created = created;
  if (updated && valid.length > 1) didDocumentMetadata.updated = updated;
  if (state === null) return { didDocument: null, didDocumentMetadata: { ...didDocumentMetadata, deactivated: true } };
  return { didDocument: documentOf(did, state), didDocumentMetadata };
}

// A genesis operation is a regular operation or a legacy "create" operation.
function genesisState(op: Op): State {
  if (op.type === 'plc_operation') return opState(op, 0);
  if (op.type !== 'create') throw new LogError(`the genesis operation type is ${JSON.stringify(op.type)}`);
  const { signingKey, recoveryKey, handle, service } = op;
  if (!isDidKey(signingKey) || !isDidKey(recoveryKey) || typeof handle !== 'string' || typeof service !== 'string') {
    throw new LogError('the legacy create operation does not have the signingKey, recoveryKey, handle and service fields');
  }
  // The reference normalizeOp: the same order, prefixes and names.
  const aka = handle.startsWith('at://') ? handle : `at://${handle.replace('http://', '').replace('https://', '')}`;
  const endpoint = service.startsWith('http://') || service.startsWith('https://') ? service : `https://${service}`;
  return {
    rotationKeys: [recoveryKey, signingKey],
    verificationMethods: { atproto: signingKey },
    alsoKnownAs: [aka],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint } },
  };
}

function opState(op: Op, i: number): State {
  const bad = (field: string) => new LogError(`operation ${i}: ${field} is not valid`);
  if (op.type !== 'plc_operation') throw new LogError(`operation ${i} has the type ${JSON.stringify(op.type)}`);
  const { rotationKeys, verificationMethods, alsoKnownAs, services } = op;
  if (!Array.isArray(rotationKeys) || rotationKeys.length === 0 || !rotationKeys.every(isDidKey)) throw bad('rotationKeys');
  if (!isObject(verificationMethods) || !Object.values(verificationMethods).every(isDidKey)) throw bad('verificationMethods');
  if (!Array.isArray(alsoKnownAs) || !alsoKnownAs.every((a) => typeof a === 'string')) throw bad('alsoKnownAs');
  if (!isObject(services) || !Object.values(services).every((s) => isObject(s) && typeof s.type === 'string' && typeof s.endpoint === 'string')) {
    throw bad('services');
  }
  return { rotationKeys, verificationMethods, alsoKnownAs, services } as State;
}

// The spec: DAG-CBOR without the sig field, ECDSA-SHA256, low-S, 64 bytes, base64url with no padding.
function checkSignature(op: Op, rotationKeys: string[], i: number): void {
  const { sig, ...unsigned } = op;
  let signature: Uint8Array | undefined;
  try {
    if (typeof sig === 'string' && base64urlnopad.encode(base64urlnopad.decode(sig)) === sig) signature = base64urlnopad.decode(sig);
  } catch {
    // Not base64url.
  }
  if (signature?.length !== 64) throw new LogError(`operation ${i}: the sig value is not 64 bytes in strict base64url`);
  const data = encode(unsigned);
  for (const key of rotationKeys) {
    const parsed = parseKey(key);
    try {
      if (parsed?.type && parsed.type.curve.verify(signature, data, parsed.bytes, { prehash: true, lowS: true, format: 'compact' })) return;
    } catch {
      // A key that is not a curve point does not verify.
    }
  }
  throw new LogError(`operation ${i}: no rotation key signed it`);
}

function documentOf(did: string, state: State): DidDocument {
  const context = ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'];
  const verificationMethod = Object.entries(state.verificationMethods).map(([id, key]) => {
    const extra = parseKey(key)?.type?.context;
    if (extra && !context.includes(extra)) context.push(extra);
    return { id: `${did}#${id}`, type: 'Multikey', controller: did, publicKeyMultibase: key.slice('did:key:'.length) };
  });
  const service = Object.entries(state.services).map(([id, s]) => ({ id: `#${id}`, type: s.type, serviceEndpoint: s.endpoint }));
  return { '@context': context, id: did, alsoKnownAs: state.alsoKnownAs, verificationMethod, service };
}

/** did:plc:<the first 24 characters of base32(sha256(DAG-CBOR of the signed genesis operation))>. */
export function didOf(op: Op): string {
  return `did:plc:${base32nopad.encode(sha256(encode(op))).toLowerCase().slice(0, 24)}`;
}

/** CIDv1, dag-cbor (0x71), sha-256 (0x12), base32 multibase (b). */
export function cidOf(op: Op): string {
  return `b${base32nopad.encode(Uint8Array.of(0x01, 0x71, 0x12, 0x20, ...sha256(encode(op)))).toLowerCase()}`;
}

function parseKey(didKey: string) {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(didKey.slice('did:key:z'.length));
  } catch {
    return undefined;
  }
  const type = KEY_TYPES.find((t) => bytes[0] === t.prefix[0] && bytes[1] === t.prefix[1] && bytes.length === 35);
  return { type, bytes: bytes.subarray(2) };
}

function isDidKey(v: unknown): v is string {
  return typeof v === 'string' && DID_KEY_RE.test(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// DID Core 1.0 section 7.3.2: UTC, no fractional seconds.
function seconds(time: string): string | undefined {
  return TIME_RE.test(time) ? time.replace(/\.\d+Z$/, 'Z') : undefined;
}
