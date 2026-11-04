// The DWN writer (ADR 0003 sections 3, 6 and 9). Entry point `@didpkg/adapter-dwn/writer`.
// It signs each DWN message with a key of the publisher DID document, for example the release key #didpkg-1.
// For a XID publisher, it signs with the DWN key of the XID document, and the tenant is the did:key of that key.
// The DWN message signature is not a trust input. The Data Integrity proofs inside the stored bytes are.
import * as ed from '@noble/ed25519';
import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import {
  DateSort, ProtocolsConfigure, RecordsQuery, RecordsWrite,
  type MessageSigner, type ProtocolDefinition, type RecordsFilter, type RecordsQueryReplyEntry, type RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';
import type { PublishInput, RecordFormat, StorageWriter } from '@didpkg/core/source';
import { ENVELOPE_DATA_FORMAT, definitionOf, protocolOf } from './protocol.ts';

const te = new TextEncoder();

/** A DWN message signer for an Ed25519 private key (the 32-byte seed). `keyId` is the verification method id. */
export function ed25519MessageSigner(seed: Uint8Array, keyId: string): MessageSigner {
  return { keyId, algorithm: 'EdDSA', sign: (content: Uint8Array) => ed.signAsync(content, seed) };
}

export interface DwnWriterOptions {
  /** The DWN endpoint, for example `https://dwn.example`. */
  dwnUrl: string;
  /** The DWN tenant: the publisher DID, or the did:key of the DWN key of a XID publisher. */
  did: string;
  /** Signs each message. The key must be in the DID document. Never use the did:dht update key `#0`. */
  signer: MessageSigner;
  /** The form of the signed records. `envelope` (a XID publisher) uses the protocol v2. Default: json (v1). */
  format?: RecordFormat;
}

type Write = { protocolPath: string; type: 'package' | 'index' | 'release' | 'tarball'; dataFormat: string; data: Uint8Array; tags?: Record<string, string>; parentContextId?: string };

/**
 * Writes to the publisher DWN in the order of ADR 0003 section 3 rule 4: the release, the tarball, then the index.
 * The DWN keeps more than one record with one version tag, and a reader reads the newest. Thus the writer
 * itself refuses to replace a published release or tarball (a lockfile holds their integrity).
 * The same bytes again is a no-op, so a failed publish can run again.
 */
export class DwnWriter implements StorageWriter {
  readonly #client = new HttpDwnRpcClient();
  readonly #format: RecordFormat;
  readonly #protocol: string;
  readonly #definition: ProtocolDefinition;
  /** The data format of the index and the release. */
  readonly #dataFormat: string;

  constructor(readonly options: DwnWriterOptions) {
    this.#format = options.format ?? 'json';
    this.#protocol = protocolOf(this.#format);
    this.#definition = definitionOf(this.#format) as ProtocolDefinition;
    this.#dataFormat = this.#format === 'envelope' ? ENVELOPE_DATA_FORMAT : 'application/json';
  }

  /** Installs (or installs again) the protocol of the record form: v1, or v2 for `envelope`. A publish needs it. */
  async installProtocol(): Promise<void> {
    const { message } = await ProtocolsConfigure.create({ definition: this.#definition, signer: this.options.signer });
    await this.#send('ProtocolsConfigure', message);
  }

  async publish({ name, version, release, tarball, index, format }: PublishInput): Promise<void> {
    this.#check(format);
    const pkg = await this.#package(name);
    const tags = { version };
    const rel = await this.#immutable(`${name}@${version} release`, { protocolPath: 'package/release', type: 'release', dataFormat: this.#dataFormat, data: release, tags, parentContextId: pkg.contextId });
    await this.#immutable(`${name}@${version} tarball`, { protocolPath: 'package/release/tarball', type: 'tarball', dataFormat: 'application/gzip', data: tarball, tags, parentContextId: rel.contextId });
    await this.#index(name, pkg.contextId, index);
  }

  async writeIndex({ name, index, format }: { name: string; index: Uint8Array; format?: RecordFormat }): Promise<void> {
    this.#check(format);
    await this.#index(name, (await this.#package(name)).contextId, index);
  }

  /** A protocol holds one record form, so a writer writes one form. */
  #check(format: RecordFormat = 'json'): void {
    if (format !== this.#format) throw new Error(`this DWN writer writes ${this.#format} records, not ${format}`);
  }

  /** The `package` record of a name. It holds no trust input: only the tag `name` matters, for the reader query. */
  async #package(name: string): Promise<RecordsWriteMessage> {
    // Two package records with one name are possible after a race. The writer uses the oldest, so all writes go to one context.
    const [oldest] = await this.#query({ protocolPath: 'package', tags: { name } });
    if (oldest) return oldest;
    const w = await this.#write({ protocolPath: 'package', type: 'package', dataFormat: 'application/json', data: te.encode(JSON.stringify({ name })), tags: { name } });
    await this.#send(`${name} package`, w.message, w.data);
    return w.message;
  }

  /** A release or a tarball: written one time. */
  async #immutable(label: string, o: Write): Promise<RecordsWriteMessage> {
    const existing = await this.#query({ protocolPath: o.protocolPath, contextId: o.parentContextId, tags: o.tags });
    const w = await this.#write(o);
    if (existing.length === 0) {
      await this.#send(label, w.message, w.data);
      return w.message;
    }
    if (existing.some((e) => e.descriptor.dataCid !== w.message.descriptor.dataCid)) throw new Error(`${label}: a different file exists`);
    return existing[0]!;
  }

  /** The index is the commit point: one record per package, updated in place (the same recordId). */
  async #index(name: string, packageContextId: string, data: Uint8Array): Promise<void> {
    const label = `${name} index`;
    // After a race, the newest index record is the one that a reader reads. Update that one.
    const previous = (await this.#query({ protocolPath: 'package/index', contextId: packageContextId })).at(-1);
    if (!previous) {
      const w = await this.#write({ protocolPath: 'package/index', type: 'index', dataFormat: this.#dataFormat, data, parentContextId: packageContextId });
      return void (await this.#send(label, w.message, data));
    }
    const { initialWrite: _, encodedData: __, ...recordsWriteMessage } = previous;
    const w = await RecordsWrite.createFrom({ recordsWriteMessage, data, signer: this.options.signer });
    await this.#send(label, w.message, data);
  }

  async #write(o: Write) {
    const message = (await RecordsWrite.create({
      protocol: this.#protocol, protocolPath: o.protocolPath, schema: this.#definition.types[o.type]!.schema, dataFormat: o.dataFormat,
      data: o.data, tags: o.tags, published: true, parentContextId: o.parentContextId, signer: this.options.signer,
    })).message;
    return { message, data: o.data };
  }

  /** The records of one protocol path, the oldest first. The query is signed, so it also gives unpublished records. */
  async #query(filter: Omit<RecordsFilter, 'protocol'>): Promise<RecordsQueryReplyEntry[]> {
    const { message } = await RecordsQuery.create({ filter: { protocol: this.#protocol, ...filter }, dateSort: DateSort.CreatedAscending, signer: this.options.signer });
    const reply = await this.#send(`query ${filter.protocolPath}`, message);
    return (reply as { entries?: RecordsQueryReplyEntry[] }).entries ?? [];
  }

  async #send(label: string, message: unknown, data?: Uint8Array) {
    const reply = await this.#client.sendDwnRequest({ dwnUrl: this.options.dwnUrl, targetDid: this.options.did, message, data });
    const { code, detail } = reply.status;
    if (code < 200 || code > 299) throw new Error(`${label}: DWN ${code} ${detail}`);
    return reply;
  }
}
