// `didpkg id create --xid`, `didpkg id show` and `didpkg id update` for a XID publisher (BCR-2024-010).
// The XID document is a Gordian Envelope. The inception key (All) makes the XID and signs each document: it is the
// update key. The release key (Sign) signs the release records and the indexes. The DWN key (Auth) signs the DWN
// messages. The provenance mark chain orders the documents. Its generator is in the update key file, next to the
// inception key. bc-xid locks each private key and the generator with a passphrase (Argon2id).
// This command does no network write. Any static https host can serve the document at <repo>/xid/<hex>.envelope.
// `didpkg id backup` and `didpkg id restore` use Gordian Envelope SSKR: each share is a `ur:envelope`.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { PrivateKeyBase, SymmetricKey, type PrivateKeys } from '@blockchaincommons/components';
import { Envelope } from '@blockchaincommons/envelope';
import { sskrJoin, sskrSplit } from '@blockchaincommons/envelope/sskr';
import { GroupSpec, Spec } from '@blockchaincommons/sskr';
import { UR } from '@blockchaincommons/uniform-resources';
import { Key, Permissions, Service, XIDDocument, type Privilege } from '@blockchaincommons/xid';
import { grants, readXidDocument, xidDocumentUrl, type XidDocumentInfo } from '@didpkg/core/xid';
import { base64urlnopad } from '@scure/base';
import { endpoint, REPOSITORY_TYPE } from './dht.ts';
import { idPaths, readIdentityFile, XID_ID_FORMAT } from './store.ts';

/** The service capability of a DWN, as the DID service type. */
export const DWN_CAPABILITY = 'DecentralizedWebNode';
/** The key roles. Each role is also the nickname of its key in the document. */
export type XidRole = 'release' | 'dwn';
const PRIVILEGE: Record<XidRole, Privilege> = { release: 'Sign', dwn: 'Auth' };
const CAPABILITY: Record<XidRole, string> = { release: REPOSITORY_TYPE, dwn: DWN_CAPABILITY };

export interface XidIdentity {
  format: typeof XID_ID_FORMAT;
  alias: string;
  /** The XID as 64 lowercase hex characters. */
  xid: string;
  created: string;
  /** The signed XID document: tagged CBOR, base64url. The same bytes as the file `<alias>.xid.envelope`. */
  document: string;
  /** The envelope of each key, with the private keys locked by the release passphrase: tagged CBOR, base64url. */
  keys: { release: string; dwn?: string; previousRelease?: string };
}

type Paths = ReturnType<typeof idPaths>;
type Env = Record<string, string | undefined>;

export interface XidCreateOptions {
  alias: string;
  /** A DWN endpoint: a service with the capability `DecentralizedWebNode` and the DWN key. */
  dwn?: string;
  /** Static mirror URLs: a service with the capability `DIDPackageRepository` and a `dereferenceVia` URI for each. */
  repos?: string[];
  passphrase: string;
  updatePassphrase: string;
  env?: Env;
  /** For tests only: the date of the provenance mark. */
  date?: Date;
}

export interface XidUpdateOptions {
  alias: string;
  /** Make a new key for each role, and remove the old key. */
  rotate?: XidRole[];
  /** Set the DWN endpoint. If the document has no DWN key, add one. */
  dwn?: string;
  /** Remove the DWN service and the DWN key. */
  removeDwn?: boolean;
  /** Replace the static mirror URLs. */
  repos?: string[];
  /** The release passphrase. Only a new key asks for it. */
  passphrase?: () => Promise<string>;
  updatePassphrase: string;
  env?: Env;
  date?: Date;
}

export interface XidResult {
  alias: string;
  xid: string;
  ur: string;
  seq: number;
  keys: { reference: string; nickname: string; allow: readonly Privilege[] }[];
  /** The URLs where the publisher must host `files.document`. */
  documentUrls: string[];
  files: { identity: string; updateKey: string; document: string };
}

const b64 = (b: Uint8Array) => base64urlnopad.encode(b);
const bytesOf = (e: Envelope) => e.toCbor().toData();
const newKeys = () => PrivateKeyBase.random();
const permissions = (role: XidRole) => Permissions.from({ allow: [PRIVILEGE[role]] });

/** The `ur:xid` text of a XID: an untagged CBOR byte string (BCR-2024-010). */
export const xidUr = (doc: XIDDocument): string => UR.from('xid', doc.xid.untaggedCbor()).toString();

