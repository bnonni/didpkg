// did:btcr2 driver (did:btcr2 spec, https://dcdpr.github.io/did-btcr2/). The resolver of @did-btcr2/method
// does no I/O, so the driver gives it the data. The `sidecar` option gives the sidecar data: the genesis
// document and the update data. CAS (IPFS) gives the items that the sidecar data does not have.
// An Esplora API for the network of the DID gives the beacon signals.
// The resolver checks the hashes, the signatures and the order of the updates.
// The Esplora API can hide a beacon signal, so the trust is partial.
import { BitcoinConnection, type HttpExecutor, type NetworkName } from '@did-btcr2/bitcoin';
import { BeaconSignalDiscovery, DidBtcr2, Identifier, type DataNeed, type Sidecar } from '@did-btcr2/method';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base32nopad } from '@scure/base';
import { DID_ERROR_CODES, failure, type DidErrorCode } from '../errors.ts';
import { fetchBytes, FetchError, SOURCE_TIMEOUT_MS, type FetchLike } from '../fetch.ts';
import type { DidDocument, DidDocumentMetadata, DidMethodDriver, DidResolutionResult } from '../types.ts';

export type { Sidecar } from '@did-btcr2/method';

/** The default Esplora API of each network (the @did-btcr2/api presets). regtest has no default. */
export const ESPLORA: Readonly<Partial<Record<NetworkName, string>>> = {
  bitcoin: 'https://mempool.space/api',
  testnet3: 'https://mempool.space/testnet/api',
  testnet4: 'https://mempool.space/testnet4/api',
  signet: 'https://mempool.space/signet/api',
  mutinynet: 'https://mutinynet.com/api',
};

/** A page of address transactions is larger than a DID document. */
const ESPLORA_MAX_BYTES = 1024 * 1024;

/** The default CAS: the IPFS Trustless Gateway of @did-btcr2/api. */
export const CAS_GATEWAYS: readonly string[] = ['https://trustless-gateway.link'];

/** A gateway that does not have a block finds it in the IPFS network first. @did-btcr2/api uses the same limit. */
const CAS_TIMEOUT_MS = 30_000;

/** A file in IPFS is one raw block (spec section BTCR2 Update Data Distribution). A block is 1 MB at most. */
const CAS_MAX_BYTES = 1024 * 1024;

/** The start of a CIDv1 with the raw codec and a SHA-256 multihash of 32 bytes. */
const CID_PREFIX = [0x01, 0x55, 0x12, 0x20];

export interface Btcr2DriverOptions {
  /** The Esplora API base URL for each network. It replaces the ESPLORA default of that network. */
  esplora?: Partial<Record<NetworkName, string>>;
  /** Gives the sidecar data of a DID, or undefined. */
  sidecar?: (did: string, signal: AbortSignal) => Promise<Sidecar | undefined>;
  /** IPFS Trustless Gateway base URLs, in order. The default is CAS_GATEWAYS. An empty list turns CAS off. */
  cas?: readonly string[];
  /** The minimum confirmations of a beacon signal. The default of the spec is 6. */
  minConf?: number;
  fetch?: FetchLike;
  /** The time limit of each request. The default is 5 s for Esplora and 30 s for CAS. */
  timeoutMs?: number;
  freshMs?: number;
  /** Allows a private Esplora or CAS host. Only for tests and regtest. */
  allowPrivateHosts?: boolean;
}

// The did:btcr2 spec (section Errors) gives the W3C error type that each did:btcr2 error refines.
const REFINES: Readonly<Record<string, DidErrorCode>> = {
  INVALID_DID_UPDATE: 'INVALID_DID_DOCUMENT',
  LATE_PUBLISHING: 'INVALID_DID_DOCUMENT',
  INVALID_SIGNAL_DATA: 'INVALID_OPTIONS',
  MISSING_UPDATE_DATA: 'NOT_FOUND',
  INVALID_DID_URL: 'INVALID_DID',
};
const W3C: ReadonlySet<string> = new Set(DID_ERROR_CODES);

