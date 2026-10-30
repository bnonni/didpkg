// Network limits for the drivers: 5 s per source, 256 KB per
// response, https only, no private address, no redirect to another host.
// The private-address check sees only the URL. It does not resolve DNS names, because the core
// must also run in a browser. A server that resolves DIDs for others needs an egress filter too.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const SOURCE_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class FetchError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface FetchLimits {
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** `Infinity`: no own timer. Then only `signal` sets the time limit. */
  timeoutMs?: number;
  maxBytes?: number;
  /** Allows http and private addresses. Only for tests and local relays. */
  allowPrivateHosts?: boolean;
}

export interface FetchedBytes {
  status: number;
  url: string;
  body: Uint8Array;
}

/** GET a URL with the limits. A 4xx or 5xx status is a return value, not an error. */
export async function fetchBytes(url: string, limits: FetchLimits = {}): Promise<FetchedBytes> {
  const allowPrivate = !!limits.allowPrivateHosts;
  const timeoutMs = limits.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? MAX_RESPONSE_BYTES;
  const doFetch: FetchLike = limits.fetch ?? ((u, init) => fetch(u, init));
  const timeout = Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal = AbortSignal.any([limits.signal, timeout].filter((s) => s !== undefined));
  let current = checkUrl(url, allowPrivate);

  for (let hop = 0; ; hop++) {
    const host = current.host;
    try {
      const res = await doFetch(current.href, { method: 'GET', redirect: 'manual', signal });
      if (res.type === 'opaqueredirect') throw new FetchError(`${host}: the redirect target is not readable`, false);
      if (REDIRECTS.has(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) throw new FetchError(`${host}: HTTP ${res.status} with no Location`, false);
        const next = checkUrl(new URL(location, current).href, allowPrivate);
        if (next.host !== host || next.protocol !== current.protocol) {
          throw new FetchError(`${host}: a redirect to ${next.host} is not allowed`, false);
        }
        if (hop >= MAX_REDIRECTS) throw new FetchError(`${host}: more than ${MAX_REDIRECTS} redirects`, false);
        current = next;
        continue;
      }
      return { status: res.status, url: current.href, body: await readCapped(res, maxBytes, host) };
    } catch (e) {
      if (e instanceof FetchError) throw e;
      if (timeout?.aborted) throw new FetchError(`${host}: no response in ${timeoutMs} ms`, true);
      if (signal.aborted) throw new FetchError(`${host}: aborted`, true);
      throw new FetchError(`${host}: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
}

async function readCapped(res: Response, maxBytes: number, host: string): Promise<Uint8Array> {
  const tooLarge = () => new FetchError(`${host}: the response is larger than ${maxBytes} bytes`, false);
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function checkUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError(`not a URL: ${raw}`, false);
  }
  if (u.username || u.password) throw new FetchError(`${u.host}: a URL with credentials is not allowed`, false);
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) {
    throw new FetchError(`${u.host}: only https is allowed`, false);
  }
  if (!allowPrivate && isPrivateHost(u.hostname)) throw new FetchError(`${u.hostname}: a private address is not allowed`, false);
  return u;
}

/** true for localhost and for a literal private, loopback, link-local or reserved IP address. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.startsWith('[') && h.endsWith(']')) return isPrivateIpv6(h.slice(1, -1));
  const v4 = parseIpv4(h);
  return v4 ? isPrivateIpv4(v4) : false;
}

// The WHATWG URL parser writes every IPv4 form (hex, octal, short) as 4 decimal parts.
function parseIpv4(h: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m ? m.slice(1).map(Number) : undefined;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast and reserved
    (a === 100 && b >= 64 && b <= 127) || // shared address space (CGNAT)
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19)) // benchmarking
  );
}

// The WHATWG URL parser writes IPv6 in the compressed lowercase form, for example "::ffff:7f00:1".
function isPrivateIpv6(h: string): boolean {
  if (h === '::' || h === '::1') return true;
  if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('ff')) return true; // ULA, link-local, multicast
  const embedded = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h); // IPv4-mapped and IPv4-compatible
  if (embedded) {
    const hi = parseInt(embedded[1], 16);
    const lo = parseInt(embedded[2], 16);
    return isPrivateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return false;
}