/** A key of the document with only the public keys, and the key envelope with the private keys locked. */
function makeKey(role: XidRole, passphrase: string): { key: Key; locked: string } {
  const base = newKeys();
  const key = Key.from(base.ed25519PublicKeys(), { nickname: role, permissions: permissions(role) });
  const secret = Key.from(base.ed25519PublicKeys(), { privateKeys: base.ed25519PrivateKeys(), nickname: role, permissions: permissions(role) });
  return { key, locked: b64(bytesOf(secret.toEnvelope({ privateKeys: { encrypt: passphrase } }))) };
}

/** The key of a locked key envelope, with no passphrase: the public keys only. */
const publicKeyOf = (locked: string): Key => Key.fromEnvelope(Envelope.fromBytes(base64urlnopad.decode(locked)));

/** The key of a role with its private keys open. A wrong passphrase gives an error. */
function openKey(identity: XidIdentity, role: XidRole | 'previousRelease', passphrase: string): Key {
  const locked = identity.keys[role];
  if (locked === undefined) throw new Error(`the identity ${identity.alias} has no ${role} key`);
  const key = Key.fromEnvelope(Envelope.fromBytes(base64urlnopad.decode(locked)), { password: passphrase });
  if (!key.privateKeys) throw new Error(`the ${role} key of ${identity.alias}: wrong passphrase, or the file changed`);
  return key;
}

/** The private keys of a role, for a Gordian signer. A wrong passphrase gives an error. */
export const openXidKey = (identity: XidIdentity, role: XidRole | 'previousRelease', passphrase: string): PrivateKeys =>
  openKey(identity, role, passphrase).privateKeys!;

/** Each role key must be a key of the document with the privilege of its role, and not the inception key. */
function checkKeys(where: string, keys: XidIdentity['keys'], info: XidDocumentInfo): void {
  for (const role of ['release', 'dwn'] as const) {
    const locked = keys[role];
    if (locked === undefined) continue;
    const ref = publicKeyOf(locked).reference.toHex();
    const k = info.keys.find((x) => x.reference === ref);
    if (!k || k.inception || !grants(k, PRIVILEGE[role])) throw new Error(`${where}: the ${role} key is not a ${PRIVILEGE[role]} key of the document`);
  }
}

function addService(doc: XIDDocument, role: XidRole, uri: string, key: Key): void {
  doc.addService(Service.from(uri, { capability: CAPABILITY[role], keyReferences: [key.reference], permissions: permissions(role) }));
}

function setRepos(doc: XIDDocument, repos: string[], release: Key): void {
  for (const s of doc.services.filter((x) => x.capability === REPOSITORY_TYPE)) {
    doc.takeService(s.uri);
    doc.removeResolutionMethod(xidDocumentUrl(String(s.uri), doc.xid.toHex()));
  }
  for (const repo of repos) {
    addService(doc, 'release', endpoint(repo, 'repo'), release);
    doc.addResolutionMethod(xidDocumentUrl(repo, doc.xid.toHex()));
  }
}

function result(alias: string, paths: Paths, info: XidDocumentInfo): XidResult {
  return {
    alias, xid: info.xid, ur: xidUr(info.document), seq: info.provenance.seq,
    keys: info.keys.map((k) => ({ reference: k.reference, nickname: k.nickname, allow: k.allow })),
    documentUrls: [...info.dereferenceVia],
    files: { identity: paths.identity, updateKey: paths.xidUpdate, document: paths.xidDocument },
  };
}

/** The 3 files. The identity file is the last write. `replace` writes each file to a temp file, then renames it. */
function save(paths: Paths, doc: XIDDocument, identity: Omit<XidIdentity, 'document'>, updatePassphrase: string, replace: boolean): XidDocumentInfo {
  const update = bytesOf(doc.toEnvelope({ privateKeys: { encrypt: updatePassphrase }, generator: { encrypt: updatePassphrase }, sign: 'inception' }));
  const info = readXidDocument(bytesOf(doc.toEnvelope({ sign: 'inception' })), identity.xid);
  const full: XidIdentity = { ...identity, document: b64(info.bytes) };
  const files = [
    { file: paths.xidUpdate, body: update, mode: 0o600 },
    { file: paths.xidDocument, body: info.bytes, mode: 0o644 },
    { file: paths.identity, body: `${JSON.stringify(full, null, 2)}\n`, mode: 0o600 },
  ];
  if (!replace) for (const f of files) if (existsSync(f.file)) throw new Error(`${f.file} exists: didpkg never replaces a key`);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  for (const f of files) {
    if (!replace) {
      writeFileSync(f.file, f.body, { mode: f.mode, flag: 'wx' });
      continue;
    }
    writeFileSync(`${f.file}.tmp`, f.body, { mode: f.mode, flag: 'w' });
    chmodSync(`${f.file}.tmp`, f.mode);
    renameSync(`${f.file}.tmp`, f.file);
  }
  return info;
}

