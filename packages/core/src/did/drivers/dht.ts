// did:dht driver. @enbox/dids 0.1.14 is only the codec, and this is the only
// file that imports it. The driver GETs the signed packet from each relay in parallel, with the
// network limits of fetch.ts. The valid packet with the highest seq wins.
// Relay payload (Pkarr relay spec): sig (64 bytes) || seq (8 bytes, big-endian) || v (DNS packet, max 1000 bytes).
import { fromDnsPacket, identifierToIdentityKeyBytes, parseBep44GetMessage } from '@enbox/dids';
import { failure, fromLibraryError } from '../errors.ts';
import { fetchBytes, FetchError, SOURCE_TIMEOUT_MS, type FetchLike } from '../fetch.ts';
import type { DidDocument, DidMethodDriver, DidResolutionResult } from '../types.ts';

export const DEFAULT_RELAYS: readonly string[] = ['https://relay.pkarr.org', 'https://pkarr.pubky.org'];
const MAX_V_BYTES = 1000;
const MAX_PAYLOAD_BYTES = 64 + 8 + MAX_V_BYTES;

export interface DhtDriverOptions {
  relays?: readonly string[];
  fetch?: FetchLike;
  timeoutMs?: number;
  freshMs?: number;
  /** Allows http and private relay addresses. Only for tests and local relays. */
  allowPrivateRelays?: boolean;
}

type Outcome =
  | { kind: 'ok'; seq: bigint; result: DidResolutionResult }
  | { kind: 'notFound' | 'invalid' | 'error'; detail: string };

export function dhtDriver(options: DhtDriverOptions = {}): DidMethodDriver {
  const relays = options.relays ?? DEFAULT_RELAYS;
  if (!relays.length) throw new Error('dhtDriver needs at least one relay');
  return {
    method: 'dht',
    verification: 'cryptographic',
    history: false,
    freshMs: options.freshMs ?? 15 * 60_000,
    async resolve(did, _options, ctx) {
      let k: Uint8Array;
      try {
        k = identifierToIdentityKeyBytes({ didUri: did });
      } catch (e) {
        return failure('INVALID_DID', fromLibraryError(e).didResolutionMetadata.error?.detail);
      }
      const id = did.slice('did:dht:'.length);
      const outcomes = await Promise.all(relays.map((relay) => fromRelay(relay, did, id, k, options, ctx.signal)));
      const ok = outcomes.flatMap((o) => (o.kind === 'ok' ? [o] : []));
      if (ok.length) return ok.reduce((a, b) => (b.seq > a.seq ? b : a)).result;
      const detail = outcomes.map((o, i) => `${relays[i]}: ${'detail' in o ? o.detail : 'ok'}`).join('; ');
      if (outcomes.some((o) => o.kind === 'error')) return failure('INTERNAL_ERROR', detail, { transient: true });
      if (outcomes.some((o) => o.kind === 'invalid')) return failure('INVALID_DID_DOCUMENT', detail);
      return failure('NOT_FOUND', detail);
    },
  };
}

async function fromRelay(relay: string, did: string, id: string, k: Uint8Array, o: DhtDriverOptions, signal: AbortSignal): Promise<Outcome> {
  let status: number;
  let body: Uint8Array;
  try {
    const url = new URL(id, relay.endsWith('/') ? relay : `${relay}/`).href;
    ({ status, body } = await fetchBytes(url, {
      fetch: o.fetch,
      signal,
      timeoutMs: o.timeoutMs ?? SOURCE_TIMEOUT_MS,
      maxBytes: MAX_PAYLOAD_BYTES,
      allowPrivateHosts: o.allowPrivateRelays,
    }));
  } catch (e) {
    const transient = e instanceof FetchError ? e.transient : true;
    return { kind: transient ? 'error' : 'invalid', detail: e instanceof Error ? e.message : String(e) };
  }
  if (status === 404) return { kind: 'notFound', detail: 'HTTP 404' };
  if (status !== 200) return { kind: 'error', detail: `HTTP ${status}` };
  if (body.length < 72) return { kind: 'invalid', detail: `the payload has ${body.length} bytes` };

  const seq = new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(64);
  if (seq > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: 'invalid', detail: `seq ${seq} is too large` };
  try {
    // parseBep44GetMessage checks the Ed25519 signature with the key in the DID.
    const dnsPacket = await parseBep44GetMessage({ bep44Message: { k, seq: Number(seq), sig: body.slice(0, 64), v: body.slice(72) } });
    const decoded = await fromDnsPacket({ didUri: did, dnsPacket });
    const types = (decoded.didDocumentMetadata as { types?: unknown }).types;
    return {
      kind: 'ok',
      seq,
      result: {
        didResolutionMetadata: { source: relay, verification: 'cryptographic' },
        didDocument: decoded.didDocument as unknown as DidDocument,
        didDocumentMetadata: { versionId: String(seq), updated: seqTime(seq), ...(types !== undefined && { types }) },
      },
    };
  } catch (e) {
    return { kind: 'invalid', detail: e instanceof Error ? e.message : String(e) };
  }
}

// The did:dht spec puts seconds in seq. Native Pkarr clients put microseconds.
function seqTime(seq: bigint): string {
  const n = Number(seq);
  const seconds = n > 1e12 ? Math.floor(n / 1e6) : n;
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
