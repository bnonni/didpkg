// The Sidecar Data of did:btcr2 for the shim. The spec gives no transport for Sidecar Data, so these sources are
// didpkg rules. The shim uses the first source that has the data of the DID:
//   1. the Sidecar Data file of a publisher identity in `<config>/ids/`;
//   2. each mirror in turn: `<mirror>/<method-specific id>.sidecar.json` (`--sidecar`, else "sidecar" in config.json);
//   3. the copy of the last verified resolve in `<config>/sidecar/`.
// The mirrors come before the copy, so an old copy does not hide a new update. The driver gets the items that the
// data does not have from CAS. The resolver checks each hash, so a source can hide data but cannot change it.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Identifier } from '@did-btcr2/method';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import { fetchBytes, FetchError, SOURCE_TIMEOUT_MS, type FetchLike } from '@didpkg/core/did';
import { sidecarFile, type Sidecar } from '@didpkg/core/did/btcr2';
import { ALIAS_RE, idPaths } from '../id/store.ts';

/** The size limit of an IPFS block. */
const MAX_BYTES = 1024 * 1024;

export interface SidecarSourceOptions {
  /** The config folder. With no folder, the shim reads and keeps no local copy. */
  home?: string;
  /** The mirror base URLs, in order. */
  mirrors?: readonly string[];
  fetch?: FetchLike;
  /** Allows a mirror on a private host. Only for tests and a local demo. */
  allowPrivateHosts?: boolean;
  log?: (line: string) => void;
}

export interface SidecarSource {
  /** The `sidecar` option of btcr2Driver. */
  get(did: string, signal: AbortSignal): Promise<Sidecar | undefined>;
  /** Call it after each resolve. If the resolve has no error, it keeps a copy of the mirror data. */
  settle(did: string, ok: boolean): void;
}

export function sidecarSource(o: SidecarSourceOptions = {}): SidecarSource {
  const mirrors = (o.mirrors ?? []).map((m) => m.replace(/\/+$/, ''));
  const log = (line: string) => o.log?.(`sidecar: ${line}`);
  const pending = new Map<string, Sidecar>();

  async function fromMirror(mirror: string, did: string, signal: AbortSignal): Promise<Sidecar | undefined> {
    const url = `${mirror}/${sidecarFile(did)}`;
    try {
      const { status, body } = await fetchBytes(url, {
        fetch: o.fetch, signal, timeoutMs: SOURCE_TIMEOUT_MS, maxBytes: MAX_BYTES, allowPrivateHosts: o.allowPrivateHosts, accept: 'application/json',
      });
      if (status === 404 || status === 410) return undefined;
      if (status !== 200) {
        log(`${url}: HTTP ${status}`);
        return undefined;
      }
      const data = jsonOf(body);
      if (fits(did, data)) return data;
      log(`${url}: not the Sidecar Data of ${did}`);
    } catch (e) {
      if (!(e instanceof FetchError) || signal.aborted) throw e;
      log(`${url}: ${e.message}`);
    }
    return undefined;
  }

  return {
    async get(did, signal) {
      pending.delete(did);
      const own = o.home === undefined ? undefined : publisherCopy(o.home, did, log);
      if (own) return own;
      for (const mirror of mirrors) {
        const data = await fromMirror(mirror, did, signal);
        if (data) {
          pending.set(did, data);
          return data;
        }
      }
      if (o.home === undefined) return undefined;
      const file = copyFile(o.home, did);
      const copy = readJson(file);
      if (copy === undefined || fits(did, copy)) return copy;
      log(`${file}: not the Sidecar Data of ${did}`);
      return undefined;
    },
    settle(did, ok) {
      const data = pending.get(did);
      pending.delete(did);
      if (!ok || !data || o.home === undefined) return;
      const file = copyFile(o.home, did);
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        mkdirSync(join(o.home, 'sidecar'), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
        renameSync(tmp, file);
      } catch (e) {
        log(`cannot keep ${file}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        rmSync(tmp, { force: true });
      }
    },
  };
}

const copyFile = (home: string, did: string) => join(home, 'sidecar', sidecarFile(did));

/** The `<alias>.sidecar.json` file of the identity with the DID, if it has one. */
function publisherCopy(home: string, did: string, log: (line: string) => void): Sidecar | undefined {
  let names: string[];
  try {
    names = readdirSync(join(home, 'ids'));
  } catch {
    return undefined;
  }
  for (const name of names) {
    const alias = name.slice(0, -'.json'.length);
    if (!name.endsWith('.json') || !ALIAS_RE.test(alias)) continue;
    const paths = idPaths(alias, { DIDPKG_HOME: home });
    if ((readJson(paths.identity) as { did?: unknown } | undefined)?.did !== did) continue;
    const data = readJson(paths.sidecar);
    if (fits(did, data)) return data;
    if (data !== undefined) log(`${paths.sidecar}: not the Sidecar Data of ${did}`);
  }
  return undefined;
}

function readJson(file: string): unknown {
  try {
    return jsonOf(readFileSync(file));
  } catch {
    return undefined;
  }
}

// RFC 8259, section 8.1: JSON text is UTF-8.
function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * A JSON object. For an x1 DID, the spec makes the Genesis Document necessary, and the SHA-256 of its JCS form
 * must be the genesis bytes of the DID (section "Process Sidecar Data"). Else the resolve fails with INVALID_DID,
 * and the next source cannot help.
 */
function fits(did: string, data: unknown): data is Sidecar {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const { idType, genesisBytes } = Identifier.decode(did);
  if (idType !== 'EXTERNAL') return true;
  const { genesisDocument } = data as { genesisDocument?: unknown };
  if (typeof genesisDocument !== 'object' || genesisDocument === null || Array.isArray(genesisDocument)) return false;
  return bytesToHex(sha256(new TextEncoder().encode(canonicalize(genesisDocument)!))) === bytesToHex(genesisBytes);
}
