// The storage contract (ADR 0003). Adapters move bytes. Adapters never decide trust.
// PackageSource selects copies only by the digests in signed objects, and trust/ verifies them.
// Only adapter packages import a storage SDK (Enbox, S3, OCI). Core imports none.

export type EndpointType = 'DecentralizedWebNode' | 'DIDPackageRepository';

/** One storage endpoint from the DID document of the publisher. */
export interface Endpoint {
  /** The publisher DID, or the XID in hex. For the DWN of a XID publisher: the DWN tenant (a did:key). */
  did: string;
  /** The absolute DID URL of the service. For a XID publisher: the service URI. */
  serviceId: string;
  type: EndpointType;
  url: string;
}

/** The form of a signed record: JSON for a DID publisher, a Gordian Envelope for a XID publisher. */
export type RecordFormat = 'json' | 'envelope';

/**
 * One file of a package. Each adapter maps it to its layout (static layout v1, DWN protocol paths). `format` is the
 * form of the signed records of the publisher (default: json). A DWN keeps each form in its own protocol, also the tarball.
 */
export type StoredFile =
  | { kind: 'index'; name: string; format?: RecordFormat }
  | { kind: 'release'; name: string; version: string; format?: RecordFormat }
  | { kind: 'tarball'; name: string; version: string; format?: RecordFormat };

export interface ReadOptions {
  signal: AbortSignal;
  /** The reader must stop and throw if one copy is larger. */
  maxBytes: number;
}

/** One stored copy, and the plain HTTPS URL that gives these bytes to an anonymous GET. */
export interface StoredCopy {
  bytes: Uint8Array;
  /** For a DWN: a DRL. For a static mirror: the layout URL. */
  url: string;
}

/** The read side of one endpoint. Anonymous: no keys and no credentials. */
export interface StorageReader {
  /**
   * Yields each stored copy of the file, as the exact stored bytes. A static mirror has 0 or 1 copies.
   * A DWN can have more, because package names are not unique in a DWN. If the file is absent, yield
   * nothing. If the endpoint fails (network, HTTP status, size limit), throw.
   */
  read(file: StoredFile, options: ReadOptions): AsyncIterable<Uint8Array>;
  /** Optional. The same copies as `read`, in the same order, each with its URL. */
  copies?(file: StoredFile, options: ReadOptions): AsyncIterable<StoredCopy>;
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
  /** The form of the release and the index. Default: json. */
  format?: RecordFormat;
}

/** The write side. Credentials stay in the adapter. Every writer stores the same bytes. */
export interface StorageWriter {
  /** Writes the release and the tarball, then the index. The index write is the commit point. */
  publish(input: PublishInput): Promise<void>;
  /** Writes a new index only, for a status change or a dist-tag change. */
  writeIndex(input: { name: string; index: Uint8Array; format?: RecordFormat }): Promise<void>;
}