export function btcr2Driver(options: Btcr2DriverOptions = {}): DidMethodDriver {
  const esplora = { ...ESPLORA, ...options.esplora };
  const cas = (options.cas ?? CAS_GATEWAYS).map((g) => g.replace(/\/+$/, ''));
  return {
    method: 'btcr2',
    verification: 'partial',
    history: true,
    freshMs: options.freshMs ?? 10 * 60_000,
    async resolve(did, resolutionOptions, ctx) {
      let source: string | undefined;
      try {
        const { network } = Identifier.decode(did);
        source = esplora[network as NetworkName]?.replace(/\/+$/, '');
        if (!source) return failure('INTERNAL_ERROR', `no Esplora API for the network ${network}`);
        const sidecar = await options.sidecar?.(did, ctx.signal);
        const resolver = DidBtcr2.resolve(did, {
          ...(sidecar && { sidecar }),
          ...(resolutionOptions.versionId !== undefined && { versionId: resolutionOptions.versionId }),
          ...(resolutionOptions.versionTime !== undefined && { versionTime: resolutionOptions.versionTime }),
          ...(options.minConf !== undefined && { minConf: options.minConf }),
        });
        const bitcoin = new BitcoinConnection({
          network: network as NetworkName,
          rest: { host: source },
          executor: executor(options, ctx.signal),
        });
        for (let state = resolver.resolve(); ; state = resolver.resolve()) {
          if (state.status === 'resolved') {
            const { didDocument, metadata } = state.result;
            return {
              didResolutionMetadata: { source, verification: 'partial' },
              didDocument: metadata.deactivated ? null : (JSON.parse(JSON.stringify(didDocument)) as DidDocument),
              didDocumentMetadata: { ...metadata } as DidDocumentMetadata,
            };
          }
          for (const need of state.needs) {
            if (need.kind === 'NeedBeaconSignals') {
              resolver.provide(need, await BeaconSignalDiscovery.indexer([...need.beaconServices], bitcoin));
              continue;
            }
            // The resolver asks only for the items that the sidecar data does not have (spec section Resolve).
            // CAS has no address for an SMT Proof.
            const casOn = cas.length > 0 && need.kind !== 'NeedSMTProof';
            const got = casOn ? await fromCas(hashOf(need), cas, options, ctx.signal) : { transient: false };
            if (!got.item) return missing(need, source, casOn, got.transient);
            // The resolver hashes the item again and compares the hash to the need.
            (resolver as unknown as { provide(need: ItemNeed, data: object): void }).provide(need, got.item);
          }
        }
      } catch (e) {
        return fromError(e, source);
      }
    },
  };
}

/** The Esplora requests go through fetchBytes, with its limits. */
function executor(options: Btcr2DriverOptions, signal: AbortSignal): HttpExecutor {
  return async (request) => {
    if (request.method !== 'GET') throw new FetchError(`the driver does not send ${request.method} requests`, false);
    const { status, body } = await fetchBytes(request.url, {
      fetch: options.fetch,
      signal,
      timeoutMs: options.timeoutMs ?? SOURCE_TIMEOUT_MS,
      maxBytes: ESPLORA_MAX_BYTES,
      allowPrivateHosts: options.allowPrivateHosts,
      noStore: request.fresh,
    });
    return new Response(body as Uint8Array<ArrayBuffer>, { status });
  };
}

type ItemNeed = Exclude<DataNeed, { kind: 'NeedBeaconSignals' }>;

const ITEMS: Readonly<Record<ItemNeed['kind'], string>> = {
  NeedGenesisDocument: 'genesis document',
  NeedSignedUpdate: 'BTCR2 Signed Update',
  NeedCASAnnouncement: 'CAS Announcement',
  NeedSMTProof: 'SMT Proof',
};

function hashOf(need: ItemNeed): string {
  switch (need.kind) {
    case 'NeedGenesisDocument': return need.genesisHash;
    case 'NeedSignedUpdate': return need.updateHash;
    case 'NeedCASAnnouncement': return need.announcementHash;
    case 'NeedSMTProof': return need.smtRootHash;
  }
}

