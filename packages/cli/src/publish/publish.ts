// `didpkg publish`. It loads only the release key #didpkg-1, never #0.
// 1. Checks: the tarball, the name, the version, the targets. Then the passphrase.
// 2. Before the first write: the keyless re-PUT of the stored DID packet, and the DWN protocol install.
// 3. It reads the head index and the release of the version from each target, and keeps only the copies
//    that its own key signed. If one read fails, it signs and writes nothing, because an old head gives
//    two indexes with one sequence.
// 4. It signs a release and the next index, or uses the signed copies again. Thus a failed publish can run again.
// 5. Each target gets the same bytes: the DWN first, then each folder.
import { base64urlnopad } from '@scure/base';
import type { DidDocument } from '@didpkg/core/did';
import { DEFAULT_RELAYS } from '@didpkg/core/did/dht';
import { format } from '@didpkg/core/name';
import type { StorageReader, StorageWriter, StoredFile } from '@didpkg/core/source';
import {
  checkVersion, contentDigest, ed25519Signer, parseIndex, parseRelease, proofsOf, signIndex, signRelease, sri, verifyProof,
  type DidPkgIndex, type DidPkgRelease,
} from '@didpkg/core/trust';
import { dwnAdapter } from '@didpkg/adapter-dwn';
import { DwnWriter, ed25519MessageSigner } from '@didpkg/adapter-dwn/writer';
import { DirWriter } from '@didpkg/adapter-https/dir';
import { endpoint, putPayload, type StepResult } from '../id/dht.ts';
import { decryptKey } from '../id/keyfile.ts';
import type { Identity } from '../id/store.ts';
import { readTarball } from './tarball.ts';

const READ_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 1024 * 1024;
const te = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface PublishOptions {
  identity: Identity;
  /** The exact `npm pack` bytes. */
  tarball: Uint8Array;
  /** `dwn` (each URL of the DecentralizedWebNode services of the identity) or `dir:<path>`. */
  to: readonly string[];
  /** The Pkarr relays of the re-PUT (did:dht only). */
  relays?: readonly string[];
  /** Gives the passphrase of the release key. It runs after the input checks. */
  passphrase: () => Promise<string>;
}

export interface PublishResult {
  did: string;
  name: string;
  version: string;
  installName: string;
  /** The contentDigest of the release. */
  release: string;
  sequence: number;
  relays: StepResult[];
  targets: StepResult[];
}

interface Target { url: string; reader: StorageReader; writer: StorageWriter; dwn?: DwnWriter }
interface Signed<T> { value: T; bytes: Uint8Array }

/** The DWN URLs first, then the folders, with no duplicates. */
function targetsOf(to: readonly string[], document: Identity['document']): { dwn: string[]; dirs: string[] } {
  const dwn: string[] = [];
  const dirs: string[] = [];
  for (const t of to) {
    if (t === 'dwn') {
      const urls = (document.service ?? []).filter((s) => s.type === 'DecentralizedWebNode').flatMap((s) => s.serviceEndpoint);
      if (urls.length === 0) throw new Error('--to dwn: the identity has no DecentralizedWebNode service');
      for (const u of urls) if (typeof u === 'string') dwn.push(endpoint(u, 'dwn'));
    } else if (t.startsWith('dir:') && t.length > 4) {
      dirs.push(t.slice(4));
    } else {
      throw new Error(`--to ${JSON.stringify(t)}: use "dwn" or "dir:<path>"`);
    }
  }
  return { dwn: [...new Set(dwn)], dirs: [...new Set(dirs)] };
}

