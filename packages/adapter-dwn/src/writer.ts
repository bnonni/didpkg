// The DWN writer (ADR 0003 sections 3 and 6). Entry point `@didpkg/adapter-dwn/writer`.
// It signs each DWN message with a key of the publisher DID document, for example the release key #didpkg-1.
// The DWN message signature is not a trust input. The Data Integrity proofs inside the stored bytes are.
import * as ed from '@noble/ed25519';
import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import {
  DateSort, ProtocolsConfigure, RecordsQuery, RecordsWrite,
  type MessageSigner, type ProtocolDefinition, type RecordsFilter, type RecordsQueryReplyEntry, type RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';
import type { PublishInput, StorageWriter } from '@didpkg/core/source';
import { DIDPKG_PROTOCOL, protocolDefinition } from './protocol.ts';

const definition = protocolDefinition as ProtocolDefinition;
const te = new TextEncoder();

/** A DWN message signer for an Ed25519 private key (the 32-byte seed). `keyId` is the verification method id. */
export function ed25519MessageSigner(seed: Uint8Array, keyId: string): MessageSigner {
  return { keyId, algorithm: 'EdDSA', sign: (content: Uint8Array) => ed.signAsync(content, seed) };
}

export interface DwnWriterOptions {
  /** The DWN endpoint, for example `https://dwn.example`. */
  dwnUrl: string;
  /** The publisher DID. It is the DWN tenant. */
  did: string;
  /** Signs each message. The key must be in the DID document. Never use the did:dht update key `#0`. */
  signer: MessageSigner;
}

type Write = { protocolPath: string; type: keyof typeof protocolDefinition.types; dataFormat: string; data: Uint8Array; tags?: Record<string, string>; parentContextId?: string };

/**
 * Writes to the publisher DWN in the order of ADR 0003 section 3 rule 4: the release, the tarball, then the index.
 * The DWN keeps more than one record with one version tag, and a reader reads the newest. Thus the writer
 * itself refuses to replace a published release or tarball (a lockfile holds their integrity).
 * The same bytes again is a no-op, so a failed publish can run again.
 */
export class DwnWriter implements StorageWriter {
  readonly #client = new HttpDwnRpcClient();
  constructor(readonly options: DwnWriterOptions) {}

  /** Installs (or installs again) the protocol v1. A publish needs it. */
  async installProtocol(): Promise<void> {
    const { message } = await ProtocolsConfigure.create({ definition, signer: this.options.signer });
    await this.#send('ProtocolsConfigure', message);
  }

  async publish({ name, version, release, tarball, index }: PublishInput): Promise<void> {
    const pkg = await this.#package(name);
    const tags = { version };
    const rel = await this.#immutable(`${name}@${version} release`, { protocolPath: 'package/release', type: 'release', dataFormat: 'application/json', data: release, tags, parentContextId: pkg.contextId });
    await this.#immutable(`${name}@${version} tarball`, { protocolPath: 'package/release/tarball', type: 'tarball', dataFormat: 'application/gzip', data: tarball, tags, parentContextId: rel.contextId });
    await this.#index(name, pkg.contextId, index);
  }

  async writeIndex({ name, index }: { name: string; index: Uint8Array }): Promise<void> {
    await this.#index(name, (await this.#package(name)).contextId, index);
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
      const w = await this.#write({ protocolPath: 'package/index', type: 'index', dataFormat: 'application/json', data, parentContextId: packageContextId });
      return void (await this.#send(label, w.message, data));
    }
    const { initialWrite: _, encodedData: __, ...recordsWriteMessage } = previous;
    const w = await RecordsWrite.createFrom({ recordsWriteMessage, data, signer: this.options.signer });
    await this.#send(label, w.message, data);
  }

  async #write(o: Write) {
    const message = (await RecordsWrite.create({
      protocol: DIDPKG_PROTOCOL, protocolPath: o.protocolPath, schema: definition.types[o.type]!.schema, dataFormat: o.dataFormat,
      data: o.data, tags: o.tags, published: true, parentContextId: o.parentContextId, signer: this.options.signer,
    })).message;
    return { message, data: o.data };
  }

  /** The records of one protocol path, the oldest first. The query is signed, so it also gives unpublished records. */
  async #query(filter: Omit<RecordsFilter, 'protocol'>): Promise<RecordsQueryReplyEntry[]> {
    const { message } = await RecordsQuery.create({ filter: { protocol: DIDPKG_PROTOCOL, ...filter }, dateSort: DateSort.CreatedAscending, signer: this.options.signer });
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
