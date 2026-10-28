// Test doubles for the release verifier (a port of the spike research/phase3/did-trust-model/src/sim.ts).
// MemReader is an untrusted storage host that a test can make hostile. FakeResolver gives only the
// current DID document, as did:web and did:dht do.
import * as ed from '@noble/ed25519';
import type { DidDocument, DidResolutionResult } from '../../src/did/types.ts';
import {
  contentDigest, ed25519Signer, signIndex, signRelease, toMultikey,
  type DidPkgIndex, type DidPkgRelease, type ReleaseReader, type ReleaseStatus, type Signer,
} from '../../src/trust/index.ts';

export const NAME = 'hello';
export const T0 = '2026-10-23T10:00:00Z';
export const tgz = (label: string) => new TextEncoder().encode(`fake-tgz:${label}`);

export class MemReader implements ReleaseReader {
  /** The head index per `<did>/<name>`. */
  indexes = new Map<string, DidPkgIndex>();
  /** Each index, the oldest first. */
  history: DidPkgIndex[] = [];
  releases = new Map<string, DidPkgRelease>();
  tarballs = new Map<string, Uint8Array>();

  /** The head index, or null. A test helper: the verifier reads `getIndexes`. */
  async getIndex(did: string, name: string) {
    return structuredClone(this.indexes.get(`${did}/${name}`) ?? null);
  }
  async getIndexes(did: string, name: string) {
    const head = await this.getIndex(did, name);
    return head ? [head] : [];
  }
  async getRelease(did: string, name: string, version: string) {
    return structuredClone(this.releases.get(`${did}/${name}@${version}`) ?? null);
  }
  async getTarball(did: string, name: string, version: string) {
    return this.tarballs.get(`${did}/${name}@${version}`) ?? null;
  }
  putIndex(index: DidPkgIndex) {
    this.indexes.set(`${index.publisher}/${index.name}`, index);
    this.history.push(index);
  }
  /** A copy with the same contents. A test changes the copy to make a hostile host. */
  clone(): MemReader {
    const copy = new MemReader();
    copy.indexes = new Map(this.indexes);
    copy.history = [...this.history];
    copy.releases = new Map(this.releases);
    copy.tarballs = new Map(this.tarballs);
    return copy;
  }
}

export class FakeResolver {
  docs = new Map<string, { doc: DidDocument; deactivated?: boolean }>();

  async resolve(did: string): Promise<DidResolutionResult> {
    const entry = this.docs.get(did);
    if (!entry) {
      return { didDocument: null, didDocumentMetadata: {}, didResolutionMetadata: { error: { type: 'https://www.w3.org/ns/did#NOT_FOUND' } } };
    }
    return { didDocument: entry.doc, didDocumentMetadata: entry.deactivated ? { deactivated: true } : {}, didResolutionMetadata: {} };
  }
  set(did: string, keys: Key[], deactivated = false) {
    this.docs.set(did, { doc: didDoc(did, keys), deactivated });
  }
}

export interface Key {
  vm: string;
  multikey: string;
  signer: Signer;
}

export async function newKey(did: string, fragment: string): Promise<Key> {
  const { secretKey, publicKey } = await ed.keygenAsync();
  const vm = `${did}#${fragment}`;
  return { vm, multikey: toMultikey({ alg: 'Ed25519', bytes: publicKey }), signer: ed25519Signer(secretKey, vm) };
}

export function didDoc(did: string, keys: Key[]): DidDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: keys.map((k) => ({ id: k.vm, type: 'Multikey', controller: did, publicKeyMultibase: k.multikey })),
    assertionMethod: keys.map((k) => k.vm),
  };
}

type StatusChange = Record<string, { status: ReleaseStatus; message?: string }>;

/** The publisher side (core signRelease and signIndex): sign a manifest, then a new index head. */
export async function publish(reader: MemReader, o: {
  did: string; version: string; tarball: Uint8Array; signers: Signer[]; indexSigners?: Signer[]; created?: string;
  npm?: Record<string, unknown>;
}): Promise<DidPkgIndex> {
  const prev = await reader.getIndex(o.did, NAME);
  const release = await signRelease({
    publisher: o.did, name: NAME, version: o.version, tarball: o.tarball, head: prev, published: o.created ?? T0,
    npm: o.npm ?? { dependencies: {}, hasInstallScript: false },
  }, o.signers);
  reader.releases.set(`${o.did}/${NAME}@${o.version}`, release);
  reader.tarballs.set(`${o.did}/${NAME}@${o.version}`, o.tarball);
  const releases = { ...prev?.releases, [o.version]: { digest: contentDigest(release), status: 'active' as const } };
  return reindex(reader, { did: o.did, releases, signers: o.indexSigners ?? o.signers, created: o.created });
}

/** A new signed index head. `sequence` overrides the next sequence (for an equivocation test). `distTags` overrides all tags. */
export async function reindex(reader: MemReader, o: {
  did: string; signers: Signer[]; created?: string; sequence?: number; releases?: DidPkgIndex['releases']; status?: StatusChange;
  distTags?: Record<string, string>;
}): Promise<DidPkgIndex> {
  const prev = await reader.getIndex(o.did, NAME);
  const releases = structuredClone(o.releases ?? prev?.releases ?? {});
  for (const [version, change] of Object.entries(o.status ?? {})) Object.assign(releases[version]!, change);
  const index = await signIndex({
    publisher: o.did, name: NAME, head: prev, releases, distTags: o.distTags, sequence: o.sequence, updated: o.created ?? T0,
  }, o.signers);
  reader.putIndex(index);
  return index;
}
