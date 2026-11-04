// `didpkg publish` for a XID publisher. The steps of publish.ts, with Gordian Envelopes in place of JSON:
// 1. Checks: the tarball, the name, the version, the targets. Then the passphrase.
// 2. It reads the head index and the release of the version from each folder, and keeps only the copies
//    that the release key or the previous release key signed. If one read fails, it signs and writes nothing.
// 3. It signs a release with the release key, and the next index with the release key and the previous
//    release key (after a rotation, a client with a pin on the old key accepts the new key). Or it uses the signed copies again.
// 4. Each folder gets the XID document at xid/<hex>.envelope, then the tarball, the release and the index.
// A DWN gets the protocol v2 first, and no XID document. The tenant is the did:key of the DWN key, and the DWN key signs.
import type { PrivateKeys } from '@blockchaincommons/components';
import { hasSignatureFrom } from '@blockchaincommons/envelope/signature';
import { dwnAdapter } from '@didpkg/adapter-dwn';
import { DwnWriter, ed25519MessageSigner } from '@didpkg/adapter-dwn/writer';
import { format } from '@didpkg/core/name';
import { DWN_SERVICE_TYPE, xidEndpoints, type Endpoint, type StorageReader, type StoredFile } from '@didpkg/core/source';
import { checkVersion, sri } from '@didpkg/core/trust';
import {
  envelopeBytes, parseXidIndex, parseXidRelease, readXidDocument, signXidIndex, signXidRelease, xidContentDigest, type XidPkgIndex, type XidPkgRelease,
} from '@didpkg/core/xid';
import { DirWriter } from '@didpkg/adapter-https/dir';
import type { StepResult } from '../id/dht.ts';
import { openXidKey, type XidIdentity } from '../id/xid.ts';
import { readTarball } from './tarball.ts';

const READ_TIMEOUT_MS = 30_000;
const MAX_RECORD_BYTES = 1024 * 1024;

export interface PublishXidOptions {
  identity: XidIdentity;
  /** The signed XID document, as tagged CBOR. Each folder gets a copy. */
  document: Uint8Array;
  /** The exact `npm pack` bytes. */
  tarball: Uint8Array;
  /** `dwn` (each DWN service of the XID document) or `dir:<path>`. */
  to: readonly string[];
  /** Gives the passphrase of the release key. It runs after the input checks. */
  passphrase: () => Promise<string>;
}

export interface PublishXidResult {
  xid: string;
  name: string;
  version: string;
  installName: string;
  /** The content digest of the release. */
  release: string;
  sequence: number;
  targets: StepResult[];
}

interface Signed<T> { value: T; bytes: Uint8Array }
interface Target { url: string; reader: StorageReader; dir?: DirWriter; dwn?: DwnWriter }

function targetsOf(to: readonly string[], endpoints: Endpoint[]): { dwn: Endpoint[]; dirs: string[] } {
  const dwn: Endpoint[] = [];
  const dirs: string[] = [];
  for (const t of to) {
    if (t === 'dwn') {
      const found = endpoints.filter((e) => e.type === DWN_SERVICE_TYPE);
      if (found.length === 0) throw new Error('--to dwn: the XID document has no DWN service with a DWN key');
      dwn.push(...found.filter((e) => !dwn.some((d) => d.url === e.url)));
    } else if (t.startsWith('dir:') && t.length > 4) {
      dirs.push(t.slice(4));
    } else {
      throw new Error(`--to ${JSON.stringify(t)}: use "dwn" or "dir:<path>"`);
    }
  }
  return { dwn, dirs: [...new Set(dirs)] };
}