/**
 * The file name of the Sidecar Data of a DID on a mirror and in a `dir:` target: `<method-specific id>.sidecar.json`.
 * The spec gives no transport for Sidecar Data, so this name is a didpkg rule. The name has more than 64 characters,
 * and a package name has 64 at most, so the file is never a package folder of the static layout.
 */
export function sidecarFile(did: string): string {
  Identifier.decode(did);
  return `${did.slice('did:btcr2:'.length)}.sidecar.json`;
}

/** The IPFS CIDv1 of a hex SHA-256 hash, in multibase base32 (spec section BTCR2 Update Data Distribution). */
export function casCid(hash: string): string {
  return `b${base32nopad.encode(Uint8Array.of(...CID_PREFIX, ...hexToBytes(hash))).toLowerCase()}`;
}

/**
 * Gets an item from CAS through the IPFS Trustless Gateway protocol: the raw block with the CIDv1 of the hash
 * (spec section BTCR2 Update Data Distribution). It tries the gateways in turn and stops at the first item.
 */
async function fromCas(hash: string, gateways: readonly string[], options: Btcr2DriverOptions, signal: AbortSignal): Promise<{ item?: object; transient: boolean }> {
  const cid = casCid(hash);
  let transient = false;
  for (const gateway of gateways) {
    try {
      const { status, body } = await fetchBytes(`${gateway}/ipfs/${cid}?format=raw`, {
        fetch: options.fetch,
        signal,
        timeoutMs: options.timeoutMs ?? CAS_TIMEOUT_MS,
        maxBytes: CAS_MAX_BYTES,
        allowPrivateHosts: options.allowPrivateHosts,
        accept: 'application/vnd.ipld.raw',
      });
      if (status === 429 || status >= 500) transient = true;
      // The spec: the resolver MUST NOT use the content if its hash is not the hash of the retrieval.
      if (status !== 200 || bytesToHex(sha256(body)) !== hash.toLowerCase()) continue;
      const item = jsonObject(body);
      if (item) return { item, transient };
    } catch (e) {
      if (!(e instanceof FetchError)) throw e;
      if (e.transient) transient = true;
    }
  }
  return { transient };
}

// RFC 8259, section 8.1: JSON text is UTF-8.
function jsonObject(bytes: Uint8Array): object | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// No source has the item. A NOT_FOUND after a transient CAS failure is transient.
function missing(need: ItemNeed, source: string, casOn: boolean, transient: boolean): DidResolutionResult {
  const text = `the ${ITEMS[need.kind]} with the hash ${hashOf(need)} is not in the sidecar data${casOn ? ' or CAS' : ''}`;
  const where = { source, ...(transient && { transient: true }) };
  if (need.kind === 'NeedGenesisDocument') return failure('NOT_FOUND', text, where);
  return failure('NOT_FOUND', `MISSING_UPDATE_DATA: ${text} (${need.beaconServiceId})`, where);
}

function fromError(e: unknown, source: string | undefined): DidResolutionResult {
  const where = source ? { source } : {};
  if (e instanceof FetchError) return failure('INTERNAL_ERROR', e.message, { ...where, ...(e.transient && { transient: true }) });
  const message = e instanceof Error ? e.message : String(e);
  const { type, data } = (e ?? {}) as { type?: unknown; data?: { status?: unknown } };
  if (type === 'FAILED_HTTP_REQUEST') {
    const status = Number(data?.status);
    return failure('INTERNAL_ERROR', message, { ...where, ...((status === 429 || status >= 500) && { transient: true }) });
  }
  if (typeof type !== 'string') return failure('INTERNAL_ERROR', message, where);
  if (W3C.has(type)) return failure(type as DidErrorCode, message, where);
  return failure(REFINES[type] ?? 'INTERNAL_ERROR', `${type}: ${message}`, where);
}
