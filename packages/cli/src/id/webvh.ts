// `didpkg id create --webvh` for did:webvh.
// The DID log did.jsonl is the authority for the document. The update key signs each log entry. It is not a
// key of the document: the log lists it as a did:key in `updateKeys`. Move the update key file offline.
// The release key #didpkg-1 is a JsonWebKey, as in did:dht and did:web, because a DWN verifies a message
// signature only with publicKeyJwk.
// It also writes the parallel did:web document did.json, as the did:webvh specification describes, for did:web
// resolvers. The did:webvh document lists that did:web DID in alsoKnownAs.
// This command does no network write. Any static https host can serve the did.jsonl and did.json files.
// `didpkg id update` adds a log entry, signed by the update key, that changes the services. The local did.jsonl is the base.
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as ed from '@noble/ed25519';
import { base58, base64urlnopad } from '@scure/base';
import { toMultikey } from '@didpkg/core/trust';
import {
  createDID, defaultVerifier, generateParallelDidWeb, prepareDataForSigning, updateDID, type DIDDocument, type DIDLog, type Signer,
} from 'didwebvh-ts';
import { RELEASE_KEY, servicesOf } from './dht.ts';
import { decryptKey, encryptKey, type EncryptedKey } from './keyfile.ts';
import { ID_FORMAT, idPaths, readIdentity, writeIdentity, type Identity } from './store.ts';
import { hostedUrl } from './web.ts';

export interface WebvhCreateOptions {
  alias: string;
  /** The address: `<host>[%3A<port>][:<path>]...`, for example `nonni.org:pkgs`. The library adds the SCID. */
  webvh: string;
  dwn?: string;
  repos?: string[];
  passphrase: string;
  updatePassphrase: string;
  env?: Record<string, string | undefined>;
  /** For tests only. */
  iterations?: number;
}

export interface WebvhCreateResult {
  alias: string;
  did: string;
  keyId: string;
  /** The URL where the publisher must host `files.log`. */
  logUrl: string;
  /** The URL where the publisher must host `files.document`, the parallel did:web document. */
  documentUrl: string;
  files: { identity: string; updateKey: string; log: string; document: string };
}

/** The signer of the log entries: the update key, as a did:key. */
function signerOf(keyId: string, secretKey: Uint8Array): Signer {
  return {
    getVerificationMethodId: () => keyId,
    async sign({ document, proof }) {
      return { proofValue: `z${base58.encode(await ed.signAsync(await prepareDataForSigning(document, proof), secretKey))}` };
    },
  };
}

/** The https URL of the did.jsonl file for the address. */
export const logUrl = (address: string) => hostedUrl(address, '--webvh', 'did.jsonl');

export async function createWebvh(o: WebvhCreateOptions): Promise<WebvhCreateResult> {
  const paths = idPaths(o.alias, o.env);
  const url = logUrl(o.webvh);
  const documentUrl = hostedUrl(o.webvh, '--webvh', 'did.json');
  if (o.passphrase === o.updatePassphrase) throw new Error('the update key passphrase must not be the release key passphrase');
  const [host, ...path] = o.webvh.split(':') as [string, ...string[]];

  const release = await ed.keygenAsync();
  const update = await ed.keygenAsync();
  const updateKey = toMultikey({ alg: 'Ed25519', bytes: update.publicKey });
  const updateKeyId = `did:key:${updateKey}#${updateKey}`;
  const signer = signerOf(updateKeyId, update.secretKey);
  const didDocument: DIDDocument = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: '{DID}',
    verificationMethod: [{
      id: `{DID}#${RELEASE_KEY}`, type: 'JsonWebKey', controller: '{DID}',
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: base64urlnopad.encode(release.publicKey) },
    }],
    assertionMethod: [`{DID}#${RELEASE_KEY}`],
    service: servicesOf(o).map((s) => ({ ...s, id: `{DID}#${s.id}` })),
  };
  const created = await createDID({
    address: decodeURIComponent(host), paths: path.length ? path : undefined, signer, verifier: defaultVerifier, updateKeys: [updateKey], didDocument,
    alsoKnownAsWeb: true,
  });

  const did = created.did;
  const keyId = `${did}#${RELEASE_KEY}`;
  const identity: Identity = {
    format: ID_FORMAT, alias: o.alias, did, created: new Date().toISOString(), document: created.doc as Identity['document'],
    releaseKey: await encryptKey({ did, keyId, seed: release.secretKey, passphrase: o.passphrase, iterations: o.iterations }),
  };
  writeIdentity(paths, identity, {
    updateKey: await encryptKey({ did, keyId: updateKeyId, seed: update.secretKey, passphrase: o.updatePassphrase, iterations: o.iterations }),
    log: created.log.map((e) => JSON.stringify(e)).join('\n') + '\n',
    webDocument: generateParallelDidWeb(did, created.doc) as Identity['document'],
  });
  return {
    alias: o.alias, did, keyId, logUrl: url, documentUrl,
    files: { identity: paths.identity, updateKey: paths.updateKey, log: paths.log, document: paths.document },
  };
}