export async function createXid(o: XidCreateOptions): Promise<XidResult> {
  const paths = idPaths(o.alias, o.env);
  if (o.passphrase === o.updatePassphrase) throw new Error('the update key passphrase must not be the release key passphrase');
  const dwn = o.dwn === undefined ? undefined : endpoint(o.dwn, 'dwn');
  const repos = (o.repos ?? []).map((r) => endpoint(r, 'repo'));

  const inception = newKeys();
  const doc = XIDDocument.from({
    inceptionKey: { publicKeys: inception.ed25519PublicKeys(), privateKeys: inception.ed25519PrivateKeys() },
    genesis: { seed: crypto.getRandomValues(new Uint8Array(32)), date: o.date },
  });
  doc.setNameForKey(inception.ed25519PublicKeys(), 'inception');
  const release = makeKey('release', o.passphrase);
  doc.addKey(release.key);
  const keys: XidIdentity['keys'] = { release: release.locked };
  if (dwn !== undefined) {
    const k = makeKey('dwn', o.passphrase);
    doc.addKey(k.key);
    addService(doc, 'dwn', dwn, k.key);
    keys.dwn = k.locked;
  }
  setRepos(doc, repos, release.key);
  const xid = doc.xid.toHex();
  const info = save(paths, doc, { format: XID_ID_FORMAT, alias: o.alias, xid, created: new Date().toISOString(), keys }, o.updatePassphrase, false);
  return result(o.alias, paths, info);
}

/** The identity file of a XID publisher. The document must be a valid XID document for the XID. */
export function readXidIdentity(paths: Paths): { identity: XidIdentity; info: XidDocumentInfo } {
  const id = readIdentityFile(paths) as unknown as XidIdentity;
  if (id?.format !== XID_ID_FORMAT) throw new Error(`${paths.identity}: the format is not ${XID_ID_FORMAT}`);
  if (typeof id.xid !== 'string' || typeof id.document !== 'string' || typeof id.keys?.release !== 'string') {
    throw new Error(`${paths.identity}: a XID identity needs the XID, the document and the release key`);
  }
  let info: XidDocumentInfo;
  try {
    info = readXidDocument(base64urlnopad.decode(id.document), id.xid);
  } catch (e) {
    throw new Error(`${paths.identity}: ${e instanceof Error ? e.message : String(e)}`);
  }
  checkKeys(paths.identity, id.keys, info);
  return { identity: id, info };
}

