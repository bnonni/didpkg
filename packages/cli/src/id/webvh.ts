// `didpkg id create --webvh` for did:webvh.
// The DID log did.jsonl is the authority for the document. The update key signs each log entry. It is not a
// key of the document: the log lists it as a did:key in `updateKeys`. Move the update key file offline.
// The release key #didpkg-1 is a JsonWebKey, as in did:dht and did:web, because a DWN verifies a message
// signature only with publicKeyJwk.
// This command does no network write. Any static https host can serve the did.jsonl file.
import * as ed from '@noble/ed25519';
import { base58, base64urlnopad } from '@scure/base';
import { toMultikey } from '@didpkg/core/trust';
import { createDID, defaultVerifier, prepareDataForSigning, type DIDDocument, type Signer } from 'didwebvh-ts';
import { RELEASE_KEY, servicesOf } from './dht.ts';
import { encryptKey } from './keyfile.ts';
import { ID_FORMAT, idPaths, writeIdentity, type Identity } from './store.ts';
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
  files: { identity: string; updateKey: string; log: string };
}

/** The https URL of the did.jsonl file for the address. */
export const logUrl = (address: string) => hostedUrl(address, '--webvh', 'did.jsonl');

export async function createWebvh(o: WebvhCreateOptions): Promise<WebvhCreateResult> {
  const paths = idPaths(o.alias, o.env);
  const url = logUrl(o.webvh);
  if (o.passphrase === o.updatePassphrase) throw new Error('the update key passphrase must not be the release key passphrase');
  const [host, ...path] = o.webvh.split(':') as [string, ...string[]];

  const release = await ed.keygenAsync();
  const update = await ed.keygenAsync();
  const updateKey = toMultikey({ alg: 'Ed25519', bytes: update.publicKey });
  const updateKeyId = `did:key:${updateKey}#${updateKey}`;
  const signer: Signer = {
    getVerificationMethodId: () => updateKeyId,
    async sign({ document, proof }) {
      return { proofValue: `z${base58.encode(await ed.signAsync(await prepareDataForSigning(document, proof), update.secretKey))}` };
    },
  };
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
  });
  return { alias: o.alias, did, keyId, logUrl: url, files: { identity: paths.identity, updateKey: paths.updateKey, log: paths.log } };
}