export interface WebvhUpdateOptions {
  alias: string;
  /** Add the service #dwn, or change its URL. */
  dwn?: string;
  /** Remove the service #dwn. */
  removeDwn?: boolean;
  /** Replace the URLs of the service #pkg. */
  repos?: string[];
  updatePassphrase: string;
  env?: Record<string, string | undefined>;
}

export interface WebvhUpdateResult {
  alias: string;
  did: string;
  /** The versionId of the new log entry, `<n>-<hash>`. */
  versionId: string;
  logUrl: string;
  documentUrl: string;
  files: { identity: string; log: string; document: string };
}

/** Adds a log entry that changes the services #dwn and #pkg. The update key signs it. Other services stay. */
export async function updateWebvh(o: WebvhUpdateOptions): Promise<WebvhUpdateResult> {
  const paths = idPaths(o.alias, o.env);
  const identity = readIdentity(paths);
  if (!identity.did.startsWith('did:webvh:')) throw new Error(`${paths.identity}: "id update" takes a did:webvh or a XID identity`);
  if (o.dwn === undefined && !o.removeDwn && o.repos === undefined) throw new Error('nothing to update');
  if (o.removeDwn && o.dwn !== undefined) throw new Error('remove the DWN, or change it: not both');
  const address = identity.did.split(':').slice(3).join(':');
  const urls = { log: logUrl(address), document: hostedUrl(address, '--webvh', 'did.json') };

  const log = readFileSync(paths.log, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) as DIDLog;
  const state = log.at(-1)?.state as DIDDocument | undefined;
  if (state?.id !== identity.did) throw new Error(`${paths.log}: the last log entry is not a document of ${identity.did}`);
  const keyFile = JSON.parse(readFileSync(paths.updateKey, 'utf8')) as EncryptedKey;
  const signer = signerOf(keyFile.keyId, await decryptKey(keyFile, o.updatePassphrase));

  const of = (id: string) => state.service?.find((s) => s.id === `${identity.did}#${id}`);
  const urlsOf = (id: string) => [of(id)?.serviceEndpoint ?? []].flat().filter((u): u is string => typeof u === 'string');
  const dwn = o.removeDwn ? undefined : (o.dwn ?? urlsOf('dwn')[0]);
  const repos = o.repos ?? urlsOf('pkg');
  const own = servicesOf({ dwn, repos }).map((s) => ({ ...s, id: `${identity.did}#${s.id}` }));
  const others = (state.service ?? []).filter((s) => s.id !== `${identity.did}#dwn` && s.id !== `${identity.did}#pkg`);

  const r = await updateDID({ log, signer, verifier: defaultVerifier, didDocument: { ...state, service: [...own, ...others] } });
  if (r.did !== identity.did) throw new Error(`the update changed the DID to ${r.did}`);
  const files = [
    { file: paths.log, body: r.log.map((e) => JSON.stringify(e)).join('\n') + '\n', mode: 0o644 },
    { file: paths.document, body: `${JSON.stringify(r.webDoc ?? generateParallelDidWeb(r.did, r.doc), null, 2)}\n`, mode: 0o644 },
    { file: paths.identity, body: `${JSON.stringify({ ...identity, document: r.doc }, null, 2)}\n`, mode: 0o600 },
  ];
  // The identity file is the last write. Each file goes to a temp file first, then a rename replaces the old file.
  for (const f of files) {
    writeFileSync(`${f.file}.tmp`, f.body, { mode: f.mode, flag: 'w' });
    chmodSync(`${f.file}.tmp`, f.mode);
    renameSync(`${f.file}.tmp`, f.file);
  }
  return {
    alias: o.alias, did: r.did, versionId: r.meta.versionId, logUrl: urls.log, documentUrl: urls.document,
    files: { identity: paths.identity, log: paths.log, document: paths.document },
  };
}
