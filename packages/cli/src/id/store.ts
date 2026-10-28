// The identity files in `<config>/ids/` (PLAN.md Rules item 4). Each file has mode 0600, and the folder has mode 0700.
//   <alias>.json             the public data and the encrypted release key #didpkg-1. `didpkg publish` reads only this file.
//   <alias>.update-key.json  the encrypted DID update key (#0 for did:dht). Move it offline. Only `didpkg id update` reads it.
//   <alias>.did.json         the DID document for the publisher to host (did:web only, mode 0644). did:web has no update key.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DidDocument } from '@enbox/dids';
import { KEY_FORMAT, type EncryptedKey } from './keyfile.ts';

export const ID_FORMAT = 'didpkg-id-1';
export const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface Identity {
  format: typeof ID_FORMAT;
  alias: string;
  did: string;
  created: string;
  document: DidDocument;
  /** The signed did:dht relay payload (base64url). A keyless re-PUT sends these exact bytes. did:dht only. */
  relayPayload?: string;
  releaseKey: EncryptedKey;
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
  };
}

type Paths = ReturnType<typeof idPaths>;
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Writes two files. The second file is the encrypted update key (did:dht), else the did.json to host (did:web).
 * It never replaces a file, because a replaced key can lose a DID. */
export function writeIdentity(paths: Paths, identity: Identity, updateKey?: EncryptedKey): void {
  const second = updateKey
    ? { file: paths.updateKey, body: updateKey, mode: 0o600 }
    : { file: paths.document, body: identity.document, mode: 0o644 };
  for (const f of [paths.identity, second.file]) if (existsSync(f)) throw new Error(`${f} exists: didpkg never replaces a key`);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  writeFileSync(second.file, json(second.body), { mode: second.mode, flag: 'wx' });
  writeFileSync(paths.identity, json(identity), { mode: 0o600, flag: 'wx' });
}

export function readIdentity(paths: Paths): Identity {
  let id: Identity;
  try {
    id = JSON.parse(readFileSync(paths.identity, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${paths.identity}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (id?.format !== ID_FORMAT) throw new Error(`${paths.identity}: the format is not ${ID_FORMAT}`);
  if (id.document?.id !== id.did || id.releaseKey?.format !== KEY_FORMAT || id.releaseKey.did !== id.did) {
    throw new Error(`${paths.identity}: the DID, the document and the release key do not agree`);
  }
  if (id.did.startsWith('did:dht:') && typeof id.relayPayload !== 'string') throw new Error(`${paths.identity}: a did:dht identity needs the relay payload`);
  return id;
}
