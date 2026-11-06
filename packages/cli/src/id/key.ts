// `didpkg id create --key` and `--jwk` for did:key and did:jwk. The DID holds the public key, thus the DID document
// cannot change, and it has no services. An identity has no update key: no key can change the DID.
// The identity file keeps the DWN URLs. A consumer gives the same DWN to the shim (`didpkg shim start --dwn <url>`).
// The release key is Ed25519: an Ed25519 did:jwk install name has the direct form, and a P-256 did:jwk name does not.
// This command does no network write. `didpkg id register` and `didpkg publish` write to the DWN.
import type { DidDocument } from '@enbox/dids';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base64urlnopad } from '@scure/base';
import { DidResolver, jwkDriver, keyDriver } from '@didpkg/core/did';
import { toMultikey } from '@didpkg/core/trust';
import { endpoint } from './dht.ts';
import { encryptKey } from './keyfile.ts';
import { ID_FORMAT, idPaths, writeIdentity, type Identity } from './store.ts';

export type KeyMethod = 'key' | 'jwk';

export interface KeyCreateOptions {
  alias: string;
  method: KeyMethod;
  dwn: string;
  passphrase: string;
  env?: Record<string, string | undefined>;
  /** For tests only. */
  iterations?: number;
  /** For tests only: the 32-byte Ed25519 seed. */
  seed?: Uint8Array;
}

export interface KeyCreateResult {
  alias: string;
  did: string;
  keyId: string;
  dwn: string[];
  files: { identity: string };
}

const te = new TextEncoder();

/** The DID and the release key id. did:jwk: the members of the RFC 7638 thumbprint, in that order. */
export function keyDid(method: KeyMethod, publicKey: Uint8Array): { did: string; keyId: string } {
  if (method === 'key') {
    const mb = toMultikey({ alg: 'Ed25519', bytes: publicKey });
    return { did: `did:key:${mb}`, keyId: `did:key:${mb}#${mb}` };
  }
  const jwk = { crv: 'Ed25519', kty: 'OKP', x: base64urlnopad.encode(publicKey) };
  const did = `did:jwk:${base64urlnopad.encode(te.encode(JSON.stringify(jwk)))}`;
  return { did, keyId: `${did}#0` };
}

export async function createKey(o: KeyCreateOptions): Promise<KeyCreateResult> {
  const paths = idPaths(o.alias, o.env);
  const dwn = [endpoint(o.dwn, '--dwn')];
  const seed = o.seed ?? ed25519.utils.randomSecretKey();
  const { did, keyId } = keyDid(o.method, ed25519.getPublicKey(seed));
  // The document of the resolver, thus the identity file and a resolve agree.
  const { didDocument } = await new DidResolver({ drivers: [keyDriver(), jwkDriver()] }).resolve(did);
  if (!didDocument?.assertionMethod?.includes(keyId)) throw new Error(`the ${o.method} driver gives no assertionMethod ${keyId}`);
  const releaseKey = await encryptKey({ did, keyId, seed, passphrase: o.passphrase, iterations: o.iterations });
  const identity: Identity = {
    format: ID_FORMAT, alias: o.alias, did, created: new Date().toISOString(), document: didDocument as unknown as DidDocument, dwn, releaseKey,
  };
  writeIdentity(paths, identity);
  return { alias: o.alias, did, keyId, dwn, files: { identity: paths.identity } };
}
