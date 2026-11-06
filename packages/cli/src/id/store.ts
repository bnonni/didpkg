// The identity files in `<config>/ids/`. Each file has mode 0600, and the folder has mode 0700.
//   <alias>.json             the public data and the encrypted release key #didpkg-1. `didpkg publish` reads only this file.
//   <alias>.update-key.json  the encrypted DID update key (#0 for did:dht, a did:key for did:webvh, the secp256k1 rotation
//                            key for did:plc, the secp256k1 #initialKey for did:btcr2). Move it offline. Only `didpkg id update` reads it.
//   <alias>.did.json         the did.json to host (mode 0644): the did:web document, or the parallel did:web document of did:webvh.
//   <alias>.did.jsonl        the DID log for the publisher to host (did:webvh only, mode 0644).
//   <alias>.sidecar.json     the Sidecar Data with the Genesis Document (did:btcr2 only, mode 0644).
//   <alias>.genesis.json     the JCS bytes of the Genesis Document: the raw block to put in CAS (did:btcr2 only, mode 0644).
//   <alias>.update-<v>.json  the JCS bytes of the BTCR2 Signed Update to version <v>: the raw block to put in CAS (did:btcr2 only, mode 0644).
// A did:key or did:jwk publisher (key.ts) has only <alias>.json, with the DWN URLs: its DID document has no services.
// A XID publisher (xid.ts) has other files:
//   <alias>.json                 the signed XID document and the locked release and DWN keys.
//   <alias>.update-key.envelope  the XID document with the locked inception key and provenance generator. Move it offline.
//   <alias>.xid.envelope         the signed XID document to host (mode 0644).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DidDocument } from '@enbox/dids';
import { KEY_FORMAT, type EncryptedKey } from './keyfile.ts';

export const ID_FORMAT = 'didpkg-id-1';
/** The format of the identity file of a XID publisher. */
export const XID_ID_FORMAT = 'didpkg-xid-1';
export const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface Identity {
  format: typeof ID_FORMAT;
  alias: string;
  did: string;
  created: string;
  document: DidDocument;
  /** The signed did:dht relay payload (base64url). A keyless re-PUT sends these exact bytes. did:dht only. */
  relayPayload?: string;
  /**
   * The directory, the signed genesis operation, and the signed update operations that the directory took, in log order.
   * `didpkg id register` sends the genesis operation again. did:plc only.
   */
  plc?: { directory: string; genesis: Record<string, unknown>; updates?: Record<string, unknown>[] };
  /**
   * The network and the Genesis Document. A resolver needs the Genesis Document of an x1 DID. did:btcr2 only.
   * `pending` is the signed update that Bitcoin does not show yet. Its Beacon Signal (the SHA-256 of `update`) must be the
   * only signal to `versionId`: two different updates to one version make the DID invalid (LATE_PUBLISHING).
   */
  btcr2?: {
    network: string;
    genesisDocument: Record<string, unknown>;
    pending?: { versionId: number; cid: string; update: Record<string, unknown> };
  };
  /** The DWN URLs. The DID document has no services, so a consumer gives one of them to the shim. did:key and did:jwk only. */
  dwn?: string[];
  releaseKey: EncryptedKey;
}

/** A did:key or did:jwk DID: the DID holds the key, and the DID document has no services. */
export const isKeyDid = (did: string) => did.startsWith('did:key:') || did.startsWith('did:jwk:');

/** The URLs of the DecentralizedWebNode services of the DID document, then the DWN URLs of a did:key or did:jwk identity. */
export function dwnUrlsOf(identity: Identity): string[] {
  const services = (identity.document.service ?? []).filter((s) => s.type === 'DecentralizedWebNode').flatMap((s) => s.serviceEndpoint);
  return [...services, ...(identity.dwn ?? [])].filter((u): u is string => typeof u === 'string');
}

/** `$DIDPKG_HOME`, else `$XDG_CONFIG_HOME/didpkg`, else `~/.config/didpkg`. */
export function configDir(env: Record<string, string | undefined> = process.env): string {
  if (env.DIDPKG_HOME) return env.DIDPKG_HOME;
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'didpkg');
}