export async function publishXid(o: PublishXidOptions): Promise<PublishXidResult> {
  const { xid } = o.identity;
  const { name, version, npm } = readTarball(o.tarball);
  checkVersion(version);
  const installName = format(xid, name);
  const { dwn, dirs } = targetsOf(o.to, xidEndpoints(readXidDocument(o.document, xid)));
  if (dwn.length && !o.identity.keys.dwn) throw new Error(`--to dwn: the identity ${o.identity.alias} has no DWN key`);

  const pass = await o.passphrase();
  const signer = openXidKey(o.identity, 'release', pass);
  const adapter = dwnAdapter({ allowLoopback: true });
  // The DWN key signs as its did:key. The verification method id of a did:key is the DID and the key as a fragment.
  const seed = dwn.length ? openXidKey(o.identity, 'dwn', pass).signingPrivateKey.asEd25519()?.bytes : undefined;
  if (dwn.length && !seed) throw new Error('the DWN key is not an Ed25519 key');
  const targets: Target[] = [
    ...dwn.map((e) => {
      const signer = ed25519MessageSigner(seed!, `${e.did}#${e.did.slice('did:key:'.length)}`);
      return { url: e.url, reader: adapter.reader(e, { fetch }), dwn: new DwnWriter({ dwnUrl: e.url, did: e.did, signer, format: 'envelope' }) };
    }),
    ...dirs.map((dir) => {
      const writer = new DirWriter(dir);
      return { url: `dir:${dir}`, reader: writer, dir: writer };
    }),
  ];
  for (const t of targets) await t.dwn?.installProtocol();
  const previous: PrivateKeys | undefined = o.identity.keys.previousRelease ? openXidKey(o.identity, 'previousRelease', pass) : undefined;
  const own = [signer, ...(previous ? [previous] : [])].map((k) => k.publicKeys());

  // 2. The signed copies of these keys in the folders.
  const read = async <T extends XidPkgIndex | XidPkgRelease>(file: StoredFile, parse: (v: unknown) => T) => {
    const found: Signed<T>[] = [];
    for (const t of targets) {
      for await (const bytes of t.reader.read(file, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), maxBytes: MAX_RECORD_BYTES })) {
        let value: T;
        try {
          value = parse(bytes);
        } catch {
          continue;
        }
        if (value.publisher === xid && value.name === name && own.some((k) => hasSignatureFrom(value.envelope, k))) found.push({ value, bytes });
      }
    }
    return found;
  };
  const head = (await read({ kind: 'index', name, format: 'envelope' }, parseXidIndex)).reduce<Signed<XidPkgIndex> | null>(
    (best, c) => (!best || c.value.sequence > best.value.sequence ? c : best), null);
  const releases = new Map<string, Signed<XidPkgRelease>>();
  for (const c of await read({ kind: 'release', name, version, format: 'envelope' }, parseXidRelease)) {
    if (c.value.version === version) releases.set(xidContentDigest(c.value), c);
  }

  // 3. A published version does not change. The same tarball again uses the signed copies.
  if (releases.size > 1) throw new Error(`${name}@${version}: the targets hold ${releases.size} different signed releases`);
  let [release] = releases.values();
  if (release && release.value.dist.integrity !== (await sri('sha512', o.tarball))) {
    throw new Error(`${name}@${version} is published with a different tarball`);
  }
  const entry = head && Object.hasOwn(head.value.releases, version) ? head.value.releases[version] : undefined;
  if (entry && (!release || entry.digest !== xidContentDigest(release.value))) {
    throw new Error(`${name}@${version} is in the signed index with a different release`);
  }
  if (!release) {
    const value = await signXidRelease({ publisher: xid, name, version, tarball: o.tarball, npm, head: head?.value ?? null }, [signer]);
    release = { value, bytes: envelopeBytes(value) };
  }
  const digest = xidContentDigest(release.value);
  let index = entry ? head! : null;
  if (!index) {
    const value = signXidIndex({
      publisher: xid, name, head: head?.value ?? null, releases: { ...head?.value.releases, [version]: { digest, status: 'active' } },
    }, previous ? [signer, previous] : [signer]);
    index = { value, bytes: envelopeBytes(value) };
  }

  // 4. The shim resolves the XID before it reads the index. A failed target does not stop the others.
  const results: StepResult[] = [];
  for (const t of targets) {
    try {
      await t.dir?.writeXidDocument(xid, o.document);
      await (t.dir ?? t.dwn)!.publish({ name, version, release: release.bytes, tarball: o.tarball, index: index.bytes, format: 'envelope' });
      results.push({ url: t.url, ok: true });
    } catch (e) {
      results.push({ url: t.url, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { xid, name, version, installName, release: digest, sequence: index.value.sequence, targets: results };
}