export async function publish(o: PublishOptions): Promise<PublishResult> {
  const { did, document, releaseKey } = o.identity;
  const keyId = releaseKey.keyId;
  if (keyId === `${did}#0`) throw new Error('the release key must not be the update key #0');
  if (!document.assertionMethod?.some((m) => (typeof m === 'string' ? m : m.id) === keyId)) {
    throw new Error(`${keyId} is not in the assertionMethod of the identity document`);
  }
  const { name, version, npm } = readTarball(o.tarball);
  checkVersion(version);
  const installName = format(did, name);
  const { dwn, dirs } = targetsOf(o.to, document);
  const relays = did.startsWith('did:dht:') ? (o.relays ?? DEFAULT_RELAYS).map((r) => endpoint(r, 'relay')) : [];

  const seed = await decryptKey(releaseKey, await o.passphrase());
  const signer = ed25519Signer(seed, keyId);
  const messageSigner = ed25519MessageSigner(seed, keyId);
  const adapter = dwnAdapter({ allowLoopback: true });
  const targets: Target[] = [
    ...dwn.map((url) => {
      const writer = new DwnWriter({ dwnUrl: url, did, signer: messageSigner });
      const reader = adapter.reader({ did, serviceId: `${did}#dwn`, type: 'DecentralizedWebNode', url }, { fetch });
      return { url, reader, writer, dwn: writer };
    }),
    ...dirs.map((dir) => {
      const writer = new DirWriter(dir);
      return { url: `dir:${dir}`, reader: writer, writer };
    }),
  ];

  // 2. A DWN resolves the DID before it accepts a write, and a did:dht record lives about 2 hours.
  const relayResults = relays.length ? await putPayload(relays, did, base64urlnopad.decode(o.identity.relayPayload!)) : [];
  for (const t of targets) await t.dwn?.installProtocol();

  // 3. The signed copies of this key on the targets.
  const doc = document as unknown as DidDocument;
  const own = async <T extends DidPkgIndex | DidPkgRelease>(bytes: Uint8Array, parse: (v: unknown) => T): Promise<Signed<T> | null> => {
    let value: T;
    try {
      value = parse(JSON.parse(utf8.decode(bytes)));
    } catch {
      return null;
    }
    if (value.publisher !== did || value.name !== name) return null;
    for (const proof of proofsOf(value)) {
      if (proof.verificationMethod === `${did}#0`) continue;
      if (await verifyProof({ ...value, proof }, doc).then(() => true, () => false)) return { value, bytes };
    }
    return null;
  };
  const read = async <T extends DidPkgIndex | DidPkgRelease>(file: StoredFile, parse: (v: unknown) => T) => {
    const found: Signed<T>[] = [];
    for (const t of targets) {
      for await (const bytes of t.reader.read(file, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), maxBytes: MAX_JSON_BYTES })) {
        const copy = await own(bytes, parse);
        if (copy) found.push(copy);
      }
    }
    return found;
  };
  const head = (await read({ kind: 'index', name }, parseIndex)).reduce<Signed<DidPkgIndex> | null>(
    (best, c) => (!best || c.value.sequence > best.value.sequence ? c : best), null);
  const releases = new Map<string, Signed<DidPkgRelease>>();
  for (const c of await read({ kind: 'release', name, version }, parseRelease)) {
    if (c.value.version === version) releases.set(contentDigest(c.value), c);
  }

  // 4. A published version does not change. The same tarball again uses the signed copies.
  if (releases.size > 1) throw new Error(`${name}@${version}: the targets hold ${releases.size} different signed releases`);
  let [release] = releases.values();
  if (release && release.value.dist.integrity !== (await sri('sha512', o.tarball))) {
    throw new Error(`${name}@${version} is published with a different tarball`);
  }
  const entry = head && Object.hasOwn(head.value.releases, version) ? head.value.releases[version] : undefined;
  if (entry && (!release || entry.digest !== contentDigest(release.value))) {
    throw new Error(`${name}@${version} is in the signed index with a different release`);
  }
  if (!release) {
    const value = await signRelease({ publisher: did, name, version, tarball: o.tarball, npm, head: head?.value ?? null }, [signer]);
    release = { value, bytes: te.encode(JSON.stringify(value)) };
  }
  const digest = contentDigest(release.value);
  let index = entry ? head! : null;
  if (!index) {
    const value = await signIndex({
      publisher: did, name, head: head?.value ?? null, releases: { ...head?.value.releases, [version]: { digest, status: 'active' } },
    }, [signer]);
    index = { value, bytes: te.encode(JSON.stringify(value)) };
  }

  // 5. One serialization of each object for all targets. A failed target does not stop the others.
  const results: StepResult[] = [];
  for (const t of targets) {
    try {
      await t.writer.publish({ name, version, release: release.bytes, tarball: o.tarball, index: index.bytes });
      results.push({ url: t.url, ok: true });
    } catch (e) {
      results.push({ url: t.url, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { did, name, version, installName, release: digest, sequence: index.value.sequence, relays: relayResults, targets: results };
}
