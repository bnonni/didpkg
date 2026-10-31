// `didpkg id create --web` for did:web.
// The host is the only authority for the document, so a did:web identity has no update key: the publisher
// hosts the did.json file, and a change of that file changes the DID document.
// This command does no network write. A DWN resolves the DID before it accepts the protocol, and the
// did.json file is not hosted yet. `didpkg publish` installs the protocol.
import { DidWeb } from '@enbox/dids';
import { base64urlnopad } from '@scure/base';
import { RELEASE_KEY, servicesOf } from './dht.ts';
import { encryptKey } from './keyfile.ts';
import { ID_FORMAT, idPaths, writeIdentity, type Identity } from './store.ts';

export interface WebCreateOptions {
  alias: string;
  /** The method-specific id: `<host>[%3A<port>][:<path>]...`, for example `nonni.org:pkgs`. */
  web: string;
  dwn?: string;
  repos?: string[];
  passphrase: string;
  env?: Record<string, string | undefined>;
  /** For tests only. */
  iterations?: number;
}

export interface WebCreateResult {
  alias: string;
  did: string;
  keyId: string;
  /** The URL where the publisher must host `files.document`. */
  documentUrl: string;
  files: { identity: string; document: string };
}

const HOST_RE = /^[a-z0-9.-]+(?:%3A[0-9]{1,5})?$/;
const PATH_RE = /^[A-Za-z0-9._-]+$/;

/** The https URL of the did.json file, as both did:web resolvers make it. A lowercase host only, thus one DID per host. */
export function documentUrl(id: string): string {
  return hostedUrl(id, '--web', 'did.json');
}

/** The https URL of a DID file to host, for the did:web or did:webvh address `<host>[%3A<port>][:<path>]...`. */
export function hostedUrl(id: string, flag: string, file: string): string {
  const [host = '', ...path] = id.split(':');
  const bad = (why: string) => new Error(`${flag}: ${JSON.stringify(id)} ${why}. Use <host>[%3A<port>][:<path>]...`);
  if (!HOST_RE.test(host)) throw bad('has a bad host');
  if (!path.every((s) => PATH_RE.test(s))) throw bad('has a bad path segment');
  let url: URL;
  try {
    url = new URL(`https://${decodeURIComponent(host)}/`);
  } catch {
    throw bad('is not a host');
  }
  if (url.host !== decodeURIComponent(host)) throw bad('is not a normal host');
  return path.length ? `${url.origin}/${path.join('/')}/${file}` : `${url.origin}/.well-known/${file}`;
}

export async function createWeb(o: WebCreateOptions): Promise<WebCreateResult> {
  const paths = idPaths(o.alias, o.env);
  const url = documentUrl(o.web);
  const [domain, ...path] = o.web.split(':') as [string, ...string[]];
  const bearer = await DidWeb.create({
    options: {
      domain, path: path.length ? path.join(':') : undefined, services: servicesOf(o),
      verificationMethods: [{ algorithm: 'Ed25519', id: RELEASE_KEY, purposes: ['assertionMethod'] }],
    },
  });
  const did = bearer.uri;
  const keyId = `${did}#${RELEASE_KEY}`;
  const { privateKeys = [] } = await bearer.export();
  const vm = bearer.document.verificationMethod?.find((v) => v.id === keyId);
  const jwk = privateKeys.find((k) => k.x === vm?.publicKeyJwk?.x);
  if (vm?.type !== 'JsonWebKey' || !jwk?.d) throw new Error(`no Ed25519 JsonWebKey #${RELEASE_KEY} in the new DID`);
  const releaseKey = await encryptKey({ did, keyId, seed: base64urlnopad.decode(jwk.d), passphrase: o.passphrase, iterations: o.iterations });
  const identity: Identity = { format: ID_FORMAT, alias: o.alias, did, created: new Date().toISOString(), document: bearer.document, releaseKey };
  writeIdentity(paths, identity);
  return { alias: o.alias, did, keyId, documentUrl: url, files: { identity: paths.identity, document: paths.document } };
}
