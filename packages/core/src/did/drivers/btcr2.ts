// did:btcr2 driver (did:btcr2 spec, https://dcdpr.github.io/did-btcr2/). The resolver of @did-btcr2/method
// does no I/O, so the driver gives it the data. The `sidecar` option gives the sidecar data: the genesis
// document and the update data. An Esplora API for the network of the DID gives the beacon signals.
// The resolver checks the hashes, the signatures and the order of the updates.
// The Esplora API can hide a beacon signal, so the trust is partial.
import { BitcoinConnection, type HttpExecutor, type NetworkName } from '@did-btcr2/bitcoin';
import { BeaconSignalDiscovery, DidBtcr2, Identifier, type DataNeed, type Sidecar } from '@did-btcr2/method';
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

export interface Btcr2DriverOptions {
  /** The Esplora API base URL for each network. It replaces the ESPLORA default of that network. */
  esplora?: Partial<Record<NetworkName, string>>;
  /** Gives the sidecar data of a DID, or undefined. */
  sidecar?: (did: string, signal: AbortSignal) => Promise<Sidecar | undefined>;
  /** The minimum confirmations of a beacon signal. The default of the spec is 6. */
  minConf?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  freshMs?: number;
  /** Allows a private Esplora host. Only for tests and regtest. */
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
            if (need.kind !== 'NeedBeaconSignals') return missing(need, source);
            resolver.provide(need, await BeaconSignalDiscovery.indexer([...need.beaconServices], bitcoin));
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

// The sidecar data does not have the item. CAS is not a source yet.
function missing(need: Exclude<DataNeed, { kind: 'NeedBeaconSignals' }>, source: string): DidResolutionResult {
  if (need.kind === 'NeedGenesisDocument') {
    return failure('NOT_FOUND', `the sidecar data has no genesis document with the hash ${need.genesisHash}`, { source });
  }
  const [item, hash] =
    need.kind === 'NeedSignedUpdate' ? ['BTCR2 Signed Update', need.updateHash]
    : need.kind === 'NeedCASAnnouncement' ? ['CAS Announcement', need.announcementHash]
    : ['SMT Proof', need.smtRootHash];
  return failure('NOT_FOUND', `MISSING_UPDATE_DATA: the sidecar data has no ${item} with the hash ${hash} (${need.beaconServiceId})`, { source });
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