/** The document of the update key file, with the inception key and the generator open. */
function openUpdate(paths: Paths, identity: XidIdentity, seq: number, updatePassphrase: string): XIDDocument {
  let doc: XIDDocument;
  try {
    doc = XIDDocument.fromEnvelope(Envelope.fromBytes(readFileSync(paths.xidUpdate)), { password: updatePassphrase, verify: 'inception' });
  } catch (e) {
    throw new Error(`${paths.xidUpdate}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A wrong password does not throw: bc-xid keeps the key and the generator locked.
  if (!doc.inceptionPrivateKeys || !doc.provenanceGenerator) throw new Error(`${paths.xidUpdate}: wrong passphrase, or the file changed`);
  if (doc.xid.toHex() !== identity.xid) throw new Error(`${paths.xidUpdate} is for XID ${doc.xid.toHex()}, not ${identity.xid}`);
  if (doc.provenance?.seq !== seq) throw new Error(`${paths.xidUpdate} has seq ${doc.provenance?.seq}, but ${paths.identity} has seq ${seq}`);
  return doc;
}

/** Replace the key of a role with a new key. Each service of the old key gets the new key. */
function rotate(doc: XIDDocument, keys: XidIdentity['keys'], role: XidRole, passphrase: string): void {
  const locked = keys[role];
  if (locked === undefined) throw new Error(`no ${role} key to rotate`);
  const old = publicKeyOf(locked);
  const next = makeKey(role, passphrase);
  doc.addKey(next.key);
  for (const s of doc.services) {
    if (s.removeKeyReference(old.reference)) s.addKeyReference(next.key.reference);
  }
  doc.removeKey(old.publicKeys);
  // The next index needs a signature by the old release key too (a key change needs a pinned key).
  if (role === 'release') keys.previousRelease = locked;
  keys[role] = next.locked;
}

export async function updateXid(o: XidUpdateOptions): Promise<XidResult> {
  const paths = idPaths(o.alias, o.env);
  const { identity, info } = readXidIdentity(paths);
  const rotations = [...new Set(o.rotate ?? [])];
  if (!rotations.length && o.dwn === undefined && !o.removeDwn && o.repos === undefined) throw new Error('nothing to update');
  if (o.removeDwn && (o.dwn !== undefined || rotations.includes('dwn'))) throw new Error('remove the DWN, or change it: not both');
  const dwn = o.dwn === undefined ? undefined : endpoint(o.dwn, 'dwn');
  const repos = o.repos?.map((r) => endpoint(r, 'repo'));
  const needsKey = rotations.length > 0 || (dwn !== undefined && identity.keys.dwn === undefined);
  if (needsKey && o.passphrase === undefined) throw new Error('a new key needs the release passphrase');
  const passphrase = needsKey ? await o.passphrase!() : '';
  if (needsKey) {
    if (passphrase === o.updatePassphrase) throw new Error('the update key passphrase must not be the release key passphrase');
    openXidKey(identity, 'release', passphrase); // a new key gets the passphrase of the release key
  }

  const doc = openUpdate(paths, identity, info.provenance.seq, o.updatePassphrase);
  const keys = { ...identity.keys };
  for (const role of rotations) rotate(doc, keys, role, passphrase);
  const dwnServices = () => doc.services.filter((s) => s.capability === DWN_CAPABILITY);
  if (o.removeDwn) {
    if (keys.dwn === undefined) throw new Error('the document has no DWN key');
    for (const s of dwnServices()) doc.takeService(s.uri);
    doc.removeKey(publicKeyOf(keys.dwn).publicKeys);
    delete keys.dwn;
  }
  if (dwn !== undefined) {
    if (keys.dwn === undefined) {
      const k = makeKey('dwn', passphrase);
      doc.addKey(k.key);
      keys.dwn = k.locked;
    }
    for (const s of dwnServices()) doc.takeService(s.uri);
    addService(doc, 'dwn', dwn, publicKeyOf(keys.dwn));
  }
  if (repos !== undefined) setRepos(doc, repos, publicKeyOf(keys.release));
  doc.nextProvenanceMarkWithEmbeddedGenerator({ date: o.date });
  const next = save(paths, doc, { ...identity, keys }, o.updatePassphrase, true);
  return result(o.alias, paths, next);
}

/** The public data of a XID identity, for `didpkg id show`. */
export function showXid(alias: string, env?: Env) {
  const paths = idPaths(alias, env);
  const { identity, info } = readXidIdentity(paths);
  return {
    alias, kind: 'xid', xid: info.xid, ur: xidUr(info.document), created: identity.created,
    provenance: { seq: info.provenance.seq, date: info.provenance.date, chainId: info.provenance.chainId },
    keys: info.keys.map((k) => ({ reference: k.reference, nickname: k.nickname, allow: k.allow, deny: k.deny, inception: k.inception })),
    services: info.services.map((s) => ({ uri: s.uri, capability: s.capability, keyReferences: s.keyReferences, allow: s.allow })),
    dereferenceVia: info.dereferenceVia,
    files: {
      identity: paths.identity, document: paths.xidDocument,
      updateKey: existsSync(paths.xidUpdate) ? paths.xidUpdate : null,
    },
  };
}

/** The subject of a backup envelope. */
const BACKUP_TYPE = 'didpkg-xid-backup';
const BACKUP_ROLES = ['release', 'dwn', 'previousRelease'] as const;

export interface XidBackupOptions {
  alias: string;
  /** `<m>-of-<n>`: the backup has n shares, and m shares restore it. */
  sskr: string;
  passphrase: string;
  updatePassphrase: string;
  env?: Env;
}

export interface XidBackup {
  alias: string;
  xid: string;
  /** The seq of the document in the backup. */
  seq: number;
  sskr: string;
  /** One `ur:envelope` for each share. */
  shares: string[];
}

/** One group of m-of-n (1 <= m <= n <= 16). */
function sskrSpec(text: string): { spec: Spec; text: string } {
  const m = /^([0-9]+)-of-([0-9]+)$/.exec(text);
  const [t, n] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (t < 1 || t > n || n > 16) throw new Error(`--sskr: ${text} is not <m>-of-<n> with 1 <= m <= n <= 16`);
  return { spec: Spec.from({ groupThreshold: 1, groups: [GroupSpec.from({ memberThreshold: t, memberCount: n })] }), text: `${t}-of-${n}` };
}

/**
 * The SSKR shares of a XID identity. The backup envelope holds the document with the inception key and the provenance
 * mark generator, and each role key, all open. A random content key encrypts the backup, and SSKR splits the content
 * key. Each share holds the encrypted backup and one part of the content key.
 */
export function backupXid(o: XidBackupOptions): XidBackup {
  const paths = idPaths(o.alias, o.env);
  const { spec, text } = sskrSpec(o.sskr);
  const { identity, info } = readXidIdentity(paths);
  const doc = openUpdate(paths, identity, info.provenance.seq, o.updatePassphrase);
  let backup = Envelope.from(BACKUP_TYPE)
    .addAssertion('created', identity.created)
    .addAssertion('document', doc.toEnvelope({ privateKeys: 'include', generator: 'include', sign: 'inception' }));
  for (const role of BACKUP_ROLES) {
    if (identity.keys[role] !== undefined) backup = backup.addAssertion(role, openKey(identity, role, o.passphrase).toEnvelope({ privateKeys: 'include' }));
  }
  const contentKey = SymmetricKey.random();
  const groups = sskrSplit(backup.wrap().encryptSubject(contentKey), spec, contentKey);
  return { alias: o.alias, xid: info.xid, seq: info.provenance.seq, sskr: text, shares: groups[0]!.map((e) => e.toUR().toString()) };
}

export interface XidRestoreOptions {
  alias: string;
  /** The `ur:envelope` text of each share. */
  shares: string[];
  passphrase: string;
  updatePassphrase: string;
  env?: Env;
}

function shareOf(text: string, n: number): Envelope {
  try {
    const ur = UR.parse(text);
    ur.expectType('envelope');
    return Envelope.fromUntaggedCbor(ur.cbor);
  } catch {
    throw new Error(`share ${n}: not a ur:envelope`);
  }
}

/** Make the 3 files of a XID identity from the shares. The passphrases lock the keys again. No file is replaced. */
export function restoreXid(o: XidRestoreOptions): XidResult {
  const paths = idPaths(o.alias, o.env);
  if (o.passphrase === o.updatePassphrase) throw new Error('the update key passphrase must not be the release key passphrase');
  if (o.shares.length === 0) throw new Error('no shares');
  let backup: Envelope;
  try {
    backup = sskrJoin(o.shares.map((s, i) => shareOf(s, i + 1))).unwrap();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('share ')) throw e;
    throw new Error('the shares do not restore a backup: give more shares, or only shares of one backup');
  }
  const value = (predicate: string) => backup.optionalObjectForPredicate(predicate);
  if (backup.subject().asText() !== BACKUP_TYPE || !value('document') || !value('release')) throw new Error('the shares do not hold a didpkg XID backup');
  const doc = XIDDocument.fromEnvelope(value('document')!, { verify: 'inception' });
  if (!doc.inceptionPrivateKeys || !doc.provenanceGenerator) throw new Error('the backup has no inception key or no provenance mark generator');
  const keys = {} as XidIdentity['keys'];
  for (const role of BACKUP_ROLES) {
    const env = value(role);
    if (env === undefined) continue;
    const key = Key.fromEnvelope(env);
    if (!key.privateKeys) throw new Error(`the ${role} key of the backup has no private keys`);
    keys[role] = b64(bytesOf(key.toEnvelope({ privateKeys: { encrypt: o.passphrase } })));
  }
  const xid = doc.xid.toHex();
  checkKeys('the backup', keys, readXidDocument(bytesOf(doc.toEnvelope({ sign: 'inception' })), xid));
  const created = value('created')?.asText() ?? new Date().toISOString();
  const info = save(paths, doc, { format: XID_ID_FORMAT, alias: o.alias, xid, created, keys }, o.updatePassphrase, false);
  return result(o.alias, paths, info);
}
