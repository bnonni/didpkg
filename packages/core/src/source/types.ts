// The storage contract (ADR 0003). Adapters move bytes. Adapters never decide trust.
// PackageSource selects copies only by the digests in signed objects, and trust/ verifies them.
// Only adapter packages import a storage SDK (Enbox, S3, OCI). Core imports none.

export type EndpointType = 'DecentralizedWebNode' | 'DIDPackageRepository';

/** One storage endpoint from the DID document of the publisher. */
export interface Endpoint {
  did: string;
  /** The absolute DID URL of the service. */
  serviceId: string;
  type: EndpointType;
  url: string;
}

/** One file of a package. Each adapter maps it to its layout (static layout v1, DWN protocol paths). */
export type StoredFile =
  | { kind: 'index'; name: string }
  | { kind: 'release'; name: string; version: string }
  | { kind: 'tarball'; name: string; version: string };

export interface ReadOptions {
  signal: AbortSignal;
  /** The reader must stop and throw if one copy is larger. */
  maxBytes: number;
}

/** The read side of one endpoint. Anonymous: no keys and no credentials. */
export interface StorageReader {
  /**
   * Yields each stored copy of the file, as the exact stored bytes. A static mirror has 0 or 1 copies.
   * A DWN can have more, because package names are not unique in a DWN. If the file is absent, yield
   * nothing. If the endpoint fails (network, HTTP status, size limit), throw.
   */
  read(file: StoredFile, options: ReadOptions): AsyncIterable<Uint8Array>;
}

export interface StorageAdapter {
  readonly kind: string;
  /** True if this adapter reads this endpoint (the service type and the URL scheme). */
  canRead(endpoint: Endpoint): boolean;
  reader(endpoint: Endpoint, deps: { fetch: typeof fetch }): StorageReader;
}

export interface PublishInput {
  name: string;
  version: string;
  /** The exact bytes of the signed DidPkgRelease. */
  release: Uint8Array;
  /** The exact `npm pack` bytes, with no wrapper. */
  tarball: Uint8Array;
  /** The exact bytes of the signed DidPkgIndex that lists the release. */
  index: Uint8Array;
}

/** The write side. Credentials stay in the adapter. Every writer stores the same bytes. */
export interface StorageWriter {
  /** Writes the release and the tarball, then the index. The index write is the commit point. */
  publish(input: PublishInput): Promise<void>;
  /** Writes a new index only, for a status change or a dist-tag change. */
  writeIndex(input: { name: string; index: Uint8Array }): Promise<void>;
}