export function idPaths(alias: string, env: Record<string, string | undefined> = process.env) {
  if (!ALIAS_RE.test(alias)) throw new Error(`bad alias ${JSON.stringify(alias)}: use 1-63 of a-z, 0-9 and "-"`);
  const dir = join(configDir(env), 'ids');
  return {
    dir, identity: join(dir, `${alias}.json`), updateKey: join(dir, `${alias}.update-key.json`), document: join(dir, `${alias}.did.json`),
    log: join(dir, `${alias}.did.jsonl`), sidecar: join(dir, `${alias}.sidecar.json`), genesis: join(dir, `${alias}.genesis.json`),
    xidUpdate: join(dir, `${alias}.update-key.envelope`), xidDocument: join(dir, `${alias}.xid.envelope`),
    btcr2Update: (versionId: number) => join(dir, `${alias}.update-${versionId}.json`),
  };
}

type Paths = ReturnType<typeof idPaths>;
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Writes the identity file last. Before it: the encrypted update key (did:dht, did:webvh, did:plc, did:btcr2), the did.json
 * to host (did:web, did:webvh), the did.jsonl to host (did:webvh), and the sidecar and genesis files (did:btcr2).
 * It never replaces a file, because a replaced key can lose a DID. */
export function writeIdentity(
  paths: Paths, identity: Identity,
  o: { updateKey?: EncryptedKey; log?: string; webDocument?: DidDocument; sidecar?: object; genesis?: Uint8Array } = {},
): void {
  const document = identity.did.startsWith('did:web:') ? identity.document : o.webDocument;
  const files = [
    ...(o.updateKey ? [{ file: paths.updateKey, body: json(o.updateKey), mode: 0o600 }] : []),
    ...(document ? [{ file: paths.document, body: json(document), mode: 0o644 }] : []),
    ...(o.log !== undefined ? [{ file: paths.log, body: o.log, mode: 0o644 }] : []),
    ...(o.sidecar ? [{ file: paths.sidecar, body: json(o.sidecar), mode: 0o644 }] : []),
    // The exact bytes: the hash of the file is the DID.
    ...(o.genesis ? [{ file: paths.genesis, body: o.genesis, mode: 0o644 }] : []),
    { file: paths.identity, body: json(identity), mode: 0o600 },
  ];
  for (const f of files) if (existsSync(f.file)) throw new Error(`${f.file} exists: didpkg never replaces a key`);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  for (const f of files) writeFileSync(f.file, f.body, { mode: f.mode, flag: 'wx' });
}

/** The parsed JSON of the identity file, with no check. */
export function readIdentityFile(paths: Paths): { format?: unknown } & Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(paths.identity, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${paths.identity}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function readIdentity(paths: Paths): Identity {
  const id = readIdentityFile(paths) as unknown as Identity;
  if ((id?.format as string) === XID_ID_FORMAT) throw new Error(`${paths.identity} is a XID identity: this command takes only a DID identity`);
  if (id?.format !== ID_FORMAT) throw new Error(`${paths.identity}: the format is not ${ID_FORMAT}`);
  if (id.document?.id !== id.did || id.releaseKey?.format !== KEY_FORMAT || id.releaseKey.did !== id.did) {
    throw new Error(`${paths.identity}: the DID, the document and the release key do not agree`);
  }
  if (id.did.startsWith('did:dht:') && typeof id.relayPayload !== 'string') throw new Error(`${paths.identity}: a did:dht identity needs the relay payload`);
  if (id.did.startsWith('did:plc:') && (typeof id.plc?.directory !== 'string' || typeof id.plc.genesis !== 'object' || id.plc.genesis === null)) {
    throw new Error(`${paths.identity}: a did:plc identity needs the directory and the genesis operation`);
  }
  if (isKeyDid(id.did) !== (id.dwn !== undefined) || (id.dwn !== undefined && (!Array.isArray(id.dwn) || id.dwn.length === 0 || !id.dwn.every((u) => typeof u === 'string')))) {
    throw new Error(`${paths.identity}: a did:key or did:jwk identity needs a list of DWN URLs, and only such an identity has it`);
  }
  if (id.did.startsWith('did:btcr2:') && (typeof id.btcr2?.network !== 'string' || typeof id.btcr2.genesisDocument !== 'object' || id.btcr2.genesisDocument === null)) {
    throw new Error(`${paths.identity}: a did:btcr2 identity needs the network and the genesis document`);
  }
  return id;
}
